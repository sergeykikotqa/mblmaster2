import { getLeadStore, hasRedisLeadStoreConfig } from '~/server/leads/store';

export const prerender = false;

export async function get({ request }: { request: Request }) {
  void request;
  const now = Date.now();

  const redisConfigured = hasRedisLeadStoreConfig();
  const redisRequired = import.meta.env.PROD;
  let redisOk = false;
  let redisMode: 'redis' | 'memory' = redisConfigured ? 'redis' : 'memory';
  let redisCode = redisConfigured ? 'REDIS_UNKNOWN' : 'REDIS_NOT_CONFIGURED';
  let redisCircuitOpen = false;

  if (redisConfigured) {
    try {
      const store = getLeadStore();
      redisMode = store.mode;
      const ping = await store.ping();
      redisOk = ping.ok;
      redisCode = ping.code;
      redisCircuitOpen = ping.circuitOpen;
    } catch (error) {
      redisOk = false;
      redisCode = error instanceof Error ? error.message : 'REDIS_HEALTH_UNKNOWN_ERROR';
      redisCircuitOpen = redisCode === 'REDIS_CIRCUIT_OPEN';
    }
  } else if (!redisRequired) {
    redisOk = true;
    redisCode = 'REDIS_OPTIONAL_IN_NON_PROD';
  }

  const ok = redisRequired ? redisOk : true;
  const status = ok ? 200 : 503;

  return new Response(
    JSON.stringify({
      ok,
      service: 'seo-lead-pipeline',
      now,
      redis: {
        configured: redisConfigured,
        required: redisRequired,
        ok: redisOk,
        mode: redisMode,
        code: redisCode,
        circuitOpen: redisCircuitOpen,
        degraded: !redisOk,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }
  );
}

export const GET = get;
