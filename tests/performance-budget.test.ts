import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PERFORMANCE_BUDGET_LIMITS,
  analyzePerformanceBudgets,
  evaluatePerformanceBudgets,
} from '../scripts/check-performance-budgets.mjs';

const tempDirectories: string[] = [];

function createDist() {
  const distDir = mkdtempSync(path.join(tmpdir(), 'mbl-performance-budget-'));
  tempDirectories.push(distDir);
  return distDir;
}

function writeFixture(distDir: string, relativePath: string, contents: string) {
  const filePath = path.join(distDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function gzipSize(contents: string) {
  return zlib.gzipSync(Buffer.from(contents)).length;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('performance budget shipping policy', () => {
  it('locks the shipped limits so relaxing a budget requires an explicit test change', () => {
    // These are the production thresholds, not fixtures. Changing any of them is a
    // policy decision and must show up as a reviewed diff in this file, because the
    // analysis tests above only exercise synthetic limits.
    //
    // maxJsRepository is the only guard for unreferenced/dead JS: an orphan asset is
    // counted in the repository total but in no page's initial or runtime graph.
    expect(PERFORMANCE_BUDGET_LIMITS).toEqual({
      maxJsInitialPerPage: 15 * 1024,
      maxJsRuntimePerPage: 30 * 1024,
      maxJsRepository: 36 * 1024,
      maxCssTotal: 120 * 1024,
    });
  });
});

describe('performance budget analysis', () => {
  it('keeps initial and transitive route payloads separate', () => {
    const distDir = createDist();
    const entry = "const feature = '/scripts/feature.js'; import('./chunk.js');";
    const feature = 'window.featureLoaded = true;';
    const chunk = 'export const value = 1;';
    writeFixture(distDir, 'index.html', '<script type="module" src="/scripts/entry.js"></script>');
    writeFixture(distDir, 'scripts/entry.js', entry);
    writeFixture(distDir, 'scripts/feature.js', feature);
    writeFixture(distDir, 'scripts/chunk.js', chunk);

    const analysis = analyzePerformanceBudgets({ distDir });

    expect(analysis.maxInitialPage.route).toBe('/');
    expect(analysis.maxInitialPage.initialSize).toBe(gzipSize(entry));
    expect(analysis.maxRuntimePage.runtimeSize).toBe(gzipSize(entry) + gzipSize(feature) + gzipSize(chunk));
  });

  it('keeps unreferenced assets in the repository-wide budget', () => {
    const distDir = createDist();
    const entry = 'window.entryLoaded = true;';
    const orphan = 'window.orphanLoaded = false;';
    writeFixture(distDir, 'index.html', '<script src="/scripts/entry.js"></script>');
    writeFixture(distDir, 'scripts/entry.js', entry);
    writeFixture(distDir, 'scripts/orphan.js', orphan);

    const analysis = analyzePerformanceBudgets({ distDir });

    expect(analysis.totalJs).toBe(gzipSize(entry) + gzipSize(orphan));
    expect(analysis.assets.find((asset) => asset.relativePath === 'scripts/orphan.js')?.referenced).toBe(false);
  });

  it('fails each budget dimension independently', () => {
    const distDir = createDist();
    writeFixture(distDir, 'index.html', '<script src="/scripts/entry.js"></script>');
    writeFixture(distDir, 'scripts/entry.js', "import('/scripts/lazy.js');");
    writeFixture(distDir, 'scripts/lazy.js', 'window.lazyLoaded = true;');
    writeFixture(distDir, 'styles/site.css', 'body { color: black; }');
    const analysis = analyzePerformanceBudgets({ distDir });

    const errors = evaluatePerformanceBudgets(analysis, {
      maxJsInitialPerPage: 1,
      maxJsRuntimePerPage: 1,
      maxJsRepository: 1,
      maxCssTotal: 1,
    });

    expect(errors.some((error) => error.startsWith('Repository JS exceeds budget'))).toBe(true);
    expect(errors.some((error) => error.startsWith('Total CSS exceeds budget'))).toBe(true);
    expect(errors.some((error) => error.startsWith('Initial per-page JS budget exceeded'))).toBe(true);
    expect(errors.some((error) => error.startsWith('Runtime per-page JS budget exceeded'))).toBe(true);
  });
});
