import { describe, expect, test } from 'vitest';

import { assertTelegramLoginProductionConfig } from '../scripts/check-runtime-config.mjs';

const VALID_ENV = {
  PUBLIC_SITE_URL: 'https://mbl-master.ru',
  TELEGRAM_LOGIN_CLIENT_ID: '123456789',
  TELEGRAM_LOGIN_CLIENT_SECRET: 'strong-synthetic-secret-value-42',
  TELEGRAM_ADMIN_ALLOWED_USER_IDS: '123456789,987654321',
  TELEGRAM_LOGIN_REDIRECT_URI: 'https://mbl-master.ru/api/admin/auth/telegram/callback',
};

describe('Telegram Login production configuration', () => {
  test('accepts a complete HTTPS configuration on the public origin', () => {
    const result = assertTelegramLoginProductionConfig(VALID_ENV);
    expect(result.redirectUrl.toString()).toBe(VALID_ENV.TELEGRAM_LOGIN_REDIRECT_URI);
    expect(result.ownerIds).toEqual(new Set(['123456789', '987654321']));
  });

  test.each([
    ['missing client ID', { TELEGRAM_LOGIN_CLIENT_ID: '' }],
    ['weak client secret', { TELEGRAM_LOGIN_CLIENT_SECRET: 'short' }],
    ['empty owner allowlist', { TELEGRAM_ADMIN_ALLOWED_USER_IDS: '' }],
    ['invalid owner allowlist', { TELEGRAM_ADMIN_ALLOWED_USER_IDS: '123456789,owner' }],
    ['HTTP callback', { TELEGRAM_LOGIN_REDIRECT_URI: 'http://mbl-master.ru/api/admin/auth/telegram/callback' }],
    ['wrong callback path', { TELEGRAM_LOGIN_REDIRECT_URI: 'https://mbl-master.ru/api/admin/auth/callback' }],
    [
      'different callback origin',
      { TELEGRAM_LOGIN_REDIRECT_URI: 'https://auth.mbl-master.ru/api/admin/auth/telegram/callback' },
    ],
  ])('rejects %s', (_label, override) => {
    expect(() => assertTelegramLoginProductionConfig({ ...VALID_ENV, ...override })).toThrow();
  });
});
