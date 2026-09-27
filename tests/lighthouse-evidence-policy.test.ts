import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const checkLighthouse = read('scripts/check-lighthouse.mjs');
const runLighthouseBatch = read('scripts/run-lighthouse-batch.mjs');
const lcpElementCheck = read('scripts/check-lighthouse-lcp-element.mjs');
const fullAuditWorkflow = read('.github/workflows/actions.yaml');
const lighthouserc = JSON.parse(read('.lighthouserc.json')) as {
  ci: { assert: { assertions: Record<string, [string, Record<string, unknown>?]> } };
};

/** Index of the first occurrence, or -1. */
function indexOf(source: string, needle: string): number {
  return source.indexOf(needle);
}

/**
 * Isolates one job block from a workflow file.
 *
 * Needed because actions.yaml also contains a pr-gate job running
 * `check:lighthouse:smoke`; a whole-file search would compare a pr-gate step
 * against a full-audit step and report the wrong order.
 */
function extractJob(source: string, jobName: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^  ${jobName}:\\s*$`).test(line));
  if (start === -1) throw new Error(`Workflow job not found: ${jobName}`);

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S.*:\s*$/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

describe('Lighthouse evidence is preserved before assertions', () => {
  test('collect runs before summarize, LCP element check and assert', () => {
    const collectIndex = indexOf(checkLighthouse, 'run-lighthouse-batch.mjs');
    const summarizeIndex = indexOf(checkLighthouse, 'lighthouse-summarize.mjs');
    const lcpIndex = indexOf(checkLighthouse, 'check-lighthouse-lcp-element.mjs');
    const assertIndex = indexOf(checkLighthouse, "'lhci', 'assert'");

    expect(collectIndex).toBeGreaterThan(-1);
    expect(summarizeIndex).toBeGreaterThan(collectIndex);
    expect(lcpIndex).toBeGreaterThan(summarizeIndex);
    expect(assertIndex, 'assert must run last so evidence survives a red gate').toBeGreaterThan(lcpIndex);
  });

  test('inline collection assertions are disabled so collect cannot fail early', () => {
    expect(checkLighthouse).toContain('LHCI_SKIP_ASSERT');
    const collectEnvIndex = indexOf(checkLighthouse, 'LHCI_SKIP_ASSERT:');
    const collectCallIndex = indexOf(checkLighthouse, 'run-lighthouse-batch.mjs');
    expect(collectEnvIndex).toBeGreaterThan(-1);
    expect(collectCallIndex).toBeGreaterThan(collectEnvIndex);
  });

  test('collected reports are copied to a stable evidence directory before any assertion', () => {
    expect(runLighthouseBatch).toContain('.tmp');
    expect(runLighthouseBatch).toContain('lighthouse-report');

    const collectIndex = indexOf(runLighthouseBatch, "'lhci', 'collect'");
    // Anchor on the call site, not the function definition.
    const evidenceIndex = indexOf(runLighthouseBatch, 'const evidenceFiles = persistCollectedEvidence();');
    const assertIndex = indexOf(runLighthouseBatch, "'lhci', 'assert'");

    expect(evidenceIndex, 'evidence must be persisted after collect').toBeGreaterThan(collectIndex);
    expect(assertIndex, 'inline assert must stay after evidence').toBeGreaterThan(evidenceIndex);
  });

  test('a failing assertion still fails the gate', () => {
    // The wrapper must keep throwing on a non-zero exit so a red threshold is never
    // downgraded to a warning by the evidence-preservation change.
    expect(checkLighthouse).toContain('throw new Error(`${label} failed with exit code ${result.status}`)');
    expect(checkLighthouse).toContain("'lhci assert'");
  });

  test('assertion labels are not misleading', () => {
    // The collect wrapper used to report "lhci collect failed" even when assert failed.
    expect(checkLighthouse).toContain("'lighthouse collect'");
    expect(indexOf(checkLighthouse, "'lhci collect'")).toBe(-1);
  });
});

describe('LCP diagnostics cover all routes while validation stays project-only', () => {
  test('diagnostics are collected before the project-only continue', () => {
    // The diagnostic must be pushed before the `type !== 'project'` filter,
    // otherwise home and article routes are never reported.
    const diagnosticIndex = lcpElementCheck.indexOf('diagnostics.push({');
    const projectFilterIndex = lcpElementCheck.indexOf("if (type !== 'project') continue;");
    expect(diagnosticIndex).toBeGreaterThan(-1);
    expect(projectFilterIndex).toBeGreaterThan(-1);
    expect(diagnosticIndex).toBeLessThan(projectFilterIndex);
  });

  test('home route diagnostics include value, selector, snippet and resource', () => {
    expect(lcpElementCheck).toContain('lcpMs: Number.isFinite(lcpAudit?.numericValue)');
    expect(lcpElementCheck).toContain("selector: node?.selector || 'unknown'");
    expect(lcpElementCheck).toContain("snippet: node?.snippet || 'unknown'");
    expect(lcpElementCheck).toContain('resourceUrl: resource?.resourceUrl || null');
    expect(lcpElementCheck).toContain('extractLcpResource');
  });

  test('diagnostics are printed for every run and persisted as evidence', () => {
    expect(lcpElementCheck).toContain('LCP diagnostics (all routes)');
    expect(lcpElementCheck).toContain("'lighthouse-lcp-elements.json'");
    expect(lcpElementCheck).toContain("'artifacts'");
  });

  test('project-only hero validation is preserved', () => {
    expect(lcpElementCheck).toContain("if (type !== 'project') continue;");
    expect(lcpElementCheck).toContain('isHeroImageNode(node)');
    expect(lcpElementCheck).toContain('LCP element check failed for project pages.');
    expect(lcpElementCheck).toContain('process.exit(1)');
  });
});

describe('security audit is not lost behind a red Lighthouse gate', () => {
  test('full-audit runs check:audit before check:lighthouse', () => {
    const fullAudit = extractJob(fullAuditWorkflow, 'full-audit');
    const auditIndex = fullAudit.indexOf('npm run check:audit');
    const lighthouseIndex = fullAudit.indexOf('npm run check:lighthouse');
    expect(auditIndex).toBeGreaterThan(-1);
    expect(lighthouseIndex).toBeGreaterThan(-1);
    expect(
      auditIndex,
      'security audit must run before Lighthouse so a red performance gate cannot skip it'
    ).toBeLessThan(lighthouseIndex);
  });

  test('nightly is not expanded with the security audit', () => {
    expect(read('.github/workflows/nightly-quality.yaml')).not.toContain('npm run check:audit');
  });
});

describe('Lighthouse thresholds stay unchanged', () => {
  test('LCP budget remains 2500ms at error level', () => {
    expect(lighthouserc.ci.assert.assertions['largest-contentful-paint']).toEqual(['error', { maxNumericValue: 2500 }]);
  });

  test('other budgets keep their committed values', () => {
    const assertions = lighthouserc.ci.assert.assertions;
    expect(assertions['cumulative-layout-shift']).toEqual(['error', { maxNumericValue: 0.1 }]);
    expect(assertions['total-blocking-time']).toEqual(['error', { maxNumericValue: 200 }]);
    expect(assertions['total-byte-weight']).toEqual(['error', { maxNumericValue: 350000 }]);
    expect(assertions['first-contentful-paint']).toEqual(['error', { maxNumericValue: 1850 }]);
    expect(assertions['speed-index']).toEqual(['error', { maxNumericValue: 2500 }]);
    expect(assertions['interaction-to-next-paint']).toEqual(['warn', { maxNumericValue: 200 }]);
    expect(assertions['categories:performance']).toEqual(['error', { minScore: 0.95 }]);
  });
});

describe('Lighthouse evidence is uploaded unconditionally', () => {
  const workflows = ['.github/workflows/actions.yaml', '.github/workflows/nightly-quality.yaml'];

  test.each(workflows)('%s uploads the evidence directory when a gate fails', (workflow) => {
    const source = read(workflow);
    expect(source).toContain('Upload Lighthouse artifacts');
    expect(source).toMatch(/name: Upload Lighthouse artifacts\s*\r?\n\s*if: always\(\)/);
    expect(source).toContain('.tmp/lighthouse-report/**');
    expect(source).toContain('artifacts/lighthouse-summary.json');
    expect(source).toContain('artifacts/lighthouse-lcp-elements.json');
  });
});
