import is from '@sindresorhus/is';
import slugify from 'slugify';
import { mergeChildConfig } from '../../config';
import type { PackageRule, PackageRuleInputConfig } from '../../config/types';
import { logger } from '../../logger';
import type { StageName } from '../../types/skip-reason';
import matchers from './matchers';
import { matcherOR } from './utils';

function matchesRule(
  inputConfig: PackageRuleInputConfig,
  packageRule: PackageRule,
): boolean {
  let positiveMatch = true;
  let matchApplied = false;
  // matches
  for (const groupMatchers of matchers) {
    const isMatch = matcherOR(
      'matches',
      groupMatchers,
      inputConfig,
      packageRule,
    );

    // no rules are defined
    if (is.nullOrUndefined(isMatch)) {
      continue;
    }

    matchApplied = true;

    if (!is.truthy(isMatch)) {
      return false;
    }
  }

  // not a single match rule is defined --> assume to match everything
  if (!matchApplied) {
    positiveMatch = true;
  }

  // excludes
  for (const groupExcludes of matchers) {
    const isExclude = matcherOR(
      'excludes',
      groupExcludes,
      inputConfig,
      packageRule,
    );

    // no rules are defined
    if (is.nullOrUndefined(isExclude)) {
      continue;
    }

    if (isExclude) {
      return false;
    }
  }

  return positiveMatch;
}

export function applyPackageRules<T extends PackageRuleInputConfig>(
  inputConfig: T,
  stageName?: StageName,
): T {
  let config = { ...inputConfig };
  const packageRules = config.packageRules ?? [];
  logger.trace(
    { dependency: config.depName, packageRules },
    `Checking against ${packageRules.length} packageRules`,
  );
  for (const packageRule of packageRules) {
    // This rule is considered matched if there was at least one positive match and no negative matches
    if (matchesRule(config, packageRule)) {
      // Package rule config overrides any existing config
      const toApply = removeMatchers({ ...packageRule });
      if (config.groupSlug && packageRule.groupName && !packageRule.groupSlug) {
        // Need to apply groupSlug otherwise the existing one will take precedence
        toApply.groupSlug = slugify(packageRule.groupName, {
          lower: true,
        });
      }
      if (toApply.enabled === false && config.enabled !== false) {
        config.skipReason = 'package-rules';
        if (stageName) {
          config.skipStage = stageName;
        }
      }
      if (toApply.enabled === true && config.enabled === false) {
        delete config.skipReason;
        delete config.skipStage;
      }
      config = mergeChildConfig(config, toApply);
    }
  }
  return config;
}

function removeMatchers(
  packageRule: PackageRule & PackageRuleInputConfig,
): Record<string, unknown> {
  for (const key of Object.keys(packageRule)) {
    if (key.startsWith('match') || key.startsWith('exclude')) {
      delete packageRule[key];
    }
  }

  return packageRule;
}
