import { beforeEach, afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  redisAvailable: false,
  enqueueCalls: 0,
  webhookCalls: 0,
  acceptedByIdempotency: new Map<
    string,
    { response: { success: true; leadId: string; receivedAt: string }; payloadFingerprint: string }
  >(),
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
      async ({
        idempotencyHash,
        successResponse,
        leadRecord,
      }: {
        idempotencyHash: string;
        successResponse: { success: true; leadId: string; receivedAt: string };
        leadRecord: { payloadFingerprint: string };
      }) => {
        state.enqueueCalls += 1;
        const existing = state.acceptedByIdempotency.get(idempotencyHash);
        if (existing) {
          if (existing.payloadFingerprint !== leadRecord.payloadFingerprint) {
            return { duplicate: false as const, conflict: true as const };
          }
          return { duplicate: true as const, response: existing.response };
        }
        state.acceptedByIdempotency.set(idempotencyHash, {
          response: successResponse,
          payloadFingerprint: leadRecord.payloadFingerprint,
        });
        return { duplicate: false as const };
      }
    ),
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

function makeRequest(idempotencyKey: string | undefined, body: unknown = payload) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (idempotencyKey) headers.set('X-Idempotency-Key', idempotencyKey);
  return new Request('https://mebel-irkutsk.ru/api/leads', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function makeRawJsonRequest(body: string) {
  return new Request('https://mebel-irkutsk.ru/api/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `invalid-json-${crypto.randomUUID()}`,
    },
    body,
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

test.each([
  ['null', 'null'],
  ['array', '[]'],
  ['string', '"not-an-object"'],
  ['malformed JSON', '{"name":'],
])('returns 400 INVALID_PAYLOAD for %s request bodies', async (_label, rawBody) => {
  const response = await post({ request: makeRawJsonRequest(rawBody) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ success: false, code: 'INVALID_PAYLOAD' });
  expect(state.enqueueCalls).toBe(0);
});

test('returns 409 when one idempotency key is reused with different lead content', async () => {
  state.redisAvailable = true;
  const idempotencyKey = `conflict-${crypto.randomUUID()}`;

  const accepted = await post({ request: makeRequest(idempotencyKey) });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ success: true });

  const conflict = await post({
    request: makeRequest(idempotencyKey, {
      ...payload,
      phone: '+7 (950) 555-01-02',
      message: 'Different business payload for the same key',
    }),
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ success: false, code: 'IDEMPOTENCY_CONFLICT' });
  expect(state.enqueueCalls).toBe(2);
  expect(state.webhookCalls).toBe(0);
});

test('accepts independent requests without an idempotency key even when their content overlaps', async () => {
  state.redisAvailable = true;

  const first = await post({
    request: makeRequest(undefined, {
      ...payload,
      name: 'Synthetic owner one',
      smartCaptchaToken: `no-key-one-${crypto.randomUUID()}`,
    }),
  });
  const second = await post({
    request: makeRequest(undefined, {
      ...payload,
      name: 'Synthetic owner two',
      smartCaptchaToken: `no-key-two-${crypto.randomUUID()}`,
    }),
  });

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const firstBody = (await first.json()) as { leadId: string };
  const secondBody = (await second.json()) as { leadId: string };
  expect(firstBody.leadId).not.toBe(secondBody.leadId);
  expect(state.acceptedByIdempotency.size).toBe(2);
  expect(new Set(state.acceptedByIdempotency.keys()).size).toBe(2);
});

test('accepts fully identical business payloads without an idempotency key as separate leads', async () => {
  state.redisAvailable = true;
  const firstPayload = { ...payload, smartCaptchaToken: `no-key-identical-one-${crypto.randomUUID()}` };
  const secondPayload = { ...payload, smartCaptchaToken: `no-key-identical-two-${crypto.randomUUID()}` };

  const first = await post({ request: makeRequest(undefined, firstPayload) });
  const second = await post({ request: makeRequest(undefined, secondPayload) });
  const firstBody = (await first.json()) as { leadId: string };
  const secondBody = (await second.json()) as { leadId: string };

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(firstBody.leadId).not.toBe(secondBody.leadId);
  expect(state.acceptedByIdempotency.size).toBe(2);
});

test('keeps explicit-key replay and conflict semantics unchanged', async () => {
  state.redisAvailable = true;
  const idempotencyKey = `explicit-contract-${crypto.randomUUID()}`;
  const firstPayload = { ...payload, smartCaptchaToken: `explicit-one-${crypto.randomUUID()}` };
  const replayPayload = { ...payload, smartCaptchaToken: `explicit-two-${crypto.randomUUID()}` };

  const first = await post({ request: makeRequest(idempotencyKey, firstPayload) });
  const replay = await post({ request: makeRequest(idempotencyKey, replayPayload) });
  const firstBody = (await first.json()) as { leadId: string };
  const replayBody = (await replay.json()) as { leadId: string; duplicate?: boolean };

  expect(first.status).toBe(200);
  expect(replay.status).toBe(200);
  expect(replayBody).toMatchObject({ leadId: firstBody.leadId, duplicate: true });
  expect(state.acceptedByIdempotency.size).toBe(1);

  const conflict = await post({
    request: makeRequest(idempotencyKey, {
      ...payload,
      message: 'Changed synthetic business payload',
      smartCaptchaToken: `explicit-three-${crypto.randomUUID()}`,
    }),
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ success: false, code: 'IDEMPOTENCY_CONFLICT' });
  expect(state.acceptedByIdempotency.size).toBe(1);
});
