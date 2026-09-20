import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { post } from '~/pages/api/leads';
import { getLeadStore } from '~/server/leads/store';

const TEST_HOST = 'mebel-irkutsk.ru';
const BASE_PAYLOAD = {
  name: 'Тестовая заявка',
  phone: '+7 (912) 345-67-89',
  message: 'Локальный тест без реальных клиентских данных',
  consent: true,
  smartCaptchaToken: 'mock-once-token',
};

function request(payload: Record<string, unknown>, idempotencyKey = `mock-${crypto.randomUUID()}`): Request {
  return new Request('https://mebel-irkutsk.ru/api/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
}

async function submit(payload: Record<string, unknown>, idempotencyKey?: string) {
  const response = await post({ request: request(payload, idempotencyKey) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('CONTACT_SMARTCAPTCHA_REQUIRED', 'true');
  vi.stubEnv('SMARTCAPTCHA_CLIENT_KEY', 'ysc1_local_integration_mock_key');
  vi.stubEnv('SMARTCAPTCHA_SERVER_KEY', 'ysc2_local_integration_mock_key');
  vi.stubEnv('SMARTCAPTCHA_ALLOWED_HOSTS', TEST_HOST);
  vi.stubEnv('CONTACT_LEAD_BACKUP_ENABLED', 'false');
  vi.stubEnv('CONTACT_WORKER_TOKEN', '');
  vi.stubEnv('CONTACT_RATE_LIMIT_MAX', '100');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('missing, expired, reused and unavailable SmartCaptcha tokens never enqueue a lead', async () => {
  const store = getLeadStore();
  const initialDepth = await store.getQueueDepth();
  const tokensSeen = new Set<string>();
  let outage = false;

  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (outage) return new Response('', { status: 503 });
    const token = new URLSearchParams(String(init?.body || '')).get('token') || '';
    if (token === 'expired-token' || tokensSeen.has(token)) {
      return Response.json({ status: 'failed', message: 'Invalid or expired Token.' });
    }
    tokensSeen.add(token);
    return Response.json({ status: 'ok', host: TEST_HOST });
  });
  vi.stubGlobal('fetch', fetchMock);

  const missing = await submit({ ...BASE_PAYLOAD, smartCaptchaToken: '' });
  expect(missing).toMatchObject({ status: 400, body: { success: false, code: 'BOT_PROTECTION_REQUIRED' } });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await store.getQueueDepth()).toBe(initialDepth);

  const expired = await submit({ ...BASE_PAYLOAD, smartCaptchaToken: 'expired-token' });
  expect(expired).toMatchObject({ status: 400, body: { success: false, code: 'BOT_PROTECTION_FAILED' } });
  expect(await store.getQueueDepth()).toBe(initialDepth);

  outage = true;
  const unavailable = await submit({ ...BASE_PAYLOAD, smartCaptchaToken: 'outage-token' });
  expect(unavailable).toMatchObject({ status: 503, body: { success: false, code: 'BOT_PROTECTION_UNAVAILABLE' } });
  expect(await store.getQueueDepth()).toBe(initialDepth);

  outage = false;
  const sharedIdempotencyKey = `one-time-${crypto.randomUUID()}`;
  const accepted = await submit(BASE_PAYLOAD, sharedIdempotencyKey);
  expect(accepted).toMatchObject({ status: 200, body: { success: true } });
  expect(await store.getQueueDepth()).toBe(initialDepth + 1);

  const reused = await submit(BASE_PAYLOAD, sharedIdempotencyKey);
  expect(reused).toMatchObject({ status: 400, body: { success: false, code: 'BOT_PROTECTION_FAILED' } });
  expect(await store.getQueueDepth()).toBe(initialDepth + 1);

  const noConsent = await submit({ ...BASE_PAYLOAD, smartCaptchaToken: 'new-token', consent: false });
  expect(noConsent).toMatchObject({ status: 400, body: { success: false, code: 'CONSENT_REQUIRED' } });
  expect(await store.getQueueDepth()).toBe(initialDepth + 1);
});
