import { getLeadStore, hasRedisLeadStoreConfig } from '~/server/leads/store';

export type RedisReadiness = {
  ok: boolean;
};

export async function probeRedisReadiness(): Promise<RedisReadiness> {
  if (!hasRedisLeadStoreConfig()) return { ok: false };

  try {
    const store = getLeadStore();
    if (store.mode !== 'redis' || !store.hasDurableStorage) return { ok: false };
    const response = await store.ping();
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

export function createHealthResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
