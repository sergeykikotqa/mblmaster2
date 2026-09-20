import { describe, expect, test, vi } from 'vitest';

import {
  isSmartCaptchaReady,
  isSmartCaptchaRequired,
  resolveSmartCaptchaVerifyUrl,
  verifySmartCaptchaToken,
} from '~/server/leads/smartcaptcha';

const TEST_ENV = {
  NODE_ENV: 'production',
  CONTACT_SMARTCAPTCHA_REQUIRED: 'true',
  SMARTCAPTCHA_CLIENT_KEY: 'ysc1_local_integration_mock_key',
  SMARTCAPTCHA_SERVER_KEY: 'ysc2_local_integration_mock_key',
  SMARTCAPTCHA_ALLOWED_HOSTS: 'mebel-irkutsk.ru,www.mebel-irkutsk.ru',
  SMARTCAPTCHA_TIMEOUT_MS: '500',
};

function response(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SmartCaptcha verification contract', () => {
  test('requires both keys and an explicit host allowlist when enabled', () => {
    expect(isSmartCaptchaRequired(TEST_ENV)).toBe(true);
    expect(isSmartCaptchaRequired({ ...TEST_ENV, CONTACT_SMARTCAPTCHA_REQUIRED: 'false' })).toBe(true);
    expect(isSmartCaptchaRequired({ NODE_ENV: 'development' })).toBe(true);
    expect(isSmartCaptchaRequired({ NODE_ENV: 'development', CONTACT_SMARTCAPTCHA_REQUIRED: 'false' })).toBe(false);
    expect(isSmartCaptchaReady(TEST_ENV)).toBe(true);
    expect(isSmartCaptchaReady({ ...TEST_ENV, SMARTCAPTCHA_ALLOWED_HOSTS: '' })).toBe(false);
    expect(isSmartCaptchaReady({ ...TEST_ENV, SMARTCAPTCHA_CLIENT_KEY: '' })).toBe(false);
    expect(isSmartCaptchaReady({ ...TEST_ENV, SMARTCAPTCHA_SERVER_KEY: '' })).toBe(false);
  });

  test('allows a local verification override only with explicit local-test opt-in', () => {
    expect(resolveSmartCaptchaVerifyUrl({ SMARTCAPTCHA_VERIFY_URL: 'https://example.com/validate' })).toBe(
      'https://smartcaptcha.cloud.yandex.ru/validate'
    );
    expect(
      resolveSmartCaptchaVerifyUrl({
        SMARTCAPTCHA_ALLOW_LOCAL_VERIFY_OVERRIDE: 'true',
        SMARTCAPTCHA_VERIFY_URL: 'https://example.com/validate',
      })
    ).toBe('https://smartcaptcha.cloud.yandex.ru/validate');
    expect(
      resolveSmartCaptchaVerifyUrl({
        SMARTCAPTCHA_ALLOW_LOCAL_VERIFY_OVERRIDE: 'true',
        SMARTCAPTCHA_VERIFY_URL: 'http://127.0.0.1:5050/validate',
      })
    ).toBe('http://127.0.0.1:5050/validate');
    expect(
      resolveSmartCaptchaVerifyUrl({
        NODE_ENV: 'production',
        SMARTCAPTCHA_ALLOW_LOCAL_VERIFY_OVERRIDE: 'true',
        SMARTCAPTCHA_VERIFY_URL: 'http://127.0.0.1:5050/validate',
      })
    ).toBe('https://smartcaptcha.cloud.yandex.ru/validate');
  });

  test('uses the official form fields and accepts only a successful allowed host', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const fields = new URLSearchParams(String(init?.body || ''));
      expect(fields.get('secret')).toBe(TEST_ENV.SMARTCAPTCHA_SERVER_KEY);
      expect(fields.get('token')).toBe('one-time-token');
      expect(fields.get('ip')).toBe('203.0.113.7');
      expect(fields.has('response')).toBe(false);
      expect(init?.method).toBe('POST');
      return response(200, { status: 'ok', host: 'www.mebel-irkutsk.ru' });
    });

    const result = await verifySmartCaptchaToken('one-time-token', '203.0.113.7', {
      env: TEST_ENV,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result).toEqual({ ok: true, host: 'www.mebel-irkutsk.ru' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ status: 'failed', message: 'Invalid or expired Token.' }, 'provider_rejected'],
    [{ status: 'ok', host: 'attacker.example' }, 'host_not_allowed'],
    [{ status: 'ok', host: '' }, 'host_missing'],
  ])('rejects expired/reused or wrong-host token without accepting a lead', async (payload, diagnostic) => {
    const result = await verifySmartCaptchaToken('bad-token', '', {
      env: TEST_ENV,
      fetchImpl: (async () => response(200, payload)) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'BOT_PROTECTION_FAILED', diagnostic });
  });

  test('never accepts a successful provider response without an explicit host allowlist', async () => {
    const result = await verifySmartCaptchaToken('token', '', {
      env: { ...TEST_ENV, SMARTCAPTCHA_ALLOWED_HOSTS: '' },
      fetchImpl: (async () => response(200, { status: 'ok', host: 'mebel-irkutsk.ru' })) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'BOT_PROTECTION_FAILED' });
  });

  test.each([500, 429])('fails closed on provider HTTP %i', async (status) => {
    const result = await verifySmartCaptchaToken('token', '', {
      env: TEST_ENV,
      fetchImpl: (async () => response(status, { status: 'ok' })) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, status: 503, code: 'BOT_PROTECTION_UNAVAILABLE' });
  });

  test('fails closed on malformed provider JSON and network failure', async () => {
    const invalidResponse = await verifySmartCaptchaToken('token', '', {
      env: TEST_ENV,
      fetchImpl: (async () => new Response('{', { status: 200 })) as typeof fetch,
    });
    expect(invalidResponse).toMatchObject({ ok: false, status: 503, code: 'BOT_PROTECTION_UNAVAILABLE' });

    const networkFailure = await verifySmartCaptchaToken('token', '', {
      env: TEST_ENV,
      fetchImpl: (async () => {
        throw new Error('network unavailable');
      }) as typeof fetch,
    });
    expect(networkFailure).toMatchObject({ ok: false, status: 503, code: 'BOT_PROTECTION_UNAVAILABLE' });
  });

  test('does not send overlong tokens to the provider', async () => {
    const fetchImpl = vi.fn(async () => response(200, { status: 'ok', host: 'mebel-irkutsk.ru' }));
    const result = await verifySmartCaptchaToken('x'.repeat(4097), '', {
      env: TEST_ENV,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'BOT_PROTECTION_FAILED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
