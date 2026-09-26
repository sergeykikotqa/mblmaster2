import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  summary: vi.fn(),
  hasRedis: vi.fn(),
  redis: vi.fn(),
}));

vi.mock('~/server/admin/auth', () => ({ authorizeAdminRequest: mocks.authorize }));
vi.mock('~/server/metrics/owner-summary', () => ({ getOwnerMetricsSummary: mocks.summary }));
vi.mock('~/server/redis/client', () => ({ hasRedisConfig: mocks.hasRedis, redisCommand: mocks.redis }));

import { get } from '../src/pages/api/monitoring/owner-metrics';

const TOKEN = 'owner-metrics-service-token-strong-123';

function request(query = '?period=today') {
  return new Request(`https://mbl.example/api/monitoring/owner-metrics${query}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

describe('owner metrics read-only API', () => {
  beforeEach(() => {
    process.env.MBL_OWNER_METRICS_TOKEN = TOKEN;
    delete process.env.METRICS_ADMIN_TOKEN;
    delete process.env.MBL_MONITORING_TOKEN;
    mocks.authorize.mockResolvedValue({ ok: true, method: 'bearer' });
    mocks.hasRedis.mockReturnValue(true);
    mocks.redis.mockResolvedValue(1);
    mocks.summary.mockResolvedValue({
      ok: true,
      complete: true,
      period: { kind: 'today', timeZone: 'Asia/Irkutsk' },
      counts: { consentedPageViews: 4, consentedFormOpens: 2, acceptedLeads: 1 },
      conversions: {
        submittedPerOpened: {
          numerator: 1,
          denominator: 2,
          compatible: false,
          rate: null,
          reason: 'CONSENT_SCOPE_MISMATCH',
        },
      },
      source: 'local_funnel',
      scope: 'trusted_public_routes',
      historicalCaptureVerified: false,
    });
  });

  afterEach(() => {
    delete process.env.MBL_OWNER_METRICS_TOKEN;
    delete process.env.METRICS_ADMIN_TOKEN;
    delete process.env.MBL_MONITORING_TOKEN;
    vi.clearAllMocks();
  });

  test('requires a distinct service credential', async () => {
    process.env.MBL_OWNER_METRICS_TOKEN = TOKEN;
    process.env.METRICS_ADMIN_TOKEN = TOKEN;
    const response = await get({ request: request() });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: 'SERVICE_CREDENTIAL_NOT_CONFIGURED' });
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  test('authorizes with only the dedicated credential and returns aggregate data', async () => {
    const response = await get({ request: request(), clientAddress: '127.0.0.1' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      counts: { consentedPageViews: 4, consentedFormOpens: 2, acceptedLeads: 1 },
      conversions: { submittedPerOpened: { compatible: false, rate: null } },
    });
    expect(JSON.stringify(body)).not.toMatch(/name|phone|message|leadId/i);
    expect(mocks.authorize).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        token: TOKEN,
        tokenConfigName: 'MBL_OWNER_METRICS_TOKEN',
        allowAllowlist: false,
        allowDevBypass: false,
        requireToken: true,
      })
    );
  });

  test('rejects unsupported or extra query parameters', async () => {
    expect((await get({ request: request('?period=month') })).status).toBe(400);
    expect((await get({ request: request('?period=today&city=irkutsk') })).status).toBe(400);
  });

  test('does not replace Redis or aggregation failure with zeroes', async () => {
    mocks.summary.mockRejectedValueOnce(new Error('REDIS_NETWORK_ERROR'));
    const response = await get({ request: request() });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: 'METRICS_SOURCE_UNAVAILABLE' });
  });

  test('enforces a shared Redis-backed request limit', async () => {
    mocks.redis.mockResolvedValueOnce(21);
    const response = await get({ request: request() });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(mocks.summary).not.toHaveBeenCalled();
  });
});
