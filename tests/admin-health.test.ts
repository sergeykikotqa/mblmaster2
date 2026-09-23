import { describe, expect, it } from 'vitest';

import {
  buildAdminHealthAggregatePayload,
  buildAdminHealthSummary,
  runHealthCheckWithTimeout,
  type AdminHealthAggregateChecks,
} from '../src/server/admin/health-checks';

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
        bucket: '2026-03-08',
        span: 'day',
        totals: {
          pageViews: 100,
          formOpened: 40,
          formSubmitted: 10,
          openedRate: 0.4,
          submitRate: 0.25,
          conversionRate: 0.1,
        },
        alerts: {
          lowConversion: false,
          minConversionRate: 0.03,
          minPageViews: 30,
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

  it('treats fulfilled degraded checks as degraded overall, not OK', () => {
    const payload = buildAdminHealthAggregatePayload(
      'bearer',
      createHealthyChecks({
        metrics: {
          status: 200,
          payload: {
            ok: false,
            service: 'lead-metrics',
            strictMode: false,
            authMethod: 'bearer',
            city: null,
            generatedAtMs: 1,
            dataSource: 'memory',
            bucket: '2026-03-08',
            span: 'day',
            totals: {
              pageViews: 100,
              formOpened: 10,
              formSubmitted: 1,
              openedRate: 0.1,
              submitRate: 0.1,
              conversionRate: 0.01,
            },
            alerts: {
              lowConversion: true,
              minConversionRate: 0.03,
              minPageViews: 30,
            },
            sampledPages: 2,
            checkedAtMs: 1,
            latencyMs: 0,
          },
        },
      })
    );

    expect(payload.ok).toBe(false);
    expect(payload.summary.status).toBe('degraded');
    expect(payload.summary.snapshot.label).toBe('DEGRADED (memory)');
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
  });
});
