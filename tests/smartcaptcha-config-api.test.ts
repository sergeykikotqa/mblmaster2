import { afterEach, expect, test, vi } from 'vitest';

import { GET } from '~/pages/api/captcha/config';

afterEach(() => vi.unstubAllEnvs());

test('production CAPTCHA config fails closed and never exposes a server key', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CONTACT_SMARTCAPTCHA_REQUIRED', 'false');
  vi.stubEnv('SMARTCAPTCHA_CLIENT_KEY', '');
  vi.stubEnv('SMARTCAPTCHA_SERVER_KEY', 'private-test-value');
  vi.stubEnv('SMARTCAPTCHA_ALLOWED_HOSTS', 'mebel-irkutsk.ru');

  const response = GET();
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const payload = await response.json();
  expect(payload).toEqual({ provider: 'smartcaptcha', required: true, ready: false, clientKey: '' });
  expect(JSON.stringify(payload)).not.toContain('private-test-value');
});

test('configured production endpoint exposes only the public client key', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('SMARTCAPTCHA_CLIENT_KEY', 'ysc1_local_integration_mock_key');
  vi.stubEnv('SMARTCAPTCHA_SERVER_KEY', 'ysc2_local_integration_mock_key');
  vi.stubEnv('SMARTCAPTCHA_ALLOWED_HOSTS', 'mebel-irkutsk.ru');

  const response = GET();
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload).toEqual({
    provider: 'smartcaptcha',
    required: true,
    ready: true,
    clientKey: 'ysc1_local_integration_mock_key',
  });
  expect(JSON.stringify(payload)).not.toContain('ysc2_');
});
