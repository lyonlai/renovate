import is from '@sindresorhus/is';
import { mergeChildConfig } from '../../../config';
import { configFileNames } from '../../../config/app-strings';
import { decryptConfig } from '../../../config/decrypt';
import { migrateAndValidate } from '../../../config/migrate-validate';
import { migrateConfig } from '../../../config/migration';
import { parseFileConfig } from '../../../config/parse';
import * as presets from '../../../config/presets';
import { applySecretsAndVariablesToConfig } from '../../../config/secrets';
import type { AllConfig, RenovateConfig } from '../../../config/types';
import {
  CONFIG_VALIDATION,
  REPOSITORY_CHANGED,
} from '../../../constants/error-messages';
import { logger } from '../../../logger';
import * as npmApi from '../../../modules/datasource/npm';
import { platform } from '../../../modules/platform';
import { scm } from '../../../modules/platform/scm';
import { ExternalHostError } from '../../../types/errors/external-host-error';
import { getCache } from '../../../util/cache/repository';
import { parseJson } from '../../../util/common';
import { setUserEnv } from '../../../util/env';
import { readLocalFile } from '../../../util/fs';
import * as hostRules from '../../../util/host-rules';
import * as queue from '../../../util/http/queue';
import * as throttle from '../../../util/http/throttle';
import { maskToken } from '../../../util/mask';
import { regEx } from '../../../util/regex';
import { parseAndValidateOrExit } from '../../global/config/parse/env';
import { getOnboardingConfig } from '../onboarding/branch/config';
import {
  getOnboardingConfigFromCache,
  getOnboardingFileNameFromCache,
  setOnboardingConfigDetails,
} from '../onboarding/branch/onboarding-branch-cache';
import {
  OnboardingState,
  getDefaultConfigFileName,
} from '../onboarding/common';
import type { RepoFileConfig } from './types';

export async function detectConfigFile(): Promise<string | null> {
  const fileList = await scm.getFileList();
  for (const fileName of configFileNames) {
    if (fileName === 'package.json') {
      try {
        const pJson = JSON.parse(
          (await readLocalFile('package.json', 'utf8'))!,
        );
        if (pJson.renovate) {
          logger.warn(
            'Using package.json for Renovate config is deprecated - please use a dedicated configuration file instead',
          );
          return 'package.json';
        }
      } catch {
        // Do nothing
      }
    } else if (fileList.includes(fileName)) {
      return fileName;
    }
  }
  return null;
}

export async function detectRepoFileConfig(
  branchName?: string,
): Promise<RepoFileConfig> {
  const cache = getCache();
  let { configFileName } = cache;
  if (is.nonEmptyString(configFileName)) {
    let configFileRaw: string | null;
    try {
      configFileRaw = await platform.getRawFile(
        configFileName,
        undefined,
        branchName,
      );
    } catch (err) {
      // istanbul ignore if
      if (err instanceof ExternalHostError) {
        throw err;
      }
      configFileRaw = null;
    }
    if (configFileRaw) {
      let configFileParsed = parseJson(configFileRaw, configFileName) as any;
      if (configFileName === 'package.json') {
        configFileParsed = configFileParsed.renovate;
      }
      return { configFileName, configFileParsed };
    } else {
      logger.debug('Existing config file no longer exists');
      delete cache.configFileName;
    }
  }

  if (OnboardingState.onboardingCacheValid) {
    configFileName = getOnboardingFileNameFromCache();
  } else {
    configFileName = (await detectConfigFile()) ?? undefined;
  }

  if (!configFileName) {
    logger.debug('No renovate config file found');
    cache.configFileName = '';
    return {};
  }
  cache.configFileName = configFileName;
  logger.debug(`Found ${configFileName} config file`);
  // TODO #22198
  let configFileParsed: any;
  let configFileRaw: string | undefined | null;

  if (OnboardingState.onboardingCacheValid) {
    const cachedConfig = getOnboardingConfigFromCache();
    const parsedConfig = cachedConfig ? JSON.parse(cachedConfig) : undefined;
    if (parsedConfig) {
      setOnboardingConfigDetails(configFileName, JSON.stringify(parsedConfig));
      return { configFileName, configFileParsed: parsedConfig };
    }
  }

  if (configFileName === 'package.json') {
    // We already know it parses
    configFileParsed = JSON.parse(
      // TODO #22198
      (await readLocalFile('package.json', 'utf8'))!,
    ).renovate;
    if (is.string(configFileParsed)) {
      logger.debug('Massaging string renovate config to extends array');
      configFileParsed = { extends: [configFileParsed] };
    }
    logger.debug({ config: configFileParsed }, 'package.json>renovate config');
  } else {
    configFileRaw = await readLocalFile(configFileName, 'utf8');
    // istanbul ignore if
    if (!is.string(configFileRaw)) {
      logger.warn({ configFileName }, 'Null contents when reading config file');
      throw new Error(REPOSITORY_CHANGED);
    }
    // istanbul ignore if
    if (!configFileRaw.length) {
      configFileRaw = '{}';
    }

    const parseResult = parseFileConfig(configFileName, configFileRaw);

    if (!parseResult.success) {
      return {
        configFileName,
        configFileParseError: {
          validationError: parseResult.validationError,
          validationMessage: parseResult.validationMessage,
        },
      };
    }
    configFileParsed = parseResult.parsedContents;
    logger.debug(
      { fileName: configFileName, config: configFileParsed },
      'Repository config',
    );
  }

  setOnboardingConfigDetails(configFileName, JSON.stringify(configFileParsed));
  return { configFileName, configFileParsed };
}

export function checkForRepoConfigError(repoConfig: RepoFileConfig): void {
  if (!repoConfig.configFileParseError) {
    return;
  }
  const error = new Error(CONFIG_VALIDATION);
  error.validationSource = repoConfig.configFileName;
  error.validationError = repoConfig.configFileParseError.validationError;
  error.validationMessage = repoConfig.configFileParseError.validationMessage;
  throw error;
}

// Check for repository config
export async function mergeRenovateConfig(
  config: RenovateConfig,
  branchName?: string,
): Promise<RenovateConfig> {
  let returnConfig = { ...config };
  let repoConfig: RepoFileConfig = {};
  if (config.requireConfig !== 'ignored') {
    repoConfig = await detectRepoFileConfig(branchName);
  }
  if (!repoConfig.configFileParsed && config.mode === 'silent') {
    logger.debug(
      'When mode=silent and repo has no config file, we use the onboarding config as repo config',
    );
    const configFileName = getDefaultConfigFileName(config);
    repoConfig = {
      configFileName,
      configFileParsed: await getOnboardingConfig(config),
    };
  }
  const configFileParsed = repoConfig?.configFileParsed ?? {};
  // I think we do not need to use combined env here as static repo config is meant to be in the env var and not file/repo config
  const configFileAndEnv = await mergeStaticRepoEnvConfig(
    configFileParsed,
    process.env,
  );
  if (is.nonEmptyArray(returnConfig.extends)) {
    configFileAndEnv.extends = [
      ...returnConfig.extends,
      ...(configFileAndEnv.extends ?? []),
    ];
    delete returnConfig.extends;
  }
  checkForRepoConfigError(repoConfig);
  const migratedConfig = await migrateAndValidate(config, configFileAndEnv);
  if (migratedConfig.errors?.length) {
    const error = new Error(CONFIG_VALIDATION);
    error.validationSource = repoConfig.configFileName;
    error.validationError =
      'The renovate configuration file contains some invalid settings';
    error.validationMessage = migratedConfig.errors
      .map((e) => e.message)
      .join(', ');
    throw error;
  }
  if (migratedConfig.warnings) {
    returnConfig.warnings = [
      ...(returnConfig.warnings ?? []),
      ...migratedConfig.warnings,
    ];
  }
  delete migratedConfig.errors;
  delete migratedConfig.warnings;
  // TODO #22198
  const repository = config.repository!;
  // Decrypt before resolving in case we need npm authentication for any presets
  const decryptedConfig = await decryptConfig(migratedConfig, repository);
  setNpmTokenInNpmrc(decryptedConfig);
  // istanbul ignore if
  if (is.string(decryptedConfig.npmrc)) {
    logger.debug('Found npmrc in decrypted config - setting');
    npmApi.setNpmrc(decryptedConfig.npmrc);
  }
  // Decrypt after resolving in case the preset contains npm authentication instead
  let resolvedConfig = await decryptConfig(
    await presets.resolveConfigPresets(
      decryptedConfig,
      config,
      config.ignorePresets,
    ),
    repository,
  );
  logger.trace({ config: resolvedConfig }, 'resolved config');
  const migrationResult = migrateConfig(resolvedConfig);
  if (migrationResult.isMigrated) {
    logger.debug('Resolved config needs migrating');
    logger.trace({ config: resolvedConfig }, 'resolved config after migrating');
    resolvedConfig = migrationResult.migratedConfig;
  }
  setNpmTokenInNpmrc(resolvedConfig);
  // istanbul ignore if
  if (is.string(resolvedConfig.npmrc)) {
    logger.debug(
      'Ignoring any .npmrc files in repository due to configured npmrc',
    );
    npmApi.setNpmrc(resolvedConfig.npmrc);
  }
  resolvedConfig = applySecretsAndVariablesToConfig({
    config: resolvedConfig,
    secrets: mergeChildConfig(
      config.secrets ?? {},
      resolvedConfig.secrets ?? {},
    ),
    variables: mergeChildConfig(
      config.variables ?? {},
      resolvedConfig.variables ?? {},
    ),
  });

  // istanbul ignore if
  if (resolvedConfig.hostRules) {
    logger.debug('Setting hostRules from config');
    for (const rule of resolvedConfig.hostRules) {
      try {
        hostRules.add(rule);
      } catch (err) {
        logger.warn(
          { err, config: rule },
          'Error setting hostRule from config',
        );
      }
    }
    // host rules can change concurrency
    queue.clear();
    throttle.clear();
    delete resolvedConfig.hostRules;
  }
  returnConfig = mergeChildConfig(returnConfig, resolvedConfig);
  returnConfig = await presets.resolveConfigPresets(returnConfig, config);
  returnConfig.renovateJsonPresent = true;
  // istanbul ignore if
  if (returnConfig.ignorePaths?.length) {
    logger.debug(
      { ignorePaths: returnConfig.ignorePaths },
      `Found repo ignorePaths`,
    );
  }

  setUserEnv(returnConfig.env);
  delete returnConfig.env;

  return returnConfig;
}

/** needed when using portal secrets for npmToken */
export function setNpmTokenInNpmrc(config: RenovateConfig): void {
  if (!is.string(config.npmToken)) {
    return;
  }

  const token = config.npmToken;
  logger.debug({ npmToken: maskToken(token) }, 'Migrating npmToken to npmrc');

  if (!is.string(config.npmrc)) {
    logger.debug('Adding npmrc to config');
    config.npmrc = `//registry.npmjs.org/:_authToken=${token}\n`;
    delete config.npmToken;
    return;
  }

  if (config.npmrc.includes(`\${NPM_TOKEN}`)) {
    logger.debug(`Replacing \${NPM_TOKEN} with npmToken`);
    config.npmrc = config.npmrc.replace(regEx(/\${NPM_TOKEN}/g), token);
  } else {
    logger.debug('Appending _authToken= to end of existing npmrc');
    config.npmrc = config.npmrc.replace(
      regEx(/\n?$/),
      `\n_authToken=${token}\n`,
    );
  }

  delete config.npmToken;
}

export async function mergeStaticRepoEnvConfig(
  config: AllConfig,
  env: NodeJS.ProcessEnv,
): Promise<AllConfig> {
  const repoEnvConfig = await parseAndValidateOrExit(
    env,
    'RENOVATE_STATIC_REPO_CONFIG',
  );

  if (!is.nonEmptyObject(repoEnvConfig)) {
    return config;
  }

  // merge extends
  if (is.nonEmptyArray(repoEnvConfig.extends)) {
    config.extends = [...repoEnvConfig.extends, ...(config.extends ?? [])];
    delete repoEnvConfig.extends;
  }
  // renovate repo config overrides RENOVATE_STATIC_REPO_CONFIG
  return mergeChildConfig(repoEnvConfig, config);
}
