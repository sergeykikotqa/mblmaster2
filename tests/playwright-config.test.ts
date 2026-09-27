import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import a11yConfig from '../playwright.a11y.config';
import auditConfig from '../playwright.audit.config';
import baseConfig, {
  DEFAULT_PLAYWRIGHT_WEBSERVER_TIMEOUT_MS,
  resolvePlaywrightWebServerTimeoutMs,
} from '../playwright.config';
import {
  ACCESSIBILITY_OWNED_SPECS,
  ARTIFACT_OWNED_SPECS,
  ACCESSIBILITY_SPEC_GLOBS,
  FUNCTIONAL_OWNED_SPECS,
  NON_ACCESSIBILITY_SPEC_GLOBS,
  OWNED_SPECS,
  SEO_OWNED_SPECS,
  SPECIALIZED_SPEC_GLOBS,
  SUITE_RELEASE_COMMAND,
  assertSuiteOwnership,
  classifySpec,
  findDuplicateOwners,
  findUnownedSpecs,
  listE2ESpecFiles,
  matchesSpecGlob,
  type SuiteOwner,
} from '../playwright.suites';

function readScript(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

const specFilesOnDisk = listE2ESpecFiles();

type ResolvedConfig = {
  testIgnore?: string | RegExp | Array<string | RegExp>;
  testMatch?: string | RegExp | Array<string | RegExp>;
};

function asGlobs(value: ResolvedConfig['testIgnore'] | ResolvedConfig['testMatch']): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => (typeof item === 'string' ? item : item.source));
}

function isIgnoredBy(config: ResolvedConfig, fileName: string): boolean {
  return asGlobs(config.testIgnore).some((pattern) => matchesSpecGlob(fileName, pattern));
}

function isMatchedBy(config: ResolvedConfig, fileName: string): boolean {
  const testMatch = asGlobs(config.testMatch);
  if (testMatch.length === 0) return true;
  return testMatch.some((pattern) => matchesSpecGlob(fileName, pattern));
}

/** Specs a config would actually run, given its testMatch/testIgnore filters. */
function selectedSpecs(config: ResolvedConfig, candidates: readonly string[] = specFilesOnDisk): string[] {
  return candidates.filter((fileName) => isMatchedBy(config, fileName) && !isIgnoredBy(config, fileName));
}

function webServerTimeout(config: typeof baseConfig): number | undefined {
  const server = config.webServer;
  if (!server || Array.isArray(server)) return undefined;
  return server.timeout;
}

function webServerEnv(config: typeof baseConfig): Record<string, string | undefined> | undefined {
  const server = config.webServer;
  if (!server || Array.isArray(server)) return undefined;
  return server.env as Record<string, string | undefined>;
}

describe('Playwright webServer startup contract', () => {
  test('uses one measured cold-start budget for base E2E and accessibility', () => {
    expect(DEFAULT_PLAYWRIGHT_WEBSERVER_TIMEOUT_MS).toBe(240_000);
    expect(webServerTimeout(baseConfig)).toBe(DEFAULT_PLAYWRIGHT_WEBSERVER_TIMEOUT_MS);
    expect(webServerTimeout(a11yConfig)).toBe(DEFAULT_PLAYWRIGHT_WEBSERVER_TIMEOUT_MS);
    expect(webServerTimeout(auditConfig)).toBe(DEFAULT_PLAYWRIGHT_WEBSERVER_TIMEOUT_MS);
  });

  test('allows an explicit bounded override and rejects unsafe values', () => {
    expect(resolvePlaywrightWebServerTimeoutMs('180000')).toBe(180_000);
    expect(() => resolvePlaywrightWebServerTimeoutMs('not-a-number')).toThrow(
      'PLAYWRIGHT_WEBSERVER_TIMEOUT_MS must be an integer of at least 30000 milliseconds.'
    );
    expect(() => resolvePlaywrightWebServerTimeoutMs('29999')).toThrow(
      'PLAYWRIGHT_WEBSERVER_TIMEOUT_MS must be an integer of at least 30000 milliseconds.'
    );
  });

  test('runs accessibility with PUBLIC_E2E=0 and the functional/audit suites with PUBLIC_E2E=1', () => {
    expect(webServerEnv(a11yConfig)?.PUBLIC_E2E).toBe('0');
    expect(webServerEnv(baseConfig)?.PUBLIC_E2E).toBe('1');
    expect(webServerEnv(auditConfig)?.PUBLIC_E2E).toBe('1');
  });
});

describe('Playwright suite ownership contract', () => {
  test('every spec file on disk has exactly one explicit owner', () => {
    expect(specFilesOnDisk.length).toBeGreaterThan(0);
    expect(findUnownedSpecs(specFilesOnDisk)).toEqual([]);
    expect(findDuplicateOwners(specFilesOnDisk)).toEqual([]);

    for (const fileName of specFilesOnDisk) {
      const owner = classifySpec(fileName);
      expect(owner, `${fileName} must resolve to a suite owner`).not.toBeNull();
      expect(['functional', 'accessibility', 'seo', 'artifact']).toContain(owner as SuiteOwner);
    }
  });

  test('an unknown new spec is reported as unowned instead of silently joining a gate', () => {
    expect(classifySpec('brand-new-capability.spec.ts')).toBeNull();
    expect(findUnownedSpecs([...specFilesOnDisk, 'brand-new-capability.spec.ts'])).toEqual([
      'brand-new-capability.spec.ts',
    ]);
    expect(() => assertSuiteOwnership('this-directory-does-not-exist-for-the-negative-case')).toThrow(
      /Playwright test directory is missing|ownership contract violated/
    );
  });

  test('the owned registry matches the specs on disk exactly, with no stale or lost entries', () => {
    expect([...OWNED_SPECS].sort()).toEqual(specFilesOnDisk);
    expect(new Set(OWNED_SPECS).size).toBe(OWNED_SPECS.length);
  });

  test('the functional gate runs functional specs only and excludes every specialized suite', () => {
    // The functional config must derive its ignore list from the shared ownership registry,
    // so a newly owned specialized spec cannot silently start running under PUBLIC_E2E=1.
    expect(asGlobs(baseConfig.testIgnore)).toEqual([...SPECIALIZED_SPEC_GLOBS]);

    const functionalSelection = selectedSpecs(baseConfig);
    expect(functionalSelection).toEqual([...FUNCTIONAL_OWNED_SPECS].sort());

    for (const fileName of [...ACCESSIBILITY_OWNED_SPECS, ...SEO_OWNED_SPECS, ...ARTIFACT_OWNED_SPECS]) {
      expect(functionalSelection, `${fileName} must not run in the functional gate`).not.toContain(fileName);
    }
  });

  test('the accessibility gate owns the full accessibility contract, including interactive SmartCaptcha', () => {
    // testIgnore has to be re-narrowed here: the base config ignores every specialized spec.
    expect(asGlobs(a11yConfig.testMatch)).toEqual([...ACCESSIBILITY_SPEC_GLOBS]);
    expect(asGlobs(a11yConfig.testIgnore)).toEqual([...NON_ACCESSIBILITY_SPEC_GLOBS]);

    const accessibilitySelection = selectedSpecs(a11yConfig);
    expect(accessibilitySelection).toEqual([...ACCESSIBILITY_OWNED_SPECS].sort());

    // Regression guard for the original failure mode: these asserts data-e2e is absent,
    // so they must never run in the PUBLIC_E2E=1 functional environment.
    expect(accessibilitySelection).toContain('a11y-all.spec.ts');
    expect(accessibilitySelection).toContain('a11y-smoke.spec.ts');
    // Interactive anti-bot error state that a full-page Axe scan cannot reach.
    expect(accessibilitySelection).toContain('smartcaptcha-a11y.spec.ts');
    expect(accessibilitySelection).toContain('project-gallery-focus.spec.ts');
    expect(accessibilitySelection).toContain('project-modal-focus.spec.ts');

    for (const fileName of [...SEO_OWNED_SPECS, ...ARTIFACT_OWNED_SPECS]) {
      expect(accessibilitySelection, `${fileName} must not run in the accessibility gate`).not.toContain(fileName);
    }
  });

  test('the SEO spec belongs to the SEO/artifact gate, not to the functional gate', () => {
    const auditSelection = selectedSpecs(auditConfig);
    expect(auditSelection).toEqual([...SEO_OWNED_SPECS, ...ARTIFACT_OWNED_SPECS].sort());
    expect(auditSelection).toContain('seo-invariants.spec.ts');
    expect(selectedSpecs(baseConfig)).not.toContain('seo-invariants.spec.ts');
  });

  test('no spec disappears from release coverage across the three gates', () => {
    const union = new Set([...selectedSpecs(baseConfig), ...selectedSpecs(a11yConfig), ...selectedSpecs(auditConfig)]);
    expect([...union].sort()).toEqual(specFilesOnDisk);
  });

  test('the public npm gates point at the configs that own each suite', () => {
    const { scripts } = packageJson;

    // Functional gate uses the base config, which is functional-only.
    expect(scripts['check:e2e']).toBe('playwright test');
    expect(scripts['check:e2e']).not.toContain('--config=playwright.a11y.config.ts');
    expect(scripts['check:e2e']).not.toContain('--config=playwright.audit.config.ts');

    // The full accessibility gate must not pin a subset of files, otherwise new
    // accessibility specs (for example smartcaptcha-a11y) would never be run.
    expect(scripts['check:accessibility:full']).toBe('playwright test --config=playwright.a11y.config.ts');
    expect(scripts['check:accessibility:full']).not.toMatch(/tests\/e2e\//);

    // The SEO browser gate regenerates a fresh manifest before running, so it cannot pass on a stale artifact.
    expect(scripts['check:seo:smoke']).toContain('scripts/generate-smoke-manifest.mjs');
    expect(scripts['check:seo:smoke']).toContain('--config=playwright.audit.config.ts');
    expect(scripts['check:seo:smoke']).toContain('tests/e2e/seo-invariants.spec.ts');

    // The build-gated mobile adaptation audit keeps an owner instead of running inside the functional gate.
    expect(scripts['check:mobile-audit']).toContain('--config=playwright.audit.config.ts');
    expect(scripts['check:mobile-audit']).toContain('tests/e2e/mobile-adaptation-audit.spec.ts');
  });
});

const EXPECTED_CONFIG_BY_OWNER: Record<SuiteOwner, string> = {
  functional: 'playwright.config.ts',
  accessibility: 'playwright.a11y.config.ts',
  seo: 'playwright.audit.config.ts',
  artifact: 'playwright.audit.config.ts',
};

/** Resolves the `--config=` in effect for a spec path inside a gate script, defaulting to the base config. */
function resolveConfigUsedForSpec(source: string, spec: string): string | null {
  const at = source.indexOf(spec);
  if (at === -1) return null;
  const before = source.slice(0, at);
  const marker = '--config=';
  const lastConfig = before.lastIndexOf(marker);
  if (lastConfig === -1) return 'playwright.config.ts';
  return before.slice(lastConfig + marker.length).split(/['"\s]/)[0] || null;
}

describe('Playwright gate scripts respect suite ownership', () => {
  const gateScriptsThatSpawnPlaywright = ['scripts/check-compose-runtime.mjs', 'scripts/check-admin-auth-e2e.mjs'];

  test.each(gateScriptsThatSpawnPlaywright)('%s never routes a spec to the wrong config', (scriptPath) => {
    const source = readScript(scriptPath);
    const referenced = specFilesOnDisk.filter((fileName) => source.includes(`tests/e2e/${fileName}`));
    expect(referenced.length).toBeGreaterThan(0);

    for (const fileName of referenced) {
      const owner = classifySpec(fileName);
      expect(owner, `${fileName} must have an owner`).not.toBeNull();
      const usedConfig = resolveConfigUsedForSpec(source, `tests/e2e/${fileName}`);
      expect(usedConfig, `${scriptPath} must invoke ${fileName} with the owning config`).toBe(
        EXPECTED_CONFIG_BY_OWNER[owner as SuiteOwner]
      );
    }
  });

  test('the pre-launch audit runs the build-gated mobile audit through its own gate', () => {
    const source = readScript('scripts/audit-pre-launch.mjs');
    expect(source).toContain("runNpm('check:mobile-audit')");
    // The functional gate ignores artifact-owned specs, so it must not be used as the entry point.
    expect(source).not.toContain("runNpm('check:e2e', ['--', 'tests/e2e/mobile-adaptation-audit.spec.ts'])");
  });
});

/**
 * Isolates one job block from a workflow file.
 *
 * Deliberately not a YAML parser: this project checks workflows with plain text
 * matching (see tests/runtime-gate-policy.test.ts). Scoping to the job matters,
 * because actions.yaml also contains a pr-gate job that runs check:seo:smoke —
 * a whole-file search would wrongly report the full-audit job as covered.
 */
function extractWorkflowJob(source: string, jobName: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^  ${jobName}:\\s*$`).test(line));
  if (start === -1) throw new Error(`Workflow job not found: ${jobName}`);

  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    // A new job starts at the same two-space indentation as the job header.
    if (/^ {2}\S.*:\s*$/.test(lines[index])) break;
    body.push(lines[index]);
  }
  return body.join('\n');
}

const RELEASE_JOBS: Array<{ file: string; job: string }> = [
  { file: '.github/workflows/actions.yaml', job: 'full-audit' },
  { file: '.github/workflows/nightly-quality.yaml', job: 'nightly' },
];

describe('Playwright specialized suites stay reachable from release gates', () => {
  test.each(RELEASE_JOBS)('$file $job invokes every suite owner command', ({ file, job }) => {
    const jobBody = extractWorkflowJob(readScript(file), job);
    expect(jobBody.length, `${file} job ${job} must be discovered`).toBeGreaterThan(0);

    for (const owner of Object.keys(SUITE_RELEASE_COMMAND) as SuiteOwner[]) {
      const command = SUITE_RELEASE_COMMAND[owner];
      const script = packageJson.scripts[command];

      // A dedicated owner command must exist before wiring it can mean anything.
      expect(script, `npm script ${command} must exist for the ${owner} suite`).toBeTruthy();
      expect(
        jobBody,
        `${file} job ${job} must run "npm run ${command}" so ${owner} specs stay in release coverage`
      ).toContain(`npm run ${command}`);
    }
  });

  test('the functional gate is not credited with running specialized specs', () => {
    // Guards the actual regression: check:e2e is functional-only, so specialized
    // coverage must come from the explicit owner commands wired above.
    const functionalJobBody = extractWorkflowJob(readScript('.github/workflows/actions.yaml'), 'full-audit');
    expect(functionalJobBody).toContain('npm run check:e2e');
    expect(functionalJobBody).toContain('npm run check:mobile-audit');
    expect(functionalJobBody).toContain('npm run check:seo:smoke');
  });
});
