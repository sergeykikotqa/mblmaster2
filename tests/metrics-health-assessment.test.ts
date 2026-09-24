import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorizeAdmin: vi.fn(),
  probeStateStore: vi.fn(),
  getRuntimeStats: vi.fn(),
  upsertState: vi.fn(),
  appendTransition: vi.fn(),
  listStates: vi.fn(),
  transitionHistory: vi.fn(),
  generateSnapshot: vi.fn(),
  buildSignals: vi.fn(),
  decideNextState: vi.fn(),
  notifyTransition: vi.fn(),
  notifyStoreFallback: vi.fn(),
}));

vi.mock('~/server/admin/auth', () => ({ authorizeAdminRequest: mocks.authorizeAdmin }));
vi.mock('~/server/metrics/state-store', () => ({
  probeHealthStateStoreAvailability: mocks.probeStateStore,
  getHealthStateStoreRuntimeStats: mocks.getRuntimeStats,
  upsertHealthState: mocks.upsertState,
  appendHealthTransition: mocks.appendTransition,
  listHealthStates: mocks.listStates,
  getHealthTransitionHistory: mocks.transitionHistory,
}));
vi.mock('~/server/metrics/snapshot', () => ({ generateDailyConversionSnapshot: mocks.generateSnapshot }));
vi.mock('~/server/metrics/signals', () => ({ buildSignals: mocks.buildSignals }));
vi.mock('~/server/metrics/state-machine', () => ({ decideNextHealthState: mocks.decideNextState }));
vi.mock('~/server/leads/alerts', () => ({
  notifyConversionHealthTransition: mocks.notifyTransition,
  notifyConversionHealthStoreFallback: mocks.notifyStoreFallback,
}));

import { evaluateConversionHealth } from '../src/server/metrics/health-evaluator';
import { handleAdminHealthStateRequest } from '../src/server/metrics/admin-health';
import { get as runHealthWorker } from '../src/pages/api/workers/metrics-health-eval';

const WORKER_TOKEN = 'synthetic-metrics-health-worker-token';

function redisProbe() {
  return {
    value: { available: true, legacyPayloadRead: false },
    dataSource: 'redis',
    degraded: false,
  } as const;
}

function runtimeStats(fallbackCount = 0) {
  return {
    redisFallbackToMemoryCount: fallbackCount,
    redisFallbackToMemoryLastAtMs: fallbackCount > 0 ? Date.UTC(2026, 8, 24, 3, 0, 0) : 0,
  };
}

function workerRequest(query = '') {
  return new Request(`https://mbl.example/api/workers/metrics-health-eval${query}`, {
    headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
  });
}

function expectNoBusinessHealthWork() {
  expect(mocks.generateSnapshot).not.toHaveBeenCalled();
  expect(mocks.buildSignals).not.toHaveBeenCalled();
  expect(mocks.decideNextState).not.toHaveBeenCalled();
  expect(mocks.upsertState).not.toHaveBeenCalled();
  expect(mocks.appendTransition).not.toHaveBeenCalled();
}

function expectNoNumericConversion(payload: unknown) {
  expect(JSON.stringify(payload)).not.toMatch(/"conversionRate"|"baselineConversionRate"|"deltaPct"/);
}

describe('conversion health assessment consent-scope safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('METRICS_HEALTH_WORKER_TOKEN', WORKER_TOKEN);
    vi.stubEnv('METRICS_WORKER_TOKEN', '');
    vi.stubEnv('CONTACT_WORKER_TOKEN', '');
    mocks.probeStateStore.mockResolvedValue(redisProbe());
    mocks.getRuntimeStats.mockReturnValue(runtimeStats());
    mocks.authorizeAdmin.mockResolvedValue({ ok: true, method: 'bearer' });
    mocks.notifyStoreFallback.mockResolvedValue(true);
    mocks.notifyTransition.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test.each([
    ['openings without submissions', { opened: 12, submitted: 0 }],
    ['submissions without openings', { opened: 0, submitted: 2 }],
    ['submissions greater than openings', { opened: 1, submitted: 3 }],
    ['empty data', { opened: 0, submitted: 0 }],
  ])('returns unavailable and does not inspect %s', async (_label, legacyCounts) => {
    mocks.generateSnapshot.mockResolvedValue({ rows: [legacyCounts] });

    const result = await evaluateConversionHealth({
      targetDay: '2026-09-23',
      baselineDays: 7,
    });

    expect(result).toMatchObject({
      targetDay: '2026-09-23',
      baselineDays: 7,
      conversion: { available: false, reason: 'CONSENT_SCOPE_MISMATCH' },
      statisticsSource: { status: 'NOT_CHECKED', reason: 'CONVERSION_ASSESSMENT_UNAVAILABLE' },
      stateStore: { available: true, dataSource: 'redis', degraded: false, legacyPayloadRead: false },
      states: [],
      summary: { slicesEvaluated: 0, transitions: 0, blockedByHysteresis: 0 },
    });
    expectNoNumericConversion(result);
    expectNoBusinessHealthWork();
  });

  test('repeated and concurrent evaluations never create business state or transitions', async () => {
    const results = await Promise.all([
      evaluateConversionHealth({ targetDay: '2026-09-23' }),
      evaluateConversionHealth({ targetDay: '2026-09-23' }),
      evaluateConversionHealth({ targetDay: '2026-09-23' }),
    ]);
    await evaluateConversionHealth({ targetDay: '2026-09-23' });

    expect(results.every((result) => result.states.length === 0 && result.summary.transitions === 0)).toBe(true);
    expect(mocks.probeStateStore).toHaveBeenCalledTimes(4);
    expectNoBusinessHealthWork();
  });

  test('worker exposes unavailable conversion without transition alerts or rates', async () => {
    const response = await runHealthWorker({ request: workerRequest('?sendAlert=true') });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      evaluation: {
        conversion: { available: false, reason: 'CONSENT_SCOPE_MISMATCH' },
        statisticsSource: { status: 'NOT_CHECKED' },
        stateStore: { available: true, dataSource: 'redis', degraded: false, legacyPayloadRead: false },
        summary: { transitions: 0 },
        problematic: [],
        transitionsTop: [],
      },
      alertSent: false,
      conversionAlertsSuppressed: true,
      businessTransitions: [],
      healthStoreFallbackAlertSent: false,
    });
    expectNoNumericConversion(body);
    expect(mocks.notifyTransition).not.toHaveBeenCalled();
    expect(mocks.notifyStoreFallback).not.toHaveBeenCalled();
    expectNoBusinessHealthWork();
  });

  test('worker preserves the independent technical fallback alert', async () => {
    mocks.probeStateStore.mockResolvedValue({
      value: { available: true, legacyPayloadRead: false },
      dataSource: 'memory',
      degraded: true,
    });
    mocks.getRuntimeStats.mockReturnValue(runtimeStats(1));

    const response = await runHealthWorker({ request: workerRequest('?sendAlert=true') });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.evaluation.stateStore).toEqual({
      available: true,
      dataSource: 'memory',
      degraded: true,
      legacyPayloadRead: false,
    });
    expect(body.healthStoreFallbackAlertSent).toBe(true);
    expect(body.alertSent).toBe(false);
    expect(mocks.notifyStoreFallback).toHaveBeenCalledWith(
      expect.objectContaining({ dataSource: 'memory', metricsDegraded: true, fallbackCount: 1 })
    );
    expect(mocks.notifyTransition).not.toHaveBeenCalled();
  });

  test('worker fails closed on a technical state-store error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.probeStateStore.mockRejectedValue(new Error('REDIS_NETWORK_ERROR'));

    const response = await runHealthWorker({ request: workerRequest('?sendAlert=true') });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, code: 'INTERNAL_ERROR' });
    expect(mocks.notifyTransition).not.toHaveBeenCalled();
    expect(mocks.notifyStoreFallback).not.toHaveBeenCalled();
  });

  test('worker authorization is enforced before technical probing', async () => {
    const response = await runHealthWorker({
      request: new Request('https://mbl.example/api/workers/metrics-health-eval'),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, code: 'UNAUTHORIZED' });
    expect(mocks.probeStateStore).not.toHaveBeenCalled();
  });

  test.each(['states', 'transitions'] as const)('admin %s view suppresses legacy health payloads', async (view) => {
    mocks.listStates.mockResolvedValue({
      value: [{ scope: 'global', key: 'legacy', state: 'CRITICAL' }],
      dataSource: 'redis',
      degraded: false,
    });
    mocks.transitionHistory.mockResolvedValue({
      value: [{ scope: 'global', key: 'legacy', from: 'HEALTHY', to: 'CRITICAL' }],
      dataSource: 'redis',
      degraded: false,
    });

    const response = await handleAdminHealthStateRequest(
      new Request(`https://mbl.example/api/admin/metrics-health?view=${view}`),
      'admin_metrics_health_api',
      '127.0.0.1'
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      view,
      conversion: { available: false, reason: 'CONSENT_SCOPE_MISMATCH' },
      stateStore: { available: true, dataSource: 'redis', degraded: false, legacyPayloadRead: false },
      legacyStateDataSuppressed: true,
      summary: { statesTracked: 0, transitionsSampled: 0 },
    });
    expect(body[view]).toEqual([]);
    expect(mocks.listStates).not.toHaveBeenCalled();
    expect(mocks.transitionHistory).not.toHaveBeenCalled();
    expectNoNumericConversion(body);
  });

  test('admin authorization is enforced before technical probing', async () => {
    mocks.authorizeAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }), { status: 401 }),
    });

    const response = await handleAdminHealthStateRequest(
      new Request('https://mbl.example/api/admin/metrics-health'),
      'admin_metrics_health_api'
    );

    expect(response.status).toBe(401);
    expect(mocks.probeStateStore).not.toHaveBeenCalled();
  });

  test('admin fails closed when the state-store probe fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.probeStateStore.mockRejectedValue(new Error('REDIS_NETWORK_ERROR'));

    const response = await handleAdminHealthStateRequest(
      new Request('https://mbl.example/api/admin/metrics-health'),
      'admin_metrics_health_api'
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, code: 'INTERNAL_ERROR' });
  });
});
