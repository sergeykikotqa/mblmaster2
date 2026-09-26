import { createHealthResponse, probeRedisReadiness } from '~/server/health/runtime';

export const prerender = false;

export async function GET(): Promise<Response> {
  const readiness = await probeRedisReadiness();

  return readiness.ok
    ? createHealthResponse(200, { ok: true, status: 'ready' })
    : createHealthResponse(503, { ok: false, status: 'not_ready' });
}
