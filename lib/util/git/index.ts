import URL from 'url';
import is from '@sindresorhus/is';
import delay from 'delay';
import fs from 'fs-extra';
import simpleGit, {
  Options,
  ResetMode,
  SimpleGit,
  TaskOptions,
} from 'simple-git';
import upath from 'upath';
import { configFileNames } from '../../config/app-strings';
import { GlobalConfig } from '../../config/global';
import type { RenovateConfig } from '../../config/types';
import {
  CONFIG_VALIDATION,
  INVALID_PATH,
  REPOSITORY_CHANGED,
  REPOSITORY_DISABLED,
  REPOSITORY_EMPTY,
  SYSTEM_INSUFFICIENT_DISK_SPACE,
  TEMPORARY_ERROR,
} from '../../constants/error-messages';
import { logger } from '../../logger';
import { api as semverCoerced } from '../../modules/versioning/semver-coerced';
import { ExternalHostError } from '../../types/errors/external-host-error';
import type { GitProtocol } from '../../types/git';
import { Limit, incLimitedValue } from '../../workers/global/limits';
import { newlineRegex, regEx } from '../regex';
import { parseGitAuthor } from './author';
import { getNoVerify, simpleGitConfig } from './config';
import {
  getCachedConflictResult,
  setCachedConflictResult,
} from './conflicts-cache';
import { checkForPlatformFailure, handleCommitError } from './error';
import {
  getCachedModifiedResult,
  setCachedModifiedResult,
} from './modified-cache';
import { configSigningKey, writePrivateKey } from './private-key';
import type {
  CommitFilesConfig,
  CommitResult,
  CommitSha,
  LocalConfig,
  StatusResult,
  StorageConfig,
  TreeItem,
} from './types';

export { setNoVerify } from './config';
export { setPrivateKey } from './private-key';

// Retry parameters
const retryCount = 5;
const delaySeconds = 3;
const delayFactor = 2;

// A generic wrapper for simpleGit.* calls to make them more fault-tolerant
export async function gitRetry<T>(gitFunc: () => Promise<T>): Promise<T> {
  let round = 0;
  let lastError: Error | undefined;

  while (round <= retryCount) {
    if (round > 0) {
      logger.debug(`gitRetry round ${round}`);
    }
    try {
      const res = await gitFunc();
      if (round > 1) {
        logger.debug('Successful retry of git function');
      }
      return res;
    } catch (err) {
      lastError = err;
      logger.debug({ err }, `Git function thrown`);
      // Try to transform the Error to ExternalHostError
      const errChecked = checkForPlatformFailure(err);
      if (errChecked instanceof ExternalHostError) {
        logger.debug(
          { err: errChecked },
          `ExternalHostError thrown in round ${
            round + 1
          } of ${retryCount} - retrying in the next round`
        );
      } else {
        throw err;
      }
    }

    const nextDelay = delayFactor ^ ((round - 1) * delaySeconds);
    logger.trace({ nextDelay }, `Delay next round`);
    await delay(1000 * nextDelay);

    round++;
  }

  throw lastError;
}

function localName(branchName: string): string {
  return branchName.replace(regEx(/^origin\//), '');
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch (err) {
    return false;
  }
}

async function getDefaultBranch(git: SimpleGit): Promise<string> {
  // see https://stackoverflow.com/a/62352647/3005034
  try {
    let res = await git.raw(['rev-parse', '--abbrev-ref', 'origin/HEAD']);
    // istanbul ignore if
    if (!res) {
      logger.debug('Could not determine default branch using git rev-parse');
      const headPrefix = 'HEAD branch: ';
      res = (await git.raw(['remote', 'show', 'origin']))
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith(headPrefix))!
        .replace(headPrefix, '');
    }
    return res.replace('origin/', '').trim();
  } catch (err) /* istanbul ignore next */ {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    if (
      err.message.startsWith(
        'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref'
      )
    ) {
      throw new Error(REPOSITORY_EMPTY);
    }
    // istanbul ignore if
    if (err.message.includes("fatal: ambiguous argument 'origin/HEAD'")) {
      logger.warn({ err }, 'Error getting default branch');
      throw new Error(TEMPORARY_ERROR);
    }
    throw err;
  }
}

let config: LocalConfig = {} as any;

// TODO: can be undefined
let git: SimpleGit;
let gitInitialized: boolean;

let privateKeySet = false;

export const GIT_MINIMUM_VERSION = '2.33.0'; // git show-current

export async function validateGitVersion(): Promise<boolean> {
  let version: string | undefined;
  const globalGit = simpleGit();
  try {
    const raw = await globalGit.raw(['--version']);
    for (const section of raw.split(/\s+/)) {
      if (semverCoerced.isVersion(section)) {
        version = section;
        break;
      }
    }
  } catch (err) /* istanbul ignore next */ {
    logger.error({ err }, 'Error fetching git version');
    return false;
  }
  // istanbul ignore if
  if (
    !(
      version &&
      (semverCoerced.equals(version, GIT_MINIMUM_VERSION) ||
        semverCoerced.isGreaterThan(version, GIT_MINIMUM_VERSION))
    )
  ) {
    logger.error(
      { detectedVersion: version, minimumVersion: GIT_MINIMUM_VERSION },
      'Git version needs upgrading'
    );
    return false;
  }
  logger.debug(`Found valid git version: ${version}`);
  return true;
}

async function fetchBranchCommits(): Promise<void> {
  config.branchCommits = {};
  const opts = ['ls-remote', '--heads', config.url];
  if (config.extraCloneOpts) {
    Object.entries(config.extraCloneOpts).forEach((e) =>
      opts.unshift(e[0], `${e[1]}`)
    );
  }
  try {
    (await gitRetry(() => git.raw(opts)))
      .split(newlineRegex)
      .filter(Boolean)
      .map((line) => line.trim().split(regEx(/\s+/)))
      .forEach(([sha, ref]) => {
        config.branchCommits[ref.replace('refs/heads/', '')] = sha;
      });
  } catch (err) /* istanbul ignore next */ {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    logger.debug({ err }, 'git error');
    if (err.message?.includes('Please ask the owner to check their account')) {
      throw new Error(REPOSITORY_DISABLED);
    }
    throw err;
  }
}

export async function initRepo(args: StorageConfig): Promise<void> {
  config = { ...args } as any;
  config.ignoredAuthors = [];
  config.additionalBranches = [];
  config.branchIsModified = {};
  const { localDir } = GlobalConfig.get();
  git = simpleGit(localDir, simpleGitConfig());
  gitInitialized = false;
  await fetchBranchCommits();
}

async function resetToBranch(branchName: string): Promise<void> {
  logger.debug(`resetToBranch(${branchName})`);
  await git.raw(['reset', '--hard']);
  await gitRetry(() => git.checkout(branchName));
  await git.raw(['reset', '--hard', 'origin/' + branchName]);
  await git.raw(['clean', '-fd']);
}

// istanbul ignore next
export async function resetToCommit(commit: string): Promise<void> {
  logger.debug(`resetToCommit(${commit})`);
  await git.raw(['reset', '--hard', commit]);
}

async function deleteLocalBranch(branchName: string): Promise<void> {
  await git.branch(['-D', branchName]);
}

async function cleanLocalBranches(): Promise<void> {
  const existingBranches = (await git.raw(['branch']))
    .split(newlineRegex)
    .map((branch) => branch.trim())
    .filter((branch) => branch.length)
    .filter((branch) => !branch.startsWith('* '));
  logger.debug({ existingBranches });
  for (const branchName of existingBranches) {
    await deleteLocalBranch(branchName);
  }
}

export function setGitAuthor(gitAuthor: string | undefined): void {
  const gitAuthorParsed = parseGitAuthor(
    gitAuthor ?? 'Renovate Bot <renovate@whitesourcesoftware.com>'
  );
  if (!gitAuthorParsed) {
    const error = new Error(CONFIG_VALIDATION);
    error.validationSource = 'None';
    error.validationError = 'Invalid gitAuthor';
    error.validationMessage = `gitAuthor is not parsed as valid RFC5322 format: ${gitAuthor}`;
    throw error;
  }
  config.gitAuthorName = gitAuthorParsed.name;
  config.gitAuthorEmail = gitAuthorParsed.address;
}

export async function writeGitAuthor(): Promise<void> {
  const { gitAuthorName, gitAuthorEmail, writeGitDone } = config;
  // istanbul ignore if
  if (writeGitDone) {
    return;
  }
  config.writeGitDone = true;
  try {
    if (gitAuthorName) {
      logger.debug({ gitAuthorName }, 'Setting git author name');
      await git.addConfig('user.name', gitAuthorName);
    }
    if (gitAuthorEmail) {
      logger.debug({ gitAuthorEmail }, 'Setting git author email');
      await git.addConfig('user.email', gitAuthorEmail);
    }
  } catch (err) /* istanbul ignore next */ {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    logger.debug(
      { err, gitAuthorName, gitAuthorEmail },
      'Error setting git author config'
    );
    throw new Error(TEMPORARY_ERROR);
  }
}

export function setUserRepoConfig({
  gitIgnoredAuthors,
  gitAuthor,
}: RenovateConfig): void {
  config.ignoredAuthors = gitIgnoredAuthors ?? [];
  setGitAuthor(gitAuthor);
}

export async function getSubmodules(): Promise<string[]> {
  try {
    return (
      (await git.raw([
        'config',
        '--file',
        '.gitmodules',
        '--get-regexp',
        '\\.path',
      ])) || ''
    )
      .trim()
      .split(regEx(/[\n\s]/))
      .filter((_e: string, i: number) => i % 2);
  } catch (err) /* istanbul ignore next */ {
    logger.warn({ err }, 'Error getting submodules');
    return [];
  }
}

export async function syncGit(): Promise<void> {
  if (gitInitialized) {
    return;
  }
  gitInitialized = true;
  const localDir = GlobalConfig.get('localDir')!;
  logger.debug(`Initializing git repository into ${localDir}`);
  const gitHead = upath.join(localDir, '.git/HEAD');
  let clone = true;

  if (await fs.pathExists(gitHead)) {
    try {
      await git.raw(['remote', 'set-url', 'origin', config.url]);
      await resetToBranch(await getDefaultBranch(git));
      const fetchStart = Date.now();
      await gitRetry(() => git.pull());
      await gitRetry(() => git.fetch());
      config.currentBranch =
        config.currentBranch || (await getDefaultBranch(git));
      await resetToBranch(config.currentBranch);
      await cleanLocalBranches();
      await gitRetry(() => git.raw(['remote', 'prune', 'origin']));
      const durationMs = Math.round(Date.now() - fetchStart);
      logger.info({ durationMs }, 'git fetch completed');
      clone = false;
    } catch (err) /* istanbul ignore next */ {
      if (err.message === REPOSITORY_EMPTY) {
        throw err;
      }
      logger.info({ err }, 'git fetch error');
    }
  }
  if (clone) {
    const cloneStart = Date.now();
    try {
      const opts: string[] = [];
      if (config.fullClone) {
        logger.debug('Performing full clone');
      } else {
        logger.debug('Performing blobless clone');
        opts.push('--filter=blob:none');
      }
      if (config.extraCloneOpts) {
        Object.entries(config.extraCloneOpts).forEach((e) =>
          opts.push(e[0], `${e[1]}`)
        );
      }
      const emptyDirAndClone = async (): Promise<void> => {
        await fs.emptyDir(localDir);
        await git.clone(config.url, '.', opts);
      };
      await gitRetry(() => emptyDirAndClone());
    } catch (err) /* istanbul ignore next */ {
      logger.debug({ err }, 'git clone error');
      if (err.message?.includes('No space left on device')) {
        throw new Error(SYSTEM_INSUFFICIENT_DISK_SPACE);
      }
      if (err.message === REPOSITORY_EMPTY) {
        throw err;
      }
      throw new ExternalHostError(err, 'git');
    }
    const durationMs = Math.round(Date.now() - cloneStart);
    logger.debug({ durationMs }, 'git clone completed');
  }
  config.currentBranchSha = (await git.raw(['rev-parse', 'HEAD'])).trim();
  if (config.cloneSubmodules) {
    const submodules = await getSubmodules();
    for (const submodule of submodules) {
      try {
        logger.debug(`Cloning git submodule at ${submodule}`);
        await gitRetry(() => git.submoduleUpdate(['--init', submodule]));
      } catch (err) {
        logger.warn(
          { err },
          `Unable to initialise git submodule at ${submodule}`
        );
      }
    }
  }
  try {
    const latestCommit = (await git.log({ n: 1 })).latest;
    logger.debug({ latestCommit }, 'latest repository commit');
  } catch (err) /* istanbul ignore next */ {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    if (err.message.includes('does not have any commits yet')) {
      throw new Error(REPOSITORY_EMPTY);
    }
    logger.warn({ err }, 'Cannot retrieve latest commit');
  }
  config.currentBranch = config.currentBranch || (await getDefaultBranch(git));
}

// istanbul ignore next
export async function getRepoStatus(path?: string): Promise<StatusResult> {
  if (is.string(path)) {
    const { localDir } = GlobalConfig.get();
    const localPath = upath.resolve(localDir, path);
    if (!localPath.startsWith(upath.resolve(localDir))) {
      logger.warn(
        { localPath, localDir },
        'Preventing access to file outside the local directory'
      );
      throw new Error(INVALID_PATH);
    }
  }

  await syncGit();
  return git.status(path ? [path] : []);
}

export function branchExists(branchName: string): boolean {
  return !!config.branchCommits[branchName];
}

// Return the commit SHA for a branch
export function getBranchCommit(branchName: string): CommitSha | null {
  return config.branchCommits[branchName] || null;
}

// Return the parent commit SHA for a branch
export async function getBranchParentSha(
  branchName: string
): Promise<CommitSha | null> {
  try {
    const branchSha = getBranchCommit(branchName);
    const parentSha = await git.revparse([`${branchSha}^`]);
    return parentSha;
  } catch (err) {
    logger.debug({ err }, 'Error getting branch parent sha');
    return null;
  }
}

export async function getCommitMessages(): Promise<string[]> {
  await syncGit();
  logger.debug('getCommitMessages');
  const res = await git.log({
    n: 10,
    format: { message: '%s' },
  });
  return res.all.map((commit) => commit.message);
}

export async function checkoutBranch(branchName: string): Promise<CommitSha> {
  logger.debug(`Setting current branch to ${branchName}`);
  await syncGit();
  try {
    config.currentBranch = branchName;
    config.currentBranchSha = (
      await git.raw(['rev-parse', 'origin/' + branchName])
    ).trim();
    await gitRetry(() => git.checkout(['-f', branchName, '--']));
    const latestCommitDate = (await git.log({ n: 1 }))?.latest?.date;
    if (latestCommitDate) {
      logger.debug({ branchName, latestCommitDate }, 'latest commit');
    }
    await git.reset(ResetMode.HARD);
    return config.currentBranchSha;
  } catch (err) /* istanbul ignore next */ {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    if (err.message?.includes('fatal: ambiguous argument')) {
      logger.warn({ err }, 'Failed to checkout branch');
      throw new Error(TEMPORARY_ERROR);
    }
    throw err;
  }
}

export async function getFileList(): Promise<string[]> {
  await syncGit();
  const branch = config.currentBranch;
  const submodules = await getSubmodules();
  let files: string;
  try {
    files = await git.raw(['ls-tree', '-r', branch]);
  } catch (err) /* istanbul ignore next */ {
    if (err.message?.includes('fatal: Not a valid object name')) {
      logger.debug(
        { err },
        'Branch not found when checking branch list - aborting'
      );
      throw new Error(REPOSITORY_CHANGED);
    }
    throw err;
  }
  // istanbul ignore if
  if (!files) {
    return [];
  }
  return files
    .split(newlineRegex)
    .filter(is.string)
    .filter((line) => line.startsWith('100'))
    .map((line) => line.split(regEx(/\t/)).pop()!)
    .filter((file) =>
      submodules.every((submodule: string) => !file.startsWith(submodule))
    );
}

export function getBranchList(): string[] {
  return Object.keys(config.branchCommits);
}

export async function isBranchStale(branchName: string): Promise<boolean> {
  await syncGit();
  try {
    const { currentBranchSha, currentBranch } = config;
    const branches = await git.branch([
      '--remotes',
      '--verbose',
      '--contains',
      config.currentBranchSha,
    ]);
    const isStale = !branches.all.map(localName).includes(branchName);
    logger.debug(
      { isStale, currentBranch, currentBranchSha },
      `isBranchStale=${isStale}`
    );
    return isStale;
  } catch (err) /* istanbul ignore next */ {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    throw err;
  }
}

export async function isBranchModified(branchName: string): Promise<boolean> {
  if (!branchExists(branchName)) {
    logger.debug(
      { branchName },
      'Branch does not exist - cannot check isModified'
    );
    return false;
  }
  // First check local config
  if (config.branchIsModified[branchName] !== undefined) {
    return config.branchIsModified[branchName];
  }
  // Second check repoCache
  const isModified = getCachedModifiedResult(
    branchName,
    config.branchCommits[branchName]
  );
  if (isModified !== null) {
    return (config.branchIsModified[branchName] = isModified);
  }

  await syncGit();
  // Retrieve the author of the most recent commit
  let lastAuthor: string | undefined;
  try {
    lastAuthor = (
      await git.raw([
        'log',
        '-1',
        '--pretty=format:%ae',
        `origin/${branchName}`,
        '--',
      ])
    ).trim();
  } catch (err) /* istanbul ignore next */ {
    if (err.message?.includes('fatal: bad revision')) {
      logger.debug(
        { err },
        'Remote branch not found when checking last commit author - aborting run'
      );
      throw new Error(REPOSITORY_CHANGED);
    }
    logger.warn({ err }, 'Error checking last author for isBranchModified');
  }
  const { gitAuthorEmail } = config;
  if (
    lastAuthor === gitAuthorEmail ||
    config.ignoredAuthors.some((ignoredAuthor) => lastAuthor === ignoredAuthor)
  ) {
    // author matches - branch has not been modified
    logger.debug({ branchName }, 'Branch has not been modified');
    config.branchIsModified[branchName] = false;
    setCachedModifiedResult(
      branchName,
      config.branchCommits[branchName],
      false
    );
    return false;
  }
  logger.debug(
    { branchName, lastAuthor, gitAuthorEmail },
    'Last commit author does not match git author email - branch has been modified'
  );
  config.branchIsModified[branchName] = true;
  setCachedModifiedResult(branchName, config.branchCommits[branchName], true);
  return true;
}

export async function isBranchConflicted(
  baseBranch: string,
  branch: string
): Promise<boolean> {
  logger.debug(`isBranchConflicted(${baseBranch}, ${branch})`);

  const baseBranchSha = getBranchCommit(baseBranch);
  const branchSha = getBranchCommit(branch);
  if (!baseBranchSha || !branchSha) {
    logger.warn(
      { baseBranch, branch },
      'isBranchConflicted: branch does not exist'
    );
    return true;
  }

  const cachedResult = getCachedConflictResult(
    baseBranch,
    baseBranchSha,
    branch,
    branchSha
  );
  if (is.boolean(cachedResult)) {
    logger.debug(
      `Using cached result ${cachedResult} for isBranchConflicted(${baseBranch}, ${branch})`
    );
    return cachedResult;
  }

  let result = false;
  await syncGit();
  await writeGitAuthor();

  const origBranch = config.currentBranch;
  try {
    await git.reset(ResetMode.HARD);
    if (origBranch !== baseBranch) {
      await git.checkout(baseBranch);
    }
    await git.merge(['--no-commit', '--no-ff', `origin/${branch}`]);
  } catch (err) {
    result = true;
    // istanbul ignore if: not easily testable
    if (!err?.git?.conflicts?.length) {
      logger.debug(
        { baseBranch, branch, err },
        'isBranchConflicted: unknown error'
      );
    }
  } finally {
    try {
      await git.merge(['--abort']);
      if (origBranch !== baseBranch) {
        await git.checkout(origBranch);
      }
    } catch (err) /* istanbul ignore next */ {
      logger.debug(
        { baseBranch, branch, err },
        'isBranchConflicted: cleanup error'
      );
    }
  }

  setCachedConflictResult(baseBranch, baseBranchSha, branch, branchSha, result);
  return result;
}

export async function deleteBranch(branchName: string): Promise<void> {
  await syncGit();
  try {
    await gitRetry(() => git.raw(['push', '--delete', 'origin', branchName]));
    logger.debug({ branchName }, 'Deleted remote branch');
  } catch (err) /* istanbul ignore next */ {
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    logger.debug({ branchName }, 'No remote branch to delete');
  }
  try {
    await deleteLocalBranch(branchName);
    // istanbul ignore next
    logger.debug({ branchName }, 'Deleted local branch');
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    // istanbul ignore if
    if (errChecked) {
      throw errChecked;
    }
    logger.debug({ branchName }, 'No local branch to delete');
  }
  delete config.branchCommits[branchName];
}

export async function mergeBranch(branchName: string): Promise<void> {
  let status: StatusResult | undefined;
  try {
    await syncGit();
    await git.reset(ResetMode.HARD);
    await gitRetry(() =>
      git.checkout(['-B', branchName, 'origin/' + branchName])
    );
    await gitRetry(() =>
      git.checkout([
        '-B',
        config.currentBranch,
        'origin/' + config.currentBranch,
      ])
    );
    status = await git.status();
    await gitRetry(() => git.merge(['--ff-only', branchName]));
    await gitRetry(() => git.push('origin', config.currentBranch));
    incLimitedValue(Limit.Commits);
  } catch (err) {
    logger.debug(
      {
        baseBranch: config.currentBranch,
        baseSha: config.currentBranchSha,
        branchName,
        branchSha: getBranchCommit(branchName),
        status,
        err,
      },
      'mergeBranch error'
    );
    throw err;
  }
}

export async function getBranchLastCommitTime(
  branchName: string
): Promise<Date> {
  await syncGit();
  try {
    const time = await git.show(['-s', '--format=%ai', 'origin/' + branchName]);
    return new Date(Date.parse(time));
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    // istanbul ignore if
    if (errChecked) {
      throw errChecked;
    }
    return new Date();
  }
}

export async function getBranchFiles(
  branchName: string
): Promise<string[] | null> {
  await syncGit();
  try {
    const diff = await gitRetry(() =>
      git.diffSummary([`origin/${branchName}`, `origin/${branchName}^`])
    );
    return diff.files.map((file) => file.file);
  } catch (err) /* istanbul ignore next */ {
    logger.warn({ err }, 'getBranchFiles error');
    const errChecked = checkForPlatformFailure(err);
    if (errChecked) {
      throw errChecked;
    }
    return null;
  }
}

export async function getFile(
  filePath: string,
  branchName?: string
): Promise<string | null> {
  await syncGit();
  try {
    const content = await git.show([
      'origin/' + (branchName ?? config.currentBranch) + ':' + filePath,
    ]);
    return content;
  } catch (err) {
    const errChecked = checkForPlatformFailure(err);
    // istanbul ignore if
    if (errChecked) {
      throw errChecked;
    }
    return null;
  }
}

export async function hasDiff(branchName: string): Promise<boolean> {
  await syncGit();
  try {
    return (await gitRetry(() => git.diff(['HEAD', branchName]))) !== '';
  } catch (err) {
    return true;
  }
}

async function handleCommitAuth(localDir: string): Promise<void> {
  if (!privateKeySet) {
    await writePrivateKey();
    privateKeySet = true;
  }
  await configSigningKey(localDir);
  await writeGitAuthor();
}

/**
 *
 * Prepare local branch with commit
 *
 * 0. Hard reset
 * 1. Creates local branch with `origin/` prefix
 * 2. Perform `git add` (respecting mode) and `git remove` for each file
 * 3. Perform commit
 * 4. Check whether resulting commit is empty or not (due to .gitignore)
 * 5. If not empty, return commit info for further processing
 *
 */
export async function prepareCommit({
  branchName,
  files,
  message,
  force = false,
}: CommitFilesConfig): Promise<CommitResult | null> {
  const localDir = GlobalConfig.get('localDir')!;
  await syncGit();
  logger.debug(`Preparing files for committing to branch ${branchName}`);
  await handleCommitAuth(localDir);
  try {
    await git.reset(ResetMode.HARD);
    await git.raw(['clean', '-fd']);
    const parentCommitSha = config.currentBranchSha;
    await gitRetry(() =>
      git.checkout(['-B', branchName, 'origin/' + config.currentBranch])
    );
    const deletedFiles: string[] = [];
    const addedModifiedFiles: string[] = [];
    const ignoredFiles: string[] = [];
    for (const file of files) {
      const fileName = file.path;
      if (file.type === 'deletion') {
        try {
          await git.rm([fileName]);
          deletedFiles.push(fileName);
        } catch (err) /* istanbul ignore next */ {
          const errChecked = checkForPlatformFailure(err);
          if (errChecked) {
            throw errChecked;
          }
          logger.trace({ err, fileName }, 'Cannot delete file');
          ignoredFiles.push(fileName);
        }
      } else {
        if (await isDirectory(upath.join(localDir, fileName))) {
          // This is usually a git submodule update
          logger.trace({ fileName }, 'Adding directory commit');
        } else if (file.contents === null) {
          continue;
        } else {
          let contents: Buffer;
          // istanbul ignore else
          if (typeof file.contents === 'string') {
            contents = Buffer.from(file.contents);
          } else {
            contents = file.contents;
          }
          // some file systems including Windows don't support the mode
          // so the index should be manually updated after adding the file
          if (file.isSymlink) {
            await fs.symlink(file.contents, upath.join(localDir, fileName));
          } else {
            await fs.outputFile(upath.join(localDir, fileName), contents, {
              mode: file.isExecutable ? 0o777 : 0o666,
            });
          }
        }
        try {
          // istanbul ignore next
          const addParams =
            fileName === configFileNames[0] ? ['-f', fileName] : fileName;
          await git.add(addParams);
          if (file.isExecutable) {
            await git.raw(['update-index', '--chmod=+x', fileName]);
          }
          addedModifiedFiles.push(fileName);
        } catch (err) /* istanbul ignore next */ {
          if (
            !err.message.includes(
              'The following paths are ignored by one of your .gitignore files'
            )
          ) {
            throw err;
          }
          logger.debug({ fileName }, 'Cannot commit ignored file');
          ignoredFiles.push(file.path);
        }
      }
    }

    const commitOptions: Options = {};
    if (getNoVerify().includes('commit')) {
      commitOptions['--no-verify'] = null;
    }

    const commitRes = await git.commit(message, [], commitOptions);
    if (
      commitRes.summary &&
      commitRes.summary.changes === 0 &&
      commitRes.summary.insertions === 0 &&
      commitRes.summary.deletions === 0
    ) {
      logger.warn({ commitRes }, 'Detected empty commit - aborting git push');
      return null;
    }
    logger.debug(
      { deletedFiles, ignoredFiles, result: commitRes },
      `git commit`
    );
    if (!force && !(await hasDiff(`origin/${branchName}`))) {
      logger.debug(
        { branchName, deletedFiles, addedModifiedFiles, ignoredFiles },
        'No file changes detected. Skipping commit'
      );
      return null;
    }

    const commitSha = (await git.revparse([branchName])).trim();
    const result: CommitResult = {
      parentCommitSha,
      commitSha,
      files: files.filter((fileChange) => {
        if (fileChange.type === 'deletion') {
          return deletedFiles.includes(fileChange.path);
        }
        return addedModifiedFiles.includes(fileChange.path);
      }),
    };

    return result;
  } catch (err) /* istanbul ignore next */ {
    return handleCommitError(files, branchName, err);
  }
}

export async function pushCommit({
  branchName,
  files,
}: CommitFilesConfig): Promise<boolean> {
  await syncGit();
  logger.debug(`Pushing branch ${branchName}`);
  let result = false;
  try {
    const pushOptions: TaskOptions = {
      '--force-with-lease': null,
      '-u': null,
    };
    if (getNoVerify().includes('push')) {
      pushOptions['--no-verify'] = null;
    }

    const pushRes = await gitRetry(() =>
      git.push('origin', `${branchName}:${branchName}`, pushOptions)
    );
    delete pushRes.repo;
    logger.debug({ result: pushRes }, 'git push');
    incLimitedValue(Limit.Commits);
    result = true;
  } catch (err) /* istanbul ignore next */ {
    handleCommitError(files, branchName, err);
  }
  return result;
}

export async function fetchCommit({
  branchName,
  files,
}: CommitFilesConfig): Promise<CommitSha | null> {
  await syncGit();
  logger.debug(`Fetching branch ${branchName}`);
  try {
    const ref = `refs/heads/${branchName}:refs/remotes/origin/${branchName}`;
    await gitRetry(() => git.pull(['origin', ref, '--force']));
    const commit = (await git.revparse([branchName])).trim();
    config.branchCommits[branchName] = commit;
    config.branchIsModified[branchName] = false;
    return commit;
  } catch (err) /* istanbul ignore next */ {
    return handleCommitError(files, branchName, err);
  }
}

export async function commitFiles(
  commitConfig: CommitFilesConfig
): Promise<CommitSha | null> {
  try {
    const commitResult = await prepareCommit(commitConfig);
    if (commitResult) {
      const pushResult = await pushCommit(commitConfig);
      if (pushResult) {
        const { branchName } = commitConfig;
        const { commitSha } = commitResult;
        config.branchCommits[branchName] = commitSha;
        config.branchIsModified[branchName] = false;
        return commitSha;
      }
    }
    return null;
  } catch (err) /* istanbul ignore next */ {
    if (err.message.includes('[rejected] (stale info)')) {
      throw new Error(REPOSITORY_CHANGED);
    }
    throw err;
  }
}

export function getUrl({
  protocol,
  auth,
  hostname,
  host,
  repository,
}: {
  protocol?: GitProtocol;
  auth?: string;
  hostname?: string;
  host?: string;
  repository: string;
}): string {
  if (protocol === 'ssh') {
    return `git@${hostname}:${repository}.git`;
  }
  return URL.format({
    protocol: protocol ?? 'https',
    auth,
    hostname,
    host,
    pathname: repository + '.git',
  });
}

let remoteRefsExist = false;

/**
 *
 * Non-branch refs allow us to store git objects without triggering CI pipelines.
 * It's useful for API-based branch rebasing.
 *
 * @see https://stackoverflow.com/questions/63866947/pushing-git-non-branch-references-to-a-remote/63868286
 *
 */
export async function pushCommitToRenovateRef(
  commitSha: string,
  refName: string,
  section = 'branches'
): Promise<void> {
  const fullRefName = `refs/renovate/${section}/${refName}`;
  await git.raw(['update-ref', fullRefName, commitSha]);
  await git.push(['--force', 'origin', fullRefName]);
  remoteRefsExist = true;
}

/**
 *
 * Removes all remote "refs/renovate/*" refs in two steps:
 *
 * Step 1: list refs
 *
 *   $ git ls-remote origin "refs/renovate/*"
 *
 *   > cca38e9ea6d10946bdb2d0ca5a52c205783897aa        refs/renovate/foo
 *   > 29ac154936c880068994e17eb7f12da7fdca70e5        refs/renovate/bar
 *   > 3fafaddc339894b6d4f97595940fd91af71d0355        refs/renovate/baz
 *   > ...
 *
 * Step 2:
 *
 *   $ git push --delete origin refs/renovate/foo refs/renovate/bar refs/renovate/baz
 *
 */
export async function clearRenovateRefs(): Promise<void> {
  if (!gitInitialized || !remoteRefsExist) {
    return;
  }

  logger.debug(`Cleaning up Renovate refs: refs/renovate/*`);
  const renovateRefs: string[] = [];
  const obsoleteRefs: string[] = [];

  try {
    const rawOutput = await git.listRemote([config.url, 'refs/renovate/*']);
    const refs = rawOutput
      .split(newlineRegex)
      .map((line) => line.replace(regEx(/[0-9a-f]+\s+/i), '').trim())
      .filter((line) => line.startsWith('refs/renovate/'));
    renovateRefs.push(...refs);
  } catch (err) /* istanbul ignore next */ {
    logger.warn({ err }, `Renovate refs cleanup error`);
  }

  const nonSectionedRefs = renovateRefs.filter((ref) => {
    return ref.split('/').length === 3;
  });
  obsoleteRefs.push(...nonSectionedRefs);

  const renovateBranchRefs = renovateRefs.filter((ref) =>
    ref.startsWith('refs/renovate/branches/')
  );
  obsoleteRefs.push(...renovateBranchRefs);

  if (obsoleteRefs.length) {
    const pushOpts = ['--delete', 'origin', ...obsoleteRefs];
    await git.push(pushOpts);
  }

  remoteRefsExist = false;
}

const treeItemRegex = regEx(
  /^(?<mode>\d{6})\s+(?<type>blob|tree|commit)\s+(?<sha>[0-9a-f]{40})\s+(?<path>.*)$/
);

const treeShaRegex = regEx(/tree\s+(?<treeSha>[0-9a-f]{40})\s*/);

/**
 *
 * Obtain top-level items of commit tree.
 * We don't need subtree items, so here are 2 steps only.
 *
 * Step 1: commit SHA -> tree SHA
 *
 *   $ git cat-file -p <commit-sha>
 *
 *   > tree <tree-sha>
 *   > parent 59b8b0e79319b7dc38f7a29d618628f3b44c2fd7
 *   > ...
 *
 * Step 2: tree SHA -> tree items (top-level)
 *
 *   $ git cat-file -p <tree-sha>
 *
 *   > 040000 tree 389400684d1f004960addc752be13097fe85d776    src
 *   > ...
 *   > 100644 blob 7d2edde437ad4e7bceb70dbfe70e93350d99c98b    package.json
 *
 */
export async function listCommitTree(commitSha: string): Promise<TreeItem[]> {
  const commitOutput = await git.catFile(['-p', commitSha]);
  const { treeSha } =
    treeShaRegex.exec(commitOutput)?.groups ??
    /* istanbul ignore next: will never happen */ {};
  const contents = await git.catFile(['-p', treeSha]);
  const lines = contents.split(newlineRegex);
  const result: TreeItem[] = [];
  for (const line of lines) {
    const matchGroups = treeItemRegex.exec(line)?.groups;
    if (matchGroups) {
      const { path, mode, type, sha } = matchGroups;
      result.push({ path, mode, type, sha });
    }
  }
  return result;
}
