import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const ROLLOUT_POLICY_PATH = path.join(ROOT, 'data', 'factory-rollout-policy.json');

const VALID_RELEASE_STAGES = new Set(['draft', 'noindex_live', 'index_trial', 'index_stable', 'rollback_noindex']);

const VALID_PRIORITY_TIERS = new Set(['A', 'B', 'C']);

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing file: ${path.relative(ROOT, filePath).replace(/\\/g, '/')}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeIndexabilityPolicy(indexabilityPolicy, pageType) {
  const raw = String(indexabilityPolicy || '').trim();
  if (raw === 'index') return 'index';
  if (raw === 'noindex_nofollow') return 'noindex_nofollow';
  if (raw === 'noindex_follow' || raw === 'noindex') return 'noindex_follow';
  return String(pageType || '').trim() === 'service-money' ? 'index' : 'noindex_follow';
}

function validateRolloutPolicy(policy) {
  if (!policy || typeof policy !== 'object') fail('factory-rollout-policy must be an object');
  if (!policy.thresholds || typeof policy.thresholds !== 'object') {
    fail('factory-rollout-policy.thresholds must be an object');
  }
  const min = Number(policy?.monthlyQuota?.min);
  const max = Number(policy?.monthlyQuota?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    fail('factory-rollout-policy.monthlyQuota is invalid');
  }
  const readinessMin = Number(
    policy?.gates?.indexTrial?.readinessScoreMin ?? policy?.thresholds?.indexTrial?.readinessScoreMin
  );
  if (!Number.isFinite(readinessMin) || readinessMin < 0 || readinessMin > 100) {
    fail('factory-rollout-policy.gates.indexTrial.readinessScoreMin is invalid');
  }
}

function validateGeneratedPages(pages, policy) {
  if (!Array.isArray(pages) || pages.length === 0) {
    fail('generated-pages must contain at least one page');
  }

  const errors = [];
  const trialPages = pages.filter((page) => String(page?.releaseStage || '').trim() === 'index_trial');
  const trialMax = Number(policy.monthlyQuota.max);
  const readinessMin = Number(
    policy?.gates?.indexTrial?.readinessScoreMin ?? policy?.thresholds?.indexTrial?.readinessScoreMin
  );

  if (trialPages.length > trialMax) {
    errors.push(`index_trial count exceeds monthlyQuota.max (${trialPages.length} > ${trialMax})`);
  }

  for (const page of pages) {
    const slug = String(page?.pageSlug || '').trim() || '<unknown>';
    const releaseStage = String(page?.releaseStage || '').trim();
    const policyValue = normalizeIndexabilityPolicy(page?.indexabilityPolicy, page?.pageType);
    const priorityTier = String(page?.priorityTier || '').trim();
    const readinessScore = Number(page?.readinessScore);
    const clusterId = String(page?.clusterId || '').trim();

    if (!VALID_RELEASE_STAGES.has(releaseStage)) {
      errors.push(`${slug}: invalid releaseStage "${releaseStage}"`);
    }

    if (!clusterId) {
      errors.push(`${slug}: clusterId is required`);
    }

    if (!VALID_PRIORITY_TIERS.has(priorityTier)) {
      errors.push(`${slug}: invalid priorityTier "${priorityTier}"`);
    }

    if (String(page?.pageType || '').trim() !== 'service-money') {
      errors.push(`${slug}: only service-money pages are allowed in generated-pages.`);
    }

    if (!Number.isFinite(readinessScore) || readinessScore < 0 || readinessScore > 100) {
      errors.push(`${slug}: readinessScore must be between 0 and 100`);
    }

    if (policyValue === 'index') {
      if (releaseStage !== 'index_trial' && releaseStage !== 'index_stable') {
        errors.push(`${slug}: indexable page must be index_trial or index_stable, got "${releaseStage}"`);
      }
      if (!priorityTier) {
        errors.push(`${slug}: indexable page must have priorityTier`);
      }
    } else if (releaseStage === 'index_trial' || releaseStage === 'index_stable') {
      errors.push(`${slug}: non-indexable page cannot have releaseStage "${releaseStage}"`);
    }

    if (releaseStage === 'index_trial') {
      if (readinessScore < readinessMin) {
        errors.push(`${slug}: index_trial requires readinessScore >= ${readinessMin}, got ${readinessScore}`);
      }
      if (String(page?.pageType || '').trim() !== 'service-money') {
        errors.push(`${slug}: index_trial is allowed only for service-money pages`);
      }
    }

    if (String(page?.pageType || '').trim() === 'service-money' && policyValue !== 'index') {
      errors.push(`${slug}: service-money pages must remain indexable`);
    }
  }

  if (errors.length > 0) {
    fail(`Rollout gates failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  }
}

function main() {
  const policy = readJson(ROLLOUT_POLICY_PATH);
  const pages = readJson(GENERATED_PAGES_PATH);
  validateRolloutPolicy(policy);
  validateGeneratedPages(pages, policy);
  console.log(`Rollout gates passed: ${pages.length} generated pages checked.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
