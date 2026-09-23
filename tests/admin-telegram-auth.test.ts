import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authorizeAdminRequest } from '../src/server/admin/auth';
import {
  ADMIN_SESSION_COOKIE,
  __resetAdminSessionMemoryForTests,
  consumeAdminLoginFlow,
  createAdminLoginFlow,
  createAdminSession,
  revokeAdminSession,
  validateAdminSession,
} from '../src/server/admin/session';
import {
  isTelegramAdminOwnerAllowed,
  type TelegramOidcConfig,
  TelegramOidcError,
  verifyTelegramIdToken,
} from '../src/server/admin/telegram-oidc';
import { GET as mockLogin } from '../src/pages/api/admin/auth/telegram/mock';

const OWNER_ID = '123456789';
const ORIGINAL_ENV = { ...process.env };

function requestWithSession(sessionId: string, options: { method?: string; csrf?: string; origin?: string } = {}) {
  const headers = new Headers({ Cookie: `${ADMIN_SESSION_COOKIE}=${sessionId}`, 'User-Agent': 'mbl-admin-test' });
  if (options.csrf) headers.set('X-CSRF-Token', options.csrf);
  if (options.origin) headers.set('Origin', options.origin);
  return new Request('http://127.0.0.1:4321/api/admin/auth/logout', {
    method: options.method || 'GET',
    headers,
  });
}

beforeEach(() => {
  __resetAdminSessionMemoryForTests();
  process.env = {
    ...ORIGINAL_ENV,
    REDIS_URL: '',
    METRICS_ADMIN_TOKEN: '',
    ADMIN_ALLOWLIST_IPS: '',
    ADMIN_TRUST_PROXY_HEADERS: 'false',
    ALLOW_DEV_BYPASS: 'false',
    TELEGRAM_ADMIN_ALLOWED_USER_IDS: OWNER_ID,
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  __resetAdminSessionMemoryForTests();
});

describe('Telegram-backed admin sessions', () => {
  it('authorizes an allowed owner and rejects missing identity', async () => {
    const created = await createAdminSession(requestWithSession('missing'), OWNER_ID);
    const authorized = await authorizeAdminRequest(requestWithSession(created.sessionId), {
      scope: 'test',
      requireSession: true,
      registerFailure: false,
      allowDevBypass: false,
    });
    expect(authorized.ok).toBe(true);
    if (authorized.ok) expect(authorized.method).toBe('session');

    const missing = await authorizeAdminRequest(new Request('http://127.0.0.1:4321/admin'), {
      scope: 'test',
      requireSession: true,
      registerFailure: false,
      allowDevBypass: false,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('UNAUTHORIZED');
  });

  it('preserves an explicit bearer token for machine admin APIs', async () => {
    process.env.METRICS_ADMIN_TOKEN = 'synthetic-machine-admin-token';
    const result = await authorizeAdminRequest(
      new Request('http://127.0.0.1:4321/api/admin/health', {
        method: 'POST',
        headers: { Authorization: 'Bearer synthetic-machine-admin-token' },
      }),
      {
        scope: 'machine-test',
        registerFailure: false,
        allowDevBypass: false,
      }
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.method).toBe('bearer');
  });

  it('revokes an existing session when the owner allowlist changes', async () => {
    const created = await createAdminSession(requestWithSession('missing'), OWNER_ID);
    process.env.TELEGRAM_ADMIN_ALLOWED_USER_IDS = '987654321';
    expect(isTelegramAdminOwnerAllowed(OWNER_ID)).toBe(false);
    await expect(validateAdminSession(requestWithSession(created.sessionId))).resolves.toMatchObject({
      ok: false,
      code: 'INVALID',
    });
  });

  it('does not trust spoofed proxy headers when proxy trust is disabled', async () => {
    process.env.ADMIN_ALLOWLIST_IPS = '203.0.113.120';
    process.env.ADMIN_TRUST_PROXY_HEADERS = 'false';
    const created = await createAdminSession(requestWithSession('missing'), OWNER_ID);
    const request = requestWithSession(created.sessionId);
    request.headers.set('X-Real-IP', '203.0.113.120');
    const result = await authorizeAdminRequest(request, {
      scope: 'test',
      requireSession: true,
      registerFailure: false,
      allowDevBypass: false,
      clientAddress: '198.51.100.44',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNAUTHORIZED');
  });

  it.each([
    { label: 'empty list', allowlist: '', clientAddress: '198.51.100.44', expectedOk: true },
    { label: 'valid matching address', allowlist: '203.0.113.120', clientAddress: '203.0.113.120', expectedOk: true },
    { label: 'invalid list', allowlist: 'not-an-ip', clientAddress: '203.0.113.120', expectedOk: false },
    {
      label: 'mixed valid and invalid list',
      allowlist: '203.0.113.120,not-an-ip',
      clientAddress: '203.0.113.120',
      expectedOk: false,
    },
  ])('applies the IP allowlist fail closed: $label', async ({ allowlist, clientAddress, expectedOk }) => {
    process.env.ADMIN_ALLOWLIST_IPS = allowlist;
    const created = await createAdminSession(requestWithSession('missing'), OWNER_ID);
    const result = await authorizeAdminRequest(requestWithSession(created.sessionId), {
      scope: 'allowlist-test',
      requireSession: true,
      registerFailure: false,
      allowDevBypass: false,
      clientAddress,
    });

    expect(result.ok).toBe(expectedOk);
    if (!expectedOk && !result.ok) {
      expect(result.status).toBe(503);
      expect(result.code).toBe('ADMIN_AUTH_NOT_CONFIGURED');
    }
  });

  it('requires both same-origin and CSRF token for unsafe session requests', async () => {
    const created = await createAdminSession(requestWithSession('missing'), OWNER_ID);
    const options = {
      scope: 'test',
      requireSession: true,
      registerFailure: false,
      allowDevBypass: false,
    } as const;

    const missingOrigin = await authorizeAdminRequest(
      requestWithSession(created.sessionId, { method: 'POST', csrf: created.csrfToken }),
      options
    );
    expect(missingOrigin.ok).toBe(false);
    if (!missingOrigin.ok) expect(missingOrigin.code).toBe('CSRF_FAILED');

    const foreignOrigin = await authorizeAdminRequest(
      requestWithSession(created.sessionId, {
        method: 'POST',
        csrf: created.csrfToken,
        origin: 'https://attacker.invalid',
      }),
      options
    );
    expect(foreignOrigin.ok).toBe(false);
    if (!foreignOrigin.ok) expect(foreignOrigin.code).toBe('CSRF_FAILED');

    const accepted = await authorizeAdminRequest(
      requestWithSession(created.sessionId, {
        method: 'POST',
        csrf: created.csrfToken,
        origin: 'http://127.0.0.1:4321',
      }),
      options
    );
    expect(accepted.ok).toBe(true);
  });

  it('supports explicit revocation and expiry', async () => {
    const now = Date.now();
    const created = await createAdminSession(requestWithSession('missing'), OWNER_ID, now);
    await expect(
      validateAdminSession(requestWithSession(created.sessionId), now + 25 * 60 * 60 * 1000)
    ).resolves.toMatchObject({
      ok: false,
      code: 'EXPIRED',
    });

    const second = await createAdminSession(requestWithSession('missing'), OWNER_ID);
    await revokeAdminSession(second.sessionId);
    await expect(validateAdminSession(requestWithSession(second.sessionId))).resolves.toMatchObject({
      ok: false,
      code: 'INVALID',
    });
  });

  it('consumes login callback state only once', async () => {
    const flow = await createAdminLoginFlow('http://127.0.0.1:4321/api/admin/auth/telegram/callback', '/admin');
    await expect(consumeAdminLoginFlow(flow.flowId)).resolves.toMatchObject({ state: flow.record.state });
    await expect(consumeAdminLoginFlow(flow.flowId)).resolves.toBeNull();
  });

  it('cannot enable the mock login in forced production mode', async () => {
    process.env.ALLOW_DEV_BYPASS = 'false';
    process.env.TELEGRAM_LOGIN_MOCK_MODE = 'true';
    process.env.ADMIN_AUTH_FORCE_PROD_MODE = 'true';
    const response = await mockLogin({
      request: new Request('http://127.0.0.1:4321/api/admin/auth/telegram/mock'),
      url: new URL('http://127.0.0.1:4321/api/admin/auth/telegram/mock'),
    } as never);
    expect(response.status).toBe(404);
  });

  it('fails closed when the production session store is unavailable', async () => {
    process.env.ADMIN_AUTH_FORCE_PROD_MODE = 'true';
    process.env.REDIS_URL = '';
    await expect(validateAdminSession(requestWithSession('A'.repeat(43)))).resolves.toMatchObject({
      ok: false,
      code: 'STORE_UNAVAILABLE',
    });
  });
});

describe('Telegram OIDC verification', () => {
  it('checks signature, issuer, audience, nonce, expiry and owner allowlist', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    jwk.use = 'sig';
    jwk.alg = 'RS256';
    const nowSec = Math.floor(Date.now() / 1000);
    const config: TelegramOidcConfig = {
      clientId: '123456789',
      clientSecret: 'synthetic-secret-with-enough-length',
      redirectUri: 'https://example.invalid/api/admin/auth/telegram/callback',
      allowedOwnerIds: new Set([OWNER_ID]),
    };
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT({ id: OWNER_ID, nonce: 'expected-nonce', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer('https://oauth.telegram.org')
        .setAudience(config.clientId)
        .setSubject(OWNER_ID)
        .setIssuedAt(nowSec)
        .setExpirationTime(nowSec + 300)
        .sign(privateKey);

    const valid = await verifyTelegramIdToken(await sign({}), config, 'expected-nonce', {
      jwks: { keys: [jwk] },
    });
    expect(valid.ownerTelegramId).toBe(OWNER_ID);

    await expect(
      verifyTelegramIdToken(await sign({ nonce: 'wrong' }), config, 'expected-nonce', { jwks: { keys: [jwk] } })
    ).rejects.toMatchObject({ code: 'TELEGRAM_NONCE_INVALID' } satisfies Partial<TelegramOidcError>);

    const outsider = await sign({ id: '987654321' });
    await expect(
      verifyTelegramIdToken(outsider, config, 'expected-nonce', { jwks: { keys: [jwk] } })
    ).rejects.toMatchObject({ code: 'TELEGRAM_OWNER_NOT_ALLOWED' } satisfies Partial<TelegramOidcError>);

    const wrongAudience = await new SignJWT({ id: OWNER_ID, nonce: 'expected-nonce' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://oauth.telegram.org')
      .setAudience('different-client')
      .setSubject(OWNER_ID)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 300)
      .sign(privateKey);
    await expect(
      verifyTelegramIdToken(wrongAudience, config, 'expected-nonce', { jwks: { keys: [jwk] } })
    ).rejects.toMatchObject({ code: 'TELEGRAM_ID_TOKEN_INVALID' } satisfies Partial<TelegramOidcError>);

    const expired = await new SignJWT({ id: OWNER_ID, nonce: 'expected-nonce' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://oauth.telegram.org')
      .setAudience(config.clientId)
      .setSubject(OWNER_ID)
      .setIssuedAt(nowSec - 600)
      .setExpirationTime(nowSec - 300)
      .sign(privateKey);
    await expect(
      verifyTelegramIdToken(expired, config, 'expected-nonce', { jwks: { keys: [jwk] } })
    ).rejects.toMatchObject({ code: 'TELEGRAM_ID_TOKEN_INVALID' } satisfies Partial<TelegramOidcError>);

    const { privateKey: foreignPrivateKey } = await generateKeyPair('RS256');
    const invalidSignature = await new SignJWT({ id: OWNER_ID, nonce: 'expected-nonce' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://oauth.telegram.org')
      .setAudience(config.clientId)
      .setSubject(OWNER_ID)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 300)
      .sign(foreignPrivateKey);
    await expect(
      verifyTelegramIdToken(invalidSignature, config, 'expected-nonce', { jwks: { keys: [jwk] } })
    ).rejects.toMatchObject({ code: 'TELEGRAM_ID_TOKEN_INVALID' } satisfies Partial<TelegramOidcError>);

    const wrongIssuer = await new SignJWT({ id: OWNER_ID, nonce: 'expected-nonce' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://issuer.invalid')
      .setAudience(config.clientId)
      .setSubject(OWNER_ID)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 300)
      .sign(privateKey);
    await expect(
      verifyTelegramIdToken(wrongIssuer, config, 'expected-nonce', { jwks: { keys: [jwk] } })
    ).rejects.toMatchObject({ code: 'TELEGRAM_ID_TOKEN_INVALID' } satisfies Partial<TelegramOidcError>);
  });
});
