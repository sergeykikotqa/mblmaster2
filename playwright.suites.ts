import fs from 'node:fs';
import path from 'node:path';

/**
 * Single source of truth for Playwright suite ownership.
 *
 * Every spec file in tests/e2e must be listed in exactly one suite below.
 * A new spec without an explicit owner fails the ownership regression test and
 * the Playwright config load, instead of silently running under the wrong
 * environment (for example an accessibility scan under PUBLIC_E2E=1).
 */

export type SuiteOwner = 'functional' | 'accessibility' | 'seo' | 'artifact';

export const E2E_TEST_DIR = './tests/e2e';

/** Axe/mobile-friendliness contracts. These must run with PUBLIC_E2E=0. */
export const ACCESSIBILITY_SPECS = [
  'a11y-all.spec.ts',
  'a11y-smoke.spec.ts',
  'project-gallery-focus.spec.ts',
  'project-modal-focus.spec.ts',
  'smartcaptcha-a11y.spec.ts',
] as const;

/** Browser SEO invariants. Requires a freshly generated smoke manifest. */
export const SEO_SPECS = ['seo-invariants.spec.ts'] as const;

/** Audits that need prebuilt artifacts (production build and sitemap). */
export const ARTIFACT_SPECS = ['mobile-adaptation-audit.spec.ts'] as const;

/** Runs against the dev server with PUBLIC_E2E=1. */
export const FUNCTIONAL_SPECS = [
  'admin-auth.spec.ts',
  'anchor-offset.spec.ts',
  'contact-form.spec.ts',
  'form-conversion.spec.ts',
  'header-navigation.spec.ts',
  'money-page-conversion-contract.spec.ts',
  'project-cta-fallback.spec.ts',
  'project-images.spec.ts',
  'project-modal-submission.spec.ts',
  'runtime-resource-integrity.spec.ts',
  'tracking-funnel.spec.ts',
] as const;

export const ACCESSIBILITY_OWNED_SPECS: readonly string[] = ACCESSIBILITY_SPECS;
export const SEO_OWNED_SPECS: readonly string[] = SEO_SPECS;
export const ARTIFACT_OWNED_SPECS: readonly string[] = ARTIFACT_SPECS;
export const FUNCTIONAL_OWNED_SPECS: readonly string[] = FUNCTIONAL_SPECS;

export const SPECIALIZED_SPECS: readonly string[] = [
  ...ACCESSIBILITY_OWNED_SPECS,
  ...SEO_OWNED_SPECS,
  ...ARTIFACT_OWNED_SPECS,
];

export const OWNED_SPECS: readonly string[] = [...FUNCTIONAL_OWNED_SPECS, ...SPECIALIZED_SPECS];

export const SUITE_OWNERS: Record<SuiteOwner, readonly string[]> = {
  functional: FUNCTIONAL_OWNED_SPECS,
  accessibility: ACCESSIBILITY_OWNED_SPECS,
  seo: SEO_OWNED_SPECS,
  artifact: ARTIFACT_OWNED_SPECS,
};

/**
 * Release gate that must invoke each suite's owner command.
 *
 * A spec having an npm script is not enough: after the suite split the generic
 * `check:e2e` no longer runs specialized specs, so an owner that is not wired
 * into the release gates would silently drop out of release coverage.
 */
export const SUITE_RELEASE_COMMAND: Record<SuiteOwner, string> = {
  functional: 'check:e2e',
  accessibility: 'check:accessibility:full',
  seo: 'check:seo:smoke',
  artifact: 'check:mobile-audit',
};

/** Minimal Playwright-style glob matcher for the leading-doublestar spec name shapes used here. */
export function matchesSpecGlob(fileName: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const normalizedName = fileName.replace(/\\/g, '/');
  if (normalizedPattern === normalizedName) return true;
  if (normalizedPattern === `**/${normalizedName}`) return true;
  if (normalizedPattern.startsWith('**/') && normalizedPattern.endsWith(normalizedName)) return true;
  return false;
}

export function toSpecGlob(fileName: string): string {
  return `**/${fileName}`;
}

export function toSpecGlobs(fileNames: readonly string[]): string[] {
  return fileNames.map(toSpecGlob);
}

export const ACCESSIBILITY_SPEC_GLOBS = toSpecGlobs(ACCESSIBILITY_OWNED_SPECS);
export const SEO_SPEC_GLOBS = toSpecGlobs(SEO_OWNED_SPECS);
export const ARTIFACT_SPEC_GLOBS = toSpecGlobs(ARTIFACT_OWNED_SPECS);
export const SPECIALIZED_SPEC_GLOBS = toSpecGlobs(SPECIALIZED_SPECS);
export const NON_ACCESSIBILITY_SPEC_GLOBS = toSpecGlobs([...SEO_OWNED_SPECS, ...ARTIFACT_OWNED_SPECS]);

/** All spec files currently present on disk, sorted for deterministic assertions. */
export function listE2ESpecFiles(rootDir: string = process.cwd()): string[] {
  const absoluteDir = path.join(rootDir, E2E_TEST_DIR);
  if (!fs.existsSync(absoluteDir)) {
    throw new Error(`Playwright test directory is missing: ${absoluteDir}`);
  }
  return fs
    .readdirSync(absoluteDir)
    .filter((entry) => entry.endsWith('.spec.ts'))
    .sort();
}

export function classifySpec(fileName: string): SuiteOwner | null {
  for (const owner of Object.keys(SUITE_OWNERS) as SuiteOwner[]) {
    if (SUITE_OWNERS[owner].includes(fileName)) return owner;
  }
  return null;
}

export function findUnownedSpecs(fileNames: readonly string[]): string[] {
  return fileNames.filter((fileName) => classifySpec(fileName) === null);
}

export function findDuplicateOwners(fileNames: readonly string[] = listE2ESpecFiles()): string[] {
  return fileNames.filter((fileName) => {
    const owners = (Object.keys(SUITE_OWNERS) as SuiteOwner[]).filter((owner) =>
      SUITE_OWNERS[owner].includes(fileName)
    );
    return owners.length !== 1;
  });
}

export function assertSuiteOwnership(rootDir: string = process.cwd()): void {
  const onDisk = listE2ESpecFiles(rootDir);
  const unowned = findUnownedSpecs(onDisk);
  const duplicates = findDuplicateOwners(onDisk);

  const problems: string[] = [];
  if (unowned.length > 0) {
    problems.push(`unowned spec files: ${unowned.join(', ')}`);
  }
  if (duplicates.length > 0) {
    problems.push(`spec files claimed by zero or multiple suites: ${duplicates.join(', ')}`);
  }
  for (const fileName of OWNED_SPECS) {
    if (!onDisk.includes(fileName)) {
      problems.push(`owned spec file is missing on disk: ${fileName}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Playwright suite ownership contract violated:\n- ${problems.join('\n- ')}\n` +
        'Add every new tests/e2e/*.spec.ts to exactly one list in playwright.suites.ts.'
    );
  }
}
