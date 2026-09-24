import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  DailySnapshotAnomaly,
  DailySnapshotAnomalyReason,
  DailySnapshotResult,
} from '../src/server/metrics/snapshot';

const mocks = vi.hoisted(() => ({
  generateSnapshot: vi.fn(),
  notifySnapshotAnomaly: vi.fn(),
}));

vi.mock('~/server/metrics/snapshot', () => ({
  generateDailyConversionSnapshot: mocks.generateSnapshot,
}));
vi.mock('~/server/leads/alerts', () => ({
  notifyConversionSnapshotAnomaly: mocks.notifySnapshotAnomaly,
}));

import { get } from '../src/pages/api/workers/metrics-snapshot';

const WORKER_TOKEN = 'metrics-snapshot-worker-test-token';
const ANOMALY_REASONS: DailySnapshotAnomalyReason[] = [
  'cr_drop',
  'zero_submitted',
  'opened_spike',
  'submitted_spike',
  'opened_up_submitted_down',
];

function countReasons(anomalies: DailySnapshotAnomaly[]) {
  return Object.fromEntries(
    ANOMALY_REASONS.map((reason) => [reason, anomalies.filter((anomaly) => anomaly.reason === reason).length])
  ) as Record<DailySnapshotAnomalyReason, number>;
}

function anomaly(reason: DailySnapshotAnomalyReason, overrides: Partial<DailySnapshotAnomaly> = {}) {
  return {
    scope: 'city_service',
    key: 'city_service:irkutsk:kuhni-na-zakaz',
    city: 'irkutsk',
    service: 'kuhni-na-zakaz',
    pageType: '',
    reason,
    severity: reason === 'zero_submitted' || reason === 'opened_up_submitted_down' ? 'critical' : 'warning',
    opened: 16,
    submitted: 3,
    conversionRate: 0.1875,
    baselineAvgOpened: 4,
    baselineAvgSubmitted: 2,
    baselineAvgConversionRate: 0.5,
    deltaConversionPct: -0.625,
    ...overrides,
  } satisfies DailySnapshotAnomaly;
}

function snapshot(anomalies: DailySnapshotAnomaly[] = []): DailySnapshotResult {
  return {
    targetDay: '2026-09-23',
    baselineDays: 7,
    generatedAtMs: Date.UTC(2026, 8, 24, 0, 0, 0),
    dataSource: 'mixed',
    storageSource: 'memory',
    metricsDegraded: true,
    rows: [
      {
        scope: 'city_service',
        key: 'city_service:irkutsk:kuhni-na-zakaz',
        city: 'irkutsk',
        service: 'kuhni-na-zakaz',
        pageType: '',
        opened: 16,
        submitted: 3,
        conversionRate: 0.1875,
        baselineAvgOpened: 4,
        baselineAvgSubmitted: 2,
        baselineAvgConversionRate: 0.5,
        deltaConversionPct: -0.625,
      },
    ],
    anomalies,
    summary: {
      rows: 1,
      anomalies: anomalies.length,
      critical: anomalies.filter((item) => item.severity === 'critical').length,
      warnings: anomalies.filter((item) => item.severity === 'warning').length,
      byReason: countReasons(anomalies),
    },
  };
}

function authorizedRequest(query = '') {
  return new Request(`https://mbl.example/api/workers/metrics-snapshot${query}`, {
    headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
  });
}

function expectNoLegacyConversionFields(payload: unknown) {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toMatch(/"conversionRate"|"baselineAvgConversionRate"|"deltaConversionPct"/);
}

describe('metrics snapshot worker conversion alert safety', () => {
  beforeEach(() => {
    mocks.generateSnapshot.mockReset();
    mocks.notifySnapshotAnomaly.mockReset();
    vi.stubEnv('METRICS_WORKER_TOKEN', WORKER_TOKEN);
    vi.stubEnv('CONTACT_WORKER_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test.each(['cr_drop', 'zero_submitted', 'opened_up_submitted_down'] as const)(
    'suppresses the legacy conversion alert for %s without hiding source diagnostics',
    async (reason) => {
      mocks.generateSnapshot.mockResolvedValue(snapshot([anomaly(reason)]));

      const response = await get({ request: authorizedRequest('?sendAlert=true') });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mocks.notifySnapshotAnomaly).not.toHaveBeenCalled();
      expect(body).toMatchObject({
        success: true,
        alertSent: false,
        conversionAlertsSuppressed: true,
        snapshot: {
          dataSource: 'mixed',
          storageSource: 'memory',
          metricsDegraded: true,
          conversion: { available: false, reason: 'CONSENT_SCOPE_MISMATCH' },
          raw: { rows: 1, opened: 16, submitted: 3 },
          volumeDiagnostics: [],
          suppressedConversionAnomalies: {
            total: 1,
            byReason: {
              cr_drop: reason === 'cr_drop' ? 1 : 0,
              zero_submitted: reason === 'zero_submitted' ? 1 : 0,
              opened_up_submitted_down: reason === 'opened_up_submitted_down' ? 1 : 0,
            },
          },
        },
      });
      expect(body.snapshot).not.toHaveProperty('summary');
      expect(body.snapshot).not.toHaveProperty('anomaliesTop');
      expectNoLegacyConversionFields(body);
    }
  );

  test.each(['opened_spike', 'submitted_spike'] as const)(
    'keeps %s only as a non-health volume diagnostic and never sends the legacy alert',
    async (reason) => {
      mocks.generateSnapshot.mockResolvedValue(snapshot([anomaly(reason)]));

      const response = await get({ request: authorizedRequest('?sendAlert=true') });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mocks.notifySnapshotAnomaly).not.toHaveBeenCalled();
      expect(body.alertSent).toBe(false);
      expect(body.conversionAlertsSuppressed).toBe(true);
      expect(body.snapshot.volumeDiagnostics).toEqual([
        {
          reason,
          classification: 'VOLUME_ONLY',
          healthSignal: false,
          conversionSignal: false,
          opened: 16,
          submitted: 3,
          baselineAvgOpened: 4,
          baselineAvgSubmitted: 2,
          message: 'Volume-only diagnostic; not a site-health or conversion signal.',
        },
      ]);
      expect(body.snapshot.suppressedConversionAnomalies.total).toBe(0);
      expectNoLegacyConversionFields(body);
    }
  );

  test('preserves source diagnostics and raw counters even without anomalies', async () => {
    mocks.generateSnapshot.mockResolvedValue(snapshot());

    const response = await get({ request: authorizedRequest() });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.snapshot).toMatchObject({
      dataSource: 'mixed',
      storageSource: 'memory',
      metricsDegraded: true,
      raw: { rows: 1, opened: 16, submitted: 3 },
      volumeDiagnostics: [],
      volumeDiagnosticsSummary: {
        total: 0,
        byReason: { opened_spike: 0, submitted_spike: 0 },
      },
      suppressedConversionAnomalies: {
        total: 0,
        byReason: { cr_drop: 0, zero_submitted: 0, opened_up_submitted_down: 0 },
      },
    });
    expect(mocks.notifySnapshotAnomaly).not.toHaveBeenCalled();
    expectNoLegacyConversionFields(body);
  });

  test('rejects an unauthorized request before generating a snapshot', async () => {
    const response = await get({
      request: new Request('https://mbl.example/api/workers/metrics-snapshot'),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, code: 'UNAUTHORIZED' });
    expect(mocks.generateSnapshot).not.toHaveBeenCalled();
    expect(mocks.notifySnapshotAnomaly).not.toHaveBeenCalled();
  });

  test('returns a technical error when snapshot generation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.generateSnapshot.mockRejectedValue(new Error('synthetic snapshot failure'));

    const response = await get({ request: authorizedRequest() });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ success: false, code: 'INTERNAL_ERROR' });
    expect(mocks.notifySnapshotAnomaly).not.toHaveBeenCalled();
  });
});
