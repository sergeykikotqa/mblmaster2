import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { assertProductionContactWebhookUrl, resolveContactWebhookSetting } from '../scripts/check-runtime-config.mjs';
import { deliverLeadWebhook } from '../src/server/leads/webhook';

const SECRET = 'synthetic-webhook-secret-value';
const SYNTHETIC_WEBHOOK_URL = 'https://mbl-test-webhook.invalid/webhook';
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const PAYLOAD = {
  lead: {
    leadId: 'lead-security-test',
    phone: 'SENSITIVE_PHONE_SENTINEL',
  },
};

function setWebhook(url: string, options: { legacy?: boolean } = {}) {
  delete process.env.CONTACT_WEBHOOK_URL;
  delete process.env.CONTACT_WEBHOOK;
  if (options.legacy) process.env.CONTACT_WEBHOOK = url;
  else process.env.CONTACT_WEBHOOK_URL = url;
  process.env.CONTACT_WEBHOOK_SECRET = SECRET;
}

function runTestWebhookProxy(publicUrl: string, localTarget: string) {
  return spawnSync(process.execPath, ['--require', './scripts/test-webhook-fetch-proxy.cjs', '--eval', ''], {
    cwd: process.cwd(),
    env: {
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      MBL_TEST_WEBHOOK_HTTPS_URL: publicUrl,
      MBL_TEST_WEBHOOK_HTTP_TARGET: localTarget,
    },
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
}

beforeEach(() => {
  delete process.env.CONTACT_WEBHOOK_URL;
  delete process.env.CONTACT_WEBHOOK;
  delete process.env.CONTACT_WEBHOOK_SECRET;
  delete process.env.CONTACT_WEBHOOK_ALLOW_INSECURE_TEST_HTTP;
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.CONTACT_WEBHOOK_URL;
  delete process.env.CONTACT_WEBHOOK;
  delete process.env.CONTACT_WEBHOOK_SECRET;
  delete process.env.CONTACT_WEBHOOK_ALLOW_INSECURE_TEST_HTTP;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  vi.unstubAllGlobals();
});

test('production config accepts an external HTTPS webhook', () => {
  expect(assertProductionContactWebhookUrl('https://hooks.vendor.ru/leads').protocol).toBe('https:');
});

test('production config rejects external HTTP for primary and legacy variables', () => {
  expect(() => assertProductionContactWebhookUrl('http://hooks.vendor.ru/leads')).toThrow(/must use HTTPS/);
  const legacy = resolveContactWebhookSetting({ CONTACT_WEBHOOK: 'http://legacy.vendor.ru/leads' });
  expect(legacy.envName).toBe('CONTACT_WEBHOOK');
  expect(() => assertProductionContactWebhookUrl(legacy.value, legacy.envName)).toThrow(
    /CONTACT_WEBHOOK must use HTTPS/
  );
});

test('direct delivery accepts HTTPS and uses manual redirect handling', async () => {
  setWebhook('https://hooks.vendor.ru/leads');
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 })
  );
  vi.stubGlobal('fetch', fetchMock);

  await expect(deliverLeadWebhook(PAYLOAD)).resolves.toEqual({ ok: true, status: 204 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'manual' });
});

test('direct delivery rejects HTTP before serializing or sending client payload', async () => {
  setWebhook('http://hooks.vendor.ru/leads');
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const payloadThatMustNotBeSerialized = {
    ...PAYLOAD,
    toJSON() {
      throw new Error('CLIENT_PAYLOAD_WAS_SERIALIZED');
    },
  };

  const result = await deliverLeadWebhook(payloadThatMustNotBeSerialized);
  expect(result).toMatchObject({ ok: false, code: 'WEBHOOK_INSECURE_TRANSPORT' });
  expect(JSON.stringify(result)).not.toContain('SENSITIVE_PHONE_SENTINEL');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('legacy CONTACT_WEBHOOK cannot bypass the direct HTTPS requirement', async () => {
  setWebhook('http://legacy.vendor.ru/leads', { legacy: true });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  await expect(deliverLeadWebhook(PAYLOAD)).resolves.toMatchObject({
    ok: false,
    code: 'WEBHOOK_INSECURE_TRANSPORT',
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('HTTPS redirects are not followed and never forward payload to HTTP', async () => {
  setWebhook('https://hooks.vendor.ru/leads');
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('', {
        status: 302,
        headers: { Location: 'http://downgrade.vendor.ru/collect' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);

  await expect(deliverLeadWebhook(PAYLOAD)).resolves.toMatchObject({
    ok: false,
    code: 'WEBHOOK_REDIRECT_BLOCKED',
    status: 302,
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
});

test('HTTP cannot be enabled by test flags or NODE_ENV changes', async () => {
  setWebhook('http://127.0.0.1:49123/webhook');
  process.env.NODE_ENV = 'test';
  process.env.CONTACT_WEBHOOK_ALLOW_INSECURE_TEST_HTTP = 'isolated-local-mock';
  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  expect(() => assertProductionContactWebhookUrl(process.env.CONTACT_WEBHOOK_URL || '')).toThrow(/must use HTTPS/);
  await expect(deliverLeadWebhook(PAYLOAD)).resolves.toMatchObject({
    ok: false,
    code: 'WEBHOOK_INSECURE_TRANSPORT',
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('test webhook proxy permits only the fixed synthetic endpoint mapped to loopback', () => {
  const result = runTestWebhookProxy(SYNTHETIC_WEBHOOK_URL, 'http://127.0.0.1:49123/webhook');
  expect(result.status).toBe(0);
});

test('test webhook proxy rejects an arbitrary public HTTPS endpoint', () => {
  const result = runTestWebhookProxy('https://real.example/webhook', 'http://127.0.0.1:49123/webhook');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('only accepts the fixed synthetic endpoint');
});

test('test webhook proxy rejects a non-loopback HTTP target', () => {
  const result = runTestWebhookProxy(SYNTHETIC_WEBHOOK_URL, 'http://192.0.2.10:49123/webhook');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('credential-free loopback HTTP receiver');
});

test('test webhook proxy rejects credentials in the loopback target', () => {
  const result = runTestWebhookProxy(SYNTHETIC_WEBHOOK_URL, 'http://user:password@127.0.0.1:49123/webhook');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('credential-free loopback HTTP receiver');
});
