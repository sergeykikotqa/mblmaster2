import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFunnelRollup: vi.fn(),
}));

vi.mock('~/server/metrics/funnel', () => ({
  getFunnelRollup: mocks.getFunnelRollup,
}));

import {
  buildAdminHealthAggregatePayload,
  buildAdminHealthSummary,
  buildMetricsHealthCheck,
  runHealthCheckWithTimeout,
  type AdminHealthAggregateChecks,
} from '../src/server/admin/health-checks';

function mockFunnelRollup(pageViews: number, formOpened: number, formSubmitted: number, dataSource = 'redis') {
  mocks.getFunnelRollup.mockResolvedValue({
    span: 'day',
    bucket: '2026-09-24',
    generatedAtMs: 1,
    dataSource,
    totalPageViews: pageViews,
    totalOpened: formOpened,
    totalSubmitted: formSubmitted,
    conversionRate: null,
    totalOps: {},
    totalOpsReasons: {},
    entries: [],
  });
}

const ADMIN_HEALTH_ELEMENT_IDS = [
  'health-check-button',
  'health-auto-refresh',
  'health-refresh-interval',
  'health-status',
  'health-overall-chip',
  'health-dashboard',
  'health-cards',
  'health-operations',
  'health-detail-body',
  'health-raw',
  'health-auth-method',
  'health-last-updated',
  'health-total-duration',
  'health-average-latency',
  'health-latency',
  'health-system-auth',
  'health-proxy-trust',
  'health-fail-open',
] as const;

class FakeAdminHealthElement {
  hidden = false;
  disabled = false;
  className = '';
  textContent = '';
  innerHTML = '';
  value = '5000';
  checked = false;
  dataset: Record<string, string> = {};
  classList = { toggle: vi.fn() };
  listeners = new Map<string, () => void>();

  setAttribute() {}

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
}

async function renderAdminHealth(payload: unknown) {
  const elements = new Map<string, FakeAdminHealthElement>(
    ADMIN_HEALTH_ELEMENT_IDS.map((id) => [id, new FakeAdminHealthElement()])
  );
  const document = {
    title: 'Admin Dashboard',
    getElementById(id: string) {
      return elements.get(id) || null;
    },
  };
  const window = {
    location: { pathname: '/admin', assign: vi.fn() },
    clearInterval: vi.fn(),
    setInterval: vi.fn(() => 1),
  };
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
  const script = readFileSync(new URL('../public/scripts/admin-health.js', import.meta.url), 'utf8');
  const execute = new Function(
    'document',
    'window',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLSelectElement',
    'fetch',
    script
  );
  execute(document, window, FakeAdminHealthElement, FakeAdminHealthElement, FakeAdminHealthElement, FakeAdminHealthElement, fetchMock);

  elements.get('health-check-button')?.listeners.get('click')?.();
  await vi.waitFor(() => {
    expect(elements.get('health-cards')?.innerHTML).not.toBe('');
  });

  return {
    cardsHtml: elements.get('health-cards')?.innerHTML || '',
    overallStatus: elements.get('health-overall-chip')?.textContent || '',
  };
}

function extractAdminHealthCard(cardsHtml: string, label: string): string {
  const labelIndex = cardsHtml.indexOf(`>${label}</p>`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);
  const cardStart = cardsHtml.lastIndexOf('<article', labelIndex);
  const cardEnd = cardsHtml.indexOf('</article>', labelIndex);
  expect(cardStart).toBeGreaterThanOrEqual(0);
  expect(cardEnd).toBeGreaterThan(cardStart);
  return cardsHtml.slice(cardStart, cardEnd);
}

describe('admin health metrics conversion', () => {
  beforeEach(() => {
    mocks.getFunnelRollup.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { caseName: 'opens without submissions', pageViews: 100, formOpened: 40, formSubmitted: 0 },
    { caseName: 'submissions without opens', pageViews: 100, formOpened: 0, formSubmitted: 2 },
    { caseName: 'more submissions than opens', pageViews: 100, formOpened: 2, formSubmitted: 3 },
    { caseName: 'no events', pageViews: 0, formOpened: 0, formSubmitted: 0 },
  ])('keeps raw counters for $caseName without claiming conversion health', async (counts) => {
    mockFunnelRollup(counts.pageViews, counts.formOpened, counts.formSubmitted);

    const result = await buildMetricsHealthCheck('bearer', { strictMode: true });

    expect(result.status).toBe(200);
    if ('code' in result.payload) throw new Error(`unexpected metrics error: ${result.payload.code}`);
    expect(result.payload.ok).toBe(true);
    expect(result.payload.sourceAvailable).toBe(true);
    expect(result.payload.totals).toEqual({
      pageViews: counts.pageViews,
      formOpened: counts.formOpened,
      formSubmitted: counts.formSubmitted,
      conversionRate: null,
    });
    expect(result.payload.conversion).toEqual({
      available: false,
      reason: 'CONSENT_SCOPE_MISMATCH',
    });
    expect(result.payload.totals).not.toHaveProperty('openedRate');
    expect(result.payload.totals).not.toHaveProperty('submitRate');
    expect(result.payload).not.toHaveProperty('alerts');
  });

  it('keeps a statistics source read error as a technical failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getFunnelRollup.mockRejectedValue(new Error('statistics source unavailable'));

    const result = await buildMetricsHealthCheck('bearer');
    const summary = buildAdminHealthSummary(createHealthyChecks({ metrics: result }), 'bearer');

    expect(result.status).toBe(500);
    if (!('code' in result.payload)) throw new Error('expected metrics error payload');
    expect(result.payload.code).toBe('INTERNAL_ERROR');
    expect(summary.status).toBe('degraded');
    expect(summary.snapshot.ok).toBe(false);
    expect(summary.conversion).toEqual({
      available: false,
      reason: 'SOURCE_UNAVAILABLE',
    });
  });

  it('selects the conversion message from the summary reason', async () => {
    const consentMismatch = buildAdminHealthAggregatePayload('bearer', createHealthyChecks());
    const consentRender = await renderAdminHealth(consentMismatch);
    const consentCard = extractAdminHealthCard(consentRender.cardsHtml, 'Conversion');

    expect(consentRender.overallStatus).toBe('OK');
    expect(consentCard).toContain('>N/A</p>');
    expect(consentCard).toContain('Конверсия: нет сопоставимых данных');
    expect(consentCard).not.toContain('0%');

    const sourceFailures = [
      {
        status: 500,
        payload: {
          ok: false as const,
          service: 'lead-metrics',
          authMethod: 'bearer' as const,
          code: 'INTERNAL_ERROR' as const,
          checkedAtMs: 1,
          latencyMs: 0,
        },
      },
      {
        status: 503,
        payload: {
          ok: false as const,
          service: 'lead-metrics',
          authMethod: 'bearer' as const,
          code: 'TIMEOUT' as const,
          timedOut: true,
          timeoutMs: 60,
          checkedAtMs: 1,
          latencyMs: 0,
        },
      },
    ];

    for (const metrics of sourceFailures) {
      const sourceUnavailable = buildAdminHealthAggregatePayload('bearer', createHealthyChecks({ metrics }));
      const sourceRender = await renderAdminHealth(sourceUnavailable);
      const sourceCard = extractAdminHealthCard(sourceRender.cardsHtml, 'Statistics source');
      const conversionCard = extractAdminHealthCard(sourceRender.cardsHtml, 'Conversion');

      expect(sourceRender.overallStatus).toBe('DEGRADED');
      expect(sourceCard).toContain('>FAIL</p>');
      expect(conversionCard).toContain('>N/A</p>');
      expect(conversionCard).toContain('Конверсия: источник статистики недоступен');
    }
  });
});

function createHealthyChecks(overrides: Partial<AdminHealthAggregateChecks> = {}): AdminHealthAggregateChecks {
  return {
    system: {
      status: 200,
      payload: {
        ok: true,
        service: 'system',
        authMethod: 'bearer',
        now: 1,
        runtimeConfig: {
          trustProxyHeaders: {
            contact: false,
            track: false,
            admin: false,
          },
        },
        tokenConfigured: true,
        allowlistConfigured: false,
        invalidAllowlistEntriesCount: 0,
        trustProxyHeaders: false,
        checkedAtMs: 1,
        latencyMs: 0,
      },
    },
    worker: {
      status: 200,
      payload: {
        ok: true,
        service: 'lead-worker',
        status: 'ok',
        authMethod: 'bearer',
        now: 1,
        dependencies: {
          workerTokenConfigured: true,
          redisConfigured: true,
          webhookConfigured: true,
          webhookSecretConfigured: true,
          alertChannelConfigured: true,
          alertEndpointReachable: true,
          smartCaptchaRequired: false,
          smartCaptchaReady: true,
          workerPaused: false,
        },
        runtime: {
          ok: true,
          redisLive: true,
          heartbeat: {
            state: 'cycling',
            ageMs: 1000,
            staleAfterMs: 60_000,
            value: {
              lastCycleAt: new Date(0).toISOString(),
              status: 'ok',
              processed: 0,
              delivered: 0,
              error: '',
            },
          },
          oldestPending: {
            ageMs: null,
            state: 'empty',
            thresholdsMs: {
              normal: 60_000,
              warning: 120_000,
              critical: 600_000,
            },
          },
        },
        checkedAtMs: 1,
        latencyMs: 0,
      },
    },
    pipeline: {
      status: 200,
      payload: {
        ok: true,
        service: 'lead-pipeline',
        strictMode: false,
        authMethod: 'bearer',
        metricsDataSource: 'redis',
        generatedAtMs: 1,
        retryRateLastHour: 0,
        dlqLastHour: 0,
        dlqLast24Hours: 0,
        p95LatencyMs: null,
        queueDepth: 0,
        queueBackpressureThreshold: 1000,
        workerPaused: false,
        counters: {},
        alerts: {
          dlqIncident: false,
          retryRateWarning: false,
          retryRateAlertThreshold: 0.1,
          alertChannelConfigured: true,
          alertEndpointReachable: true,
          queueBackpressure: false,
        },
        checkedAtMs: 1,
        latencyMs: 0,
      },
    },
    metrics: {
      status: 200,
      payload: {
        ok: true,
        service: 'lead-metrics',
        strictMode: false,
        authMethod: 'bearer',
        city: null,
        generatedAtMs: 1,
        dataSource: 'redis',
        sourceAvailable: true,
        bucket: '2026-03-08',
        span: 'day',
        totals: {
          pageViews: 100,
          formOpened: 40,
          formSubmitted: 10,
          conversionRate: null,
        },
        conversion: {
          available: false,
          reason: 'CONSENT_SCOPE_MISMATCH',
        },
        sampledPages: 4,
        checkedAtMs: 1,
        latencyMs: 0,
      },
    },
    ...overrides,
  };
}

describe('admin health aggregate', () => {
  it('builds an aggregate payload with all checks', () => {
    const payload = buildAdminHealthAggregatePayload('bearer', createHealthyChecks());

    expect(payload.ok).toBe(true);
    expect(Object.keys(payload.checks)).toEqual(['system', 'worker', 'pipeline', 'metrics']);
    expect(payload.summary.status).toBe('ok');
    expect(payload.summary.snapshot.ok).toBe(true);
    expect(payload.summary.conversion).toEqual({
      available: false,
      reason: 'CONSENT_SCOPE_MISMATCH',
    });
    expect(payload.summary.proxyTrust.label).toBe('disabled');
    expect(payload.checks.metrics.payload.checkedAtMs).toBe(1);
    expect(payload.checks.metrics.payload.latencyMs).toBe(0);
  });

  it('marks system auth issues as warning without degrading proxy-trust defaults', () => {
    const checks = createHealthyChecks({
      system: {
        status: 200,
        payload: {
          ok: true,
          service: 'system',
          authMethod: 'session',
          now: 1,
          runtimeConfig: {
            trustProxyHeaders: {
              contact: false,
              track: false,
              admin: false,
            },
          },
          tokenConfigured: false,
          allowlistConfigured: true,
          invalidAllowlistEntriesCount: 0,
          trustProxyHeaders: false,
          checkedAtMs: 1,
          latencyMs: 0,
        },
      },
    });

    const summary = buildAdminHealthSummary(checks, 'session');

    expect(summary.status).toBe('warning');
    expect(summary.ok).toBe(false);
    expect(summary.degraded).toBe(false);
    expect(summary.systemAuth.status).toBe('WARNING');
    expect(summary.proxyTrust.label).toBe('disabled');
  });

  it('marks partial check failures as degraded while preserving other check payloads', () => {
    const payload = buildAdminHealthAggregatePayload(
      'bearer',
      createHealthyChecks({
        metrics: {
          status: 500,
          payload: {
            ok: false,
            service: 'lead-metrics',
            authMethod: 'bearer',
            code: 'INTERNAL_ERROR',
            checkedAtMs: 1,
            latencyMs: 0,
          },
        },
      })
    );

    expect(payload.ok).toBe(false);
    expect(payload.summary.status).toBe('degraded');
    expect(payload.checks.system.payload.service).toBe('system');
    expect('code' in payload.checks.metrics.payload && payload.checks.metrics.payload.code).toBe('INTERNAL_ERROR');
  });

  it('keeps the source technically available when conversion is unavailable', () => {
    const payload = buildAdminHealthAggregatePayload('bearer', createHealthyChecks());

    expect(payload.ok).toBe(true);
    expect(payload.summary.status).toBe('ok');
    expect(payload.summary.snapshot).toEqual({
      ok: true,
      label: 'OK',
      source: 'redis',
    });
    expect(payload.summary.conversion).toEqual({
      available: false,
      reason: 'CONSENT_SCOPE_MISMATCH',
    });
  });

  it('treats Redis fallback as degraded independently of conversion availability', () => {
    const baseChecks = createHealthyChecks();
    const pipelinePayload = baseChecks.pipeline.payload;
    if (!('metricsDataSource' in pipelinePayload)) throw new Error('pipeline fixture missing');

    const summary = buildAdminHealthSummary(
      createHealthyChecks({
        pipeline: {
          status: 200,
          payload: {
            ...pipelinePayload,
            metricsDataSource: 'memory',
          },
        },
      }),
      'bearer'
    );

    expect(summary.status).toBe('degraded');
    expect(summary.redis.ok).toBe(false);
    expect(summary.snapshot.ok).toBe(true);
    expect(summary.conversion.available).toBe(false);
  });

  it('treats pipeline queue backpressure as degraded overall even with status 200', () => {
    const payload = buildAdminHealthAggregatePayload(
      'bearer',
      createHealthyChecks({
        pipeline: {
          status: 200,
          payload: {
            ok: false,
            service: 'lead-pipeline',
            strictMode: false,
            authMethod: 'bearer',
            metricsDataSource: 'redis',
            generatedAtMs: 1,
            retryRateLastHour: 0,
            dlqLastHour: 0,
            dlqLast24Hours: 0,
            p95LatencyMs: null,
            queueDepth: 1200,
            queueBackpressureThreshold: 1000,
            workerPaused: false,
            counters: {},
            alerts: {
              dlqIncident: false,
              retryRateWarning: false,
              retryRateAlertThreshold: 0.1,
              alertChannelConfigured: true,
              alertEndpointReachable: true,
              queueBackpressure: true,
            },
            checkedAtMs: 1,
            latencyMs: 0,
          },
        },
      })
    );

    expect(payload.ok).toBe(false);
    expect(payload.summary.status).toBe('degraded');
    expect(payload.summary.worker.label).toContain('queue_backpressure');
    expect(payload.summary.conversion.available).toBe(false);
  });

  it('distinguishes a stale worker heartbeat and reports pending queue age', () => {
    const healthy = createHealthyChecks();
    const workerPayload = healthy.worker.payload;
    if (!('runtime' in workerPayload)) throw new Error('worker runtime fixture missing');

    const checks = createHealthyChecks({
      worker: {
        status: 503,
        payload: {
          ...workerPayload,
          ok: false,
          status: 'degraded',
          runtime: {
            ...workerPayload.runtime,
            ok: false,
            heartbeat: {
              ...workerPayload.runtime.heartbeat,
              state: 'stale',
              ageMs: 61_000,
            },
            oldestPending: {
              ...workerPayload.runtime.oldestPending,
              ageMs: 180_000,
              state: 'warning',
            },
          },
        },
      },
    });

    const summary = buildAdminHealthSummary(checks, 'bearer');

    expect(summary.status).toBe('degraded');
    expect(summary.worker.heartbeatState).toBe('stale');
    expect(summary.worker.oldestPendingState).toBe('warning');
    expect(summary.worker.oldestPendingAgeMs).toBe(180_000);
    expect(summary.worker.label).toContain('heartbeat_stale');
    expect(summary.worker.label).toContain('oldest_pending_warning');
    expect(summary.conversion.available).toBe(false);
  });

  it('marks timed out checks as degraded and exposes timeout metadata', async () => {
    const result = await runHealthCheckWithTimeout<never>(
      'lead-metrics',
      'bearer',
      () => new Promise<never>(() => {}),
      { timeoutMs: 60 }
    );

    expect(result.status).toBe(503);
    expect(result.payload.code).toBe('TIMEOUT');
    expect(result.payload.timedOut).toBe(true);
    expect(result.payload.timeoutMs).toBe(60);
    expect(result.payload.checkedAtMs).toBeTypeOf('number');
    expect(result.payload.latencyMs).toBeGreaterThanOrEqual(0);

    const summary = buildAdminHealthSummary(createHealthyChecks({ metrics: result }), 'bearer');
    expect(summary.status).toBe('degraded');
    expect(summary.snapshot.ok).toBe(false);
    expect(summary.conversion.reason).toBe('SOURCE_UNAVAILABLE');
  });
});
