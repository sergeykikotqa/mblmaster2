import { authorizeAdminRequest } from '~/server/admin/auth';
import { getOwnerMetricsSummary, type OwnerMetricsPeriod } from '~/server/metrics/owner-summary';
import { hasRedisConfig, redisCommand } from '~/server/redis/client';

export const prerender = false;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  Vary: 'Authorization',
};

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 120) end
return count
`;

function json(status: number, payload: object, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function configuredCredential() {
  const token = String(process.env.MBL_OWNER_METRICS_TOKEN || '').trim();
  if (
    token.length < 24 ||
    /replace|example|changeme|placeholder|test/i.test(token) ||
    token === String(process.env.METRICS_ADMIN_TOKEN || '').trim() ||
    token === String(process.env.MBL_MONITORING_TOKEN || '').trim()
  ) {
    return null;
  }
  return token;
}

function rateLimitKey(minute: number) {
  const prefix = String(process.env.CONTACT_REDIS_PREFIX || 'lead')
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, '-');
  return `${prefix || 'lead'}:ratelimit:owner-metrics:${minute}`;
}

export async function get({ request, clientAddress }: { request: Request; clientAddress?: string }) {
  const token = configuredCredential();
  if (!token) return json(503, { ok: false, code: 'SERVICE_CREDENTIAL_NOT_CONFIGURED' });

  const auth = await authorizeAdminRequest(request, {
    scope: 'owner_metrics_read_api',
    clientAddress,
    rateLimitScope: 'monitoring:owner-metrics',
    token,
    tokenConfigName: 'MBL_OWNER_METRICS_TOKEN',
    allowAllowlist: false,
    allowDevBypass: false,
    requireToken: true,
  });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const parameters = [...url.searchParams.keys()];
  const period = url.searchParams.get('period');
  if (parameters.length !== 1 || parameters[0] !== 'period' || (period !== 'today' && period !== 'week')) {
    return json(400, { ok: false, code: 'PERIOD_INVALID' });
  }
  if (!hasRedisConfig()) return json(503, { ok: false, code: 'METRICS_SOURCE_UNAVAILABLE' });

  try {
    const minute = Math.floor(Date.now() / 60_000);
    const count = Number(await redisCommand('EVAL', RATE_LIMIT_SCRIPT, 1, rateLimitKey(minute)));
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('RATE_LIMIT_STORE_INVALID');
    if (count > 20) return json(429, { ok: false, code: 'RATE_LIMITED' }, { 'Retry-After': '60' });

    const report = await getOwnerMetricsSummary(period as OwnerMetricsPeriod);
    return json(200, report);
  } catch {
    return json(503, { ok: false, code: 'METRICS_SOURCE_UNAVAILABLE' });
  }
}

export const GET = get;
