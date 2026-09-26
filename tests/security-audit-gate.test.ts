import { describe, expect, it, vi } from 'vitest';

import {
  applySecurityAuditPolicy,
  buildFindingKey,
  normalizeAllowlist,
  parseAuditReport,
} from '../scripts/security-audit-gate.mjs';

const cleanReport = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  },
};

const highReport = {
  auditReportVersion: 2,
  vulnerabilities: {
    dangerous: {
      name: 'dangerous',
      severity: 'high',
      range: '<2.0.0',
      nodes: ['node_modules/dangerous'],
      via: [
        {
          source: 12345,
          name: 'dangerous',
          severity: 'high',
          range: '<2.0.0',
        },
      ],
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
  },
};

const finding = {
  advisory: 'NPM-12345',
  package: 'dangerous',
  path: 'dangerous',
  severity: 'high',
  range: '<2.0.0',
};

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function allowlist(allowedUntil: string) {
  return normalizeAllowlist({
    entries: [{ ...finding, allowedUntil, owner: 'test', reason: 'synthetic fixture' }],
  });
}

describe('security audit gate side-effect boundary', () => {
  it('passes a clean report without writing the baseline by default', () => {
    const writeBaseline = vi.fn();
    expect(() => applySecurityAuditPolicy({ report: cleanReport, writeBaseline, logger: silentLogger })).not.toThrow();
    expect(writeBaseline).not.toHaveBeenCalled();
  });

  it('rejects an unallowlisted high finding without writing the baseline', () => {
    const writeBaseline = vi.fn();
    expect(() => applySecurityAuditPolicy({ report: highReport, writeBaseline, logger: silentLogger })).toThrow();
    expect(writeBaseline).not.toHaveBeenCalled();
  });

  it('rejects an expired allowlist entry without writing the baseline', () => {
    const writeBaseline = vi.fn();
    expect(() =>
      applySecurityAuditPolicy({
        report: highReport,
        allowlist: allowlist('2025-01-01'),
        now: new Date('2026-09-25T00:00:00.000Z'),
        writeBaseline,
        logger: silentLogger,
      })
    ).toThrow();
    expect(writeBaseline).not.toHaveBeenCalled();
  });

  it('rejects an invalid allowlist date without writing the baseline', () => {
    const writeBaseline = vi.fn();
    expect(() =>
      applySecurityAuditPolicy({
        report: highReport,
        allowlist: allowlist('not-a-date'),
        writeBaseline,
        logger: silentLogger,
      })
    ).toThrow();
    expect(writeBaseline).not.toHaveBeenCalled();
  });

  it('writes the exact report and generatedAt only after a clean explicit update', () => {
    const writeBaseline = vi.fn();
    const now = new Date('2026-09-25T12:34:56.000Z');
    applySecurityAuditPolicy({
      report: cleanReport,
      updateBaseline: true,
      writeBaseline,
      now,
      logger: silentLogger,
    });
    expect(writeBaseline).toHaveBeenCalledWith({ generatedAt: now.toISOString(), report: cleanReport });
  });

  it('does not write during an explicit update when policy fails', () => {
    const writeBaseline = vi.fn();
    expect(() =>
      applySecurityAuditPolicy({
        report: highReport,
        updateBaseline: true,
        writeBaseline,
        logger: silentLogger,
      })
    ).toThrow();
    expect(writeBaseline).not.toHaveBeenCalled();
  });

  it('is import-safe and exposes parsing helpers without executing npm audit', async () => {
    const module = await import('../scripts/security-audit-gate.mjs');
    expect(module.main).toBeTypeOf('function');
    expect(parseAuditReport(JSON.stringify(cleanReport))).toEqual(cleanReport);
    expect(buildFindingKey(finding)).toContain('NPM-12345');
  });
});
