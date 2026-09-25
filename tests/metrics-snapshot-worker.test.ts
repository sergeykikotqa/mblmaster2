import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { DailyMetricsSnapshotResultV2 } from '../src/server/metrics/snapshot';

const mocks = vi.hoisted(() => ({
  generateSnapshot: vi.fn(),
}));

vi.mock('~/server/metrics/snapshot', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/server/metrics/snapshot')>();
  return {
    ...original,
    generateDailyMetricsSnapshotV2: mocks.generateSnapshot,
  };
});

import { get } from '../src/pages/api/workers/metrics-snapshot';

const WORKER_TOKEN = 'metrics-snapshot-worker-test-token';

function snapshot(): DailyMetricsSnapshotResultV2 {
  return {
    storageSource: 'memory',
    snapshot: {
      schemaVersion: 2,
      targetDay: '2026-09-23',
      generatedAtMs: Date.UTC(2026, 8, 24, 0, 0, 0),
      dataSource: 'memory',
      metricsDegraded: true,
      counters: { opened: 16, submitted: 3 },
    },
  };
}

function authorizedRequest(query = '') {
  return new Request(`https://mbl.example/api/workers/metrics-snapshot${query}`, {
    headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
  });
}

function expectNoRemovedSnapshotSemantics(payload: unknown) {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toMatch(
    /"baselineDays"|"baselineAvgOpened"|"baselineAvgSubmitted"|"volumeDiagnostics"|"conversionRate"|"cr_drop"|"zero_submitted"|"opened_up_submitted_down"|"anomalies"/
  );
}

describe('metrics snapshot v2 worker', () => {
  beforeEach(() => {
    mocks.generateSnapshot.mockReset();
    vi.stubEnv('METRICS_WORKER_TOKEN', WORKER_TOKEN);
    vi.stubEnv('CONTACT_WORKER_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test('uses only the minimal v2 generator for a valid explicit day', async () => {
    mocks.generateSnapshot.mockResolvedValue(snapshot());

    const response = await get({ request: authorizedRequest('?day=2026-09-23') });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.generateSnapshot).toHaveBeenCalledOnce();
    expect(mocks.generateSnapshot).toHaveBeenCalledWith({ targetDay: '2026-09-23' });
    expect(body).toEqual({
      success: true,
      snapshot: {
        schemaVersion: 2,
        targetDay: '2026-09-23',
        generatedAtMs: Date.UTC(2026, 8, 24, 0, 0, 0),
        dataSource: 'memory',
        storageSource: 'memory',
        metricsDegraded: true,
        raw: { opened: 16, submitted: 3 },
      },
      alertSent: false,
      conversionAlertsSuppressed: true,
    });
    expectNoRemovedSnapshotSemantics(body);
  });

  test('keeps the default target-day behavior when day is absent', async () => {
    mocks.generateSnapshot.mockResolvedValue(snapshot());

    const response = await get({ request: authorizedRequest() });

    expect(response.status).toBe(200);
    expect(mocks.generateSnapshot).toHaveBeenCalledWith({ targetDay: undefined });
  });

  test.each(['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2026-9-23'])(
    'rejects invalid explicit day %s before snapshot generation',
    async (day) => {
      const response = await get({ request: authorizedRequest(`?day=${encodeURIComponent(day)}`) });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ success: false, code: 'INVALID_DAY' });
      expect(mocks.generateSnapshot).not.toHaveBeenCalled();
    }
  );

  test('rejects the removed baselineDays API parameter', async () => {
    const response = await get({ request: authorizedRequest('?day=2026-09-23&baselineDays=7') });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, code: 'BASELINE_DAYS_NOT_SUPPORTED' });
    expect(mocks.generateSnapshot).not.toHaveBeenCalled();
  });

  test('rejects an unauthorized request before generating a snapshot', async () => {
    const response = await get({
      request: new Request('https://mbl.example/api/workers/metrics-snapshot'),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, code: 'UNAUTHORIZED' });
    expect(mocks.generateSnapshot).not.toHaveBeenCalled();
  });

  test('returns a technical error when snapshot generation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.generateSnapshot.mockRejectedValue(new Error('synthetic snapshot failure'));

    const response = await get({ request: authorizedRequest() });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ success: false, code: 'INTERNAL_ERROR' });
  });
});
