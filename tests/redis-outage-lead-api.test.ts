import { beforeEach, afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  redisAvailable: false,
  enqueueCalls: 0,
  webhookCalls: 0,
  acceptedByIdempotency: new Set<string>(),
}));

const storeMock = vi.hoisted(() => ({
  getLeadStore: vi.fn(() => ({
    mode: 'redis' as const,
    hasDurableStorage: true,
    checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, retryAfterSec: 0 })),
    getQueueDepth: vi.fn(async () => {
      if (!state.redisAvailable) throw new Error('REDIS_NETWORK_ERROR');
      return 0;
    }),
    enqueueLeadWithIdempotency: vi.fn(
      async ({ idempotencyHash, successResponse }: { idempotencyHash: string; successResponse: { success: true } }) => {
      state.enqueueCalls += 1;
      if (state.acceptedByIdempotency.has(idempotencyHash)) {
        return { duplicate: true as const, response: successResponse };
      }
      state.acceptedByIdempotency.add(idempotencyHash);
      return { duplicate: false as const };
    }),
  })),
}));

vi.mock('~/server/leads/store', () => ({
  getLeadStore: storeMock.getLeadStore,
  hasRedisLeadStoreConfig: () => true,
  isRedisRuntimeError: (error: unknown) => error instanceof Error && error.message === 'REDIS_NETWORK_ERROR',
}));

vi.mock('~/server/leads/webhook', () => ({
  isWebhookConfigured: () => true,
  hasWebhookSecretConfig: () => true,
  deliverLeadWebhook: vi.fn(async () => {
    state.webhookCalls += 1;
    return { ok: true, status: 200 };
  }),
}));

vi.mock('~/server/leads/alerts', () => ({
  notifyLeadStoreDegraded: vi.fn(async () => false),
  notifyBotProtectionDegraded: vi.fn(async () => false),
}));

const { post } = await import('~/pages/api/leads');

const payload = {
  name: 'Synthetic Redis test',
  phone: '+7 (912) 345-67-89',
  message: 'Synthetic integration payload',
  consent: true,
  smartCaptchaToken: 'synthetic-valid-token',
};

function makeRequest(idempotencyKey: string) {
  return new Request('https://mebel-irkutsk.ru/api/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('REDIS_URL', 'redis://synthetic-test');
  vi.stubEnv('CONTACT_SMARTCAPTCHA_REQUIRED', 'true');
  vi.stubEnv('SMARTCAPTCHA_CLIENT_KEY', 'ysc1_synthetic_integration_key');
  vi.stubEnv('SMARTCAPTCHA_SERVER_KEY', 'ysc2_synthetic_integration_key');
  vi.stubEnv('SMARTCAPTCHA_ALLOWED_HOSTS', 'mebel-irkutsk.ru');
  vi.stubEnv('CONTACT_LEAD_BACKUP_ENABLED', 'false');
  vi.stubEnv('CONTACT_WORKER_URL', '');
  vi.stubEnv('CONTACT_WORKER_TOKEN', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ status: 'ok', host: 'mebel-irkutsk.ru' }))
  );
  state.redisAvailable = false;
  state.enqueueCalls = 0;
  state.webhookCalls = 0;
  state.acceptedByIdempotency.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('fails closed on Redis outage, then recovers with idempotency and no webhook side effect', async () => {
  const idempotencyKey = 'synthetic-redis-outage-idempotency';

  const unavailable = await post({ request: makeRequest(idempotencyKey) });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({
    success: false,
    code: 'LEAD_STORE_UNAVAILABLE',
  });
  expect(state.enqueueCalls).toBe(0);
  expect(state.webhookCalls).toBe(0);

  state.redisAvailable = true;
  const recovered = await post({ request: makeRequest(idempotencyKey) });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ success: true });
  expect(state.enqueueCalls).toBe(1);
  expect(state.webhookCalls).toBe(0);

  const duplicate = await post({ request: makeRequest(idempotencyKey) });
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({ success: true, duplicate: true });
  expect(state.enqueueCalls).toBe(2);
  expect(state.webhookCalls).toBe(0);
});
