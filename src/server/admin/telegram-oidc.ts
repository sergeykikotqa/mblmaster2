import { createHash } from 'node:crypto';

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';

import { isProd } from '~/server/utils/auth';

const TELEGRAM_ISSUER = 'https://oauth.telegram.org';
const TELEGRAM_AUTHORIZATION_ENDPOINT = 'https://oauth.telegram.org/auth';
const TELEGRAM_TOKEN_ENDPOINT = 'https://oauth.telegram.org/token';
const TELEGRAM_JWKS_ENDPOINT = 'https://oauth.telegram.org/.well-known/jwks.json';
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const PROVIDER_TIMEOUT_MS = 8000;

export type TelegramOidcConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedOwnerIds: Set<string>;
};

export type TelegramOidcEndpoints = {
  authorization: string;
  token: string;
  jwks: string;
};

export class TelegramOidcError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const TELEGRAM_OIDC_ENDPOINTS: TelegramOidcEndpoints = Object.freeze({
  authorization: TELEGRAM_AUTHORIZATION_ENDPOINT,
  token: TELEGRAM_TOKEN_ENDPOINT,
  jwks: TELEGRAM_JWKS_ENDPOINT,
});

function ownerIds(raw: string | undefined): Set<string> {
  const parsed = String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (parsed.some((value) => !/^\d{3,20}$/.test(value))) {
    throw new TelegramOidcError('TELEGRAM_OWNER_ALLOWLIST_INVALID');
  }
  return new Set(parsed);
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function loadTelegramOidcConfig(env: NodeJS.ProcessEnv = process.env): TelegramOidcConfig {
  const clientId = String(env.TELEGRAM_LOGIN_CLIENT_ID || '').trim();
  const clientSecret = String(env.TELEGRAM_LOGIN_CLIENT_SECRET || '').trim();
  const allowedOwnerIds = ownerIds(env.TELEGRAM_ADMIN_ALLOWED_USER_IDS);
  if (!/^\d{3,20}$/.test(clientId)) throw new TelegramOidcError('TELEGRAM_LOGIN_NOT_CONFIGURED');
  if (clientSecret.length < 24) throw new TelegramOidcError('TELEGRAM_LOGIN_NOT_CONFIGURED');
  if (allowedOwnerIds.size === 0) throw new TelegramOidcError('TELEGRAM_OWNER_ALLOWLIST_EMPTY');

  let redirectUri: URL;
  try {
    const configured = String(env.TELEGRAM_LOGIN_REDIRECT_URI || '').trim();
    const publicOrigin = String(env.PUBLIC_SITE_URL || '').trim();
    redirectUri = configured
      ? new URL(configured)
      : new URL('/api/admin/auth/telegram/callback', new URL(publicOrigin));
  } catch {
    throw new TelegramOidcError('TELEGRAM_REDIRECT_URI_INVALID');
  }

  if (redirectUri.username || redirectUri.password || redirectUri.hash || redirectUri.search) {
    throw new TelegramOidcError('TELEGRAM_REDIRECT_URI_INVALID');
  }
  if (redirectUri.pathname !== '/api/admin/auth/telegram/callback') {
    throw new TelegramOidcError('TELEGRAM_REDIRECT_URI_INVALID');
  }
  if (redirectUri.protocol !== 'https:' && (isProd('ADMIN_AUTH_FORCE_PROD_MODE') || !isLoopback(redirectUri.hostname))) {
    throw new TelegramOidcError('TELEGRAM_REDIRECT_HTTPS_REQUIRED');
  }

  return {
    clientId,
    clientSecret,
    redirectUri: redirectUri.toString(),
    allowedOwnerIds,
  };
}

export function isTelegramOidcConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadTelegramOidcConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function codeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

export function buildTelegramAuthorizationUrl(
  config: TelegramOidcConfig,
  flow: { state: string; nonce: string; codeVerifier: string },
  endpoints: TelegramOidcEndpoints = TELEGRAM_OIDC_ENDPOINTS
): URL {
  const target = new URL(endpoints.authorization);
  target.searchParams.set('client_id', config.clientId);
  target.searchParams.set('redirect_uri', config.redirectUri);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('scope', 'openid profile');
  target.searchParams.set('state', flow.state);
  target.searchParams.set('nonce', flow.nonce);
  target.searchParams.set('code_challenge', codeChallenge(flow.codeVerifier));
  target.searchParams.set('code_challenge_method', 'S256');
  return target;
}

async function limitedJson(response: Response): Promise<unknown> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new TelegramOidcError('TELEGRAM_PROVIDER_RESPONSE_INVALID');
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new TelegramOidcError('TELEGRAM_PROVIDER_RESPONSE_INVALID');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new TelegramOidcError('TELEGRAM_PROVIDER_RESPONSE_INVALID');
  }
}

async function providerRequest(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs = PROVIDER_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal });
  } catch {
    throw new TelegramOidcError('TELEGRAM_PROVIDER_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeTelegramAuthorizationCode(
  config: TelegramOidcConfig,
  code: string,
  codeVerifier: string,
  options: { fetchImpl?: typeof fetch; endpoints?: TelegramOidcEndpoints } = {}
): Promise<string> {
  if (!code || code.length > 4096) throw new TelegramOidcError('TELEGRAM_CODE_INVALID');
  const endpoints = options.endpoints || TELEGRAM_OIDC_ENDPOINTS;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });
  const response = await providerRequest(
    endpoints.token,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    },
    options.fetchImpl || fetch
  );
  const payload = (await limitedJson(response)) as { id_token?: unknown };
  if (response.status !== 200 || typeof payload?.id_token !== 'string' || payload.id_token.length > 16_384) {
    throw new TelegramOidcError('TELEGRAM_TOKEN_EXCHANGE_FAILED');
  }
  return payload.id_token;
}

function telegramOwnerId(payload: JWTPayload): string {
  const value = payload.id;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d{3,20}$/.test(String(value))) {
    throw new TelegramOidcError('TELEGRAM_ID_TOKEN_INVALID');
  }
  return String(value);
}

export async function verifyTelegramIdToken(
  idToken: string,
  config: TelegramOidcConfig,
  expectedNonce: string,
  options: {
    fetchImpl?: typeof fetch;
    endpoints?: TelegramOidcEndpoints;
    nowMs?: number;
    jwks?: JSONWebKeySet;
  } = {}
): Promise<{ ownerTelegramId: string; payload: JWTPayload }> {
  if (!idToken || idToken.length > 16_384 || !expectedNonce) {
    throw new TelegramOidcError('TELEGRAM_ID_TOKEN_INVALID');
  }
  const endpoints = options.endpoints || TELEGRAM_OIDC_ENDPOINTS;
  let jwks = options.jwks;
  if (!jwks) {
    const response = await providerRequest(
      endpoints.jwks,
      { method: 'GET', headers: { Accept: 'application/json' } },
      options.fetchImpl || fetch
    );
    const payload = await limitedJson(response);
    if (response.status !== 200 || !payload || typeof payload !== 'object' || !Array.isArray((payload as JSONWebKeySet).keys)) {
      throw new TelegramOidcError('TELEGRAM_JWKS_INVALID');
    }
    jwks = payload as JSONWebKeySet;
  }

  try {
    const verified = await jwtVerify(idToken, createLocalJWKSet(jwks), {
      issuer: TELEGRAM_ISSUER,
      audience: config.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce'],
      currentDate: options.nowMs === undefined ? undefined : new Date(options.nowMs),
      clockTolerance: 5,
    });
    if (verified.payload.nonce !== expectedNonce) throw new TelegramOidcError('TELEGRAM_NONCE_INVALID');
    const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
    if (typeof verified.payload.iat !== 'number' || verified.payload.iat > nowSec + 60) {
      throw new TelegramOidcError('TELEGRAM_ID_TOKEN_INVALID');
    }
    const ownerTelegramId = telegramOwnerId(verified.payload);
    if (!config.allowedOwnerIds.has(ownerTelegramId)) {
      throw new TelegramOidcError('TELEGRAM_OWNER_NOT_ALLOWED');
    }
    return { ownerTelegramId, payload: verified.payload };
  } catch (error) {
    if (error instanceof TelegramOidcError) throw error;
    throw new TelegramOidcError('TELEGRAM_ID_TOKEN_INVALID');
  }
}

export function sanitizeAdminNextPath(value: string | null | undefined): string {
  const candidate = String(value || '').trim();
  if (!candidate.startsWith('/admin') || candidate.startsWith('//') || candidate.includes('\\')) return '/admin';
  try {
    const parsed = new URL(candidate, 'https://admin.invalid');
    if (parsed.origin !== 'https://admin.invalid') return '/admin';
    if (parsed.pathname === '/admin/login' || parsed.pathname.startsWith('/api/')) return '/admin';
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/admin';
  }
}
