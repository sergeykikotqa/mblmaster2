import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { extractBearerToken, isProd, parseBooleanEnv, requireAdminToken, timingSafeCompare } from '~/server/utils/auth';
import { normalizeIp, resolveClientIp as resolveClientIpFromRequest } from '~/server/utils/ip';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

const DEFAULT_AUTH_FAIL_WINDOW_SEC = 60;
const DEFAULT_AUTH_FAIL_MAX_ATTEMPTS = 10;
const DEFAULT_AUTH_FAIL_BLOCK_SEC = 10 * 60;
const FORBIDDEN_QUERY_KEYS = ['token', 'access_token', 'auth', 'authorization', 'bearer'];

type AuthMethod = 'bearer' | 'allowlist' | 'dev-bypass';
type AdminAuthCode = 'UNAUTHORIZED' | 'TOO_MANY_REQUESTS' | 'TOKEN_IN_QUERY_NOT_ALLOWED' | 'ADMIN_AUTH_NOT_CONFIGURED';
export type AdminAuthMethod = AuthMethod;

type AdminAuthSuccess = {
  ok: true;
  method: AuthMethod;
  clientIp: string;
};

type AdminAuthFailure = {
  ok: false;
  status: number;
  code: AdminAuthCode;
  clientIp: string;
  retryAfterSec?: number;
  response: Response;
};

export type AdminAuthResult = AdminAuthSuccess | AdminAuthFailure;

type AdminAuthOptions = {
  scope: string;
  allowDevBypass?: boolean;
  clientAddress?: string;
  rateLimitScope?: string;
};

type FailedAuthState = {
  count: number;
  windowStartedAtMs: number;
  blockedUntilMs: number;
};

type UpstashResponse<T> = {
  result?: T;
  error?: string;
};

const memoryFailedAuthAttempts = new Map<string, FailedAuthState>();
const adminAuthRuntimeStats = {
  redisFallbackToMemoryCount: 0,
  redisFallbackToMemoryLastAtMs: 0,
};

function markAuthFallbackMemory(reason: string) {
  adminAuthRuntimeStats.redisFallbackToMemoryCount += 1;
  adminAuthRuntimeStats.redisFallbackToMemoryLastAtMs = Date.now();
  console.warn('[admin-auth] redis_fallback_memory', {
    reason,
    authFallbackMemory: true,
    redisFallbackToMemoryCount: adminAuthRuntimeStats.redisFallbackToMemoryCount,
    redisFallbackToMemoryLastAtMs: adminAuthRuntimeStats.redisFallbackToMemoryLastAtMs,
  });
}

export function getAdminAuthRuntimeStats() {
  return { ...adminAuthRuntimeStats };
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveAuthFailWindowSec(): number {
  return parsePositiveInt(process.env.ADMIN_AUTH_FAIL_WINDOW_SEC, DEFAULT_AUTH_FAIL_WINDOW_SEC, 10);
}

function resolveAuthFailMaxAttempts(): number {
  return parsePositiveInt(process.env.ADMIN_AUTH_FAIL_MAX_ATTEMPTS, DEFAULT_AUTH_FAIL_MAX_ATTEMPTS, 1);
}

function resolveAuthFailBlockSec(): number {
  return parsePositiveInt(process.env.ADMIN_AUTH_FAIL_BLOCK_SEC, DEFAULT_AUTH_FAIL_BLOCK_SEC, 10);
}

function resolveAllowlistEntries(): string[] {
  return String(process.env.ADMIN_ALLOWLIST_IPS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function shouldTrustProxyHeaders(): boolean {
  return parseBooleanEnv(process.env.ADMIN_TRUST_PROXY_HEADERS, false);
}

function isProductionAuthMode(): boolean {
  return isProd('ADMIN_AUTH_FORCE_PROD_MODE');
}

function isDevBypassEnabled(): boolean {
  return parseBooleanEnv(process.env.ALLOW_DEV_BYPASS, false);
}

function resolveRedisPrefix(): string {
  const value = (process.env.CONTACT_REDIS_PREFIX || '').trim();
  if (!value) return 'lead';
  return value.replace(/[^a-zA-Z0-9:_-]/g, '-');
}

function hasRedisConfig(): boolean {
  const endpoint = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  return Boolean(endpoint && token);
}

function getRedisConfig() {
  return {
    endpoint: (process.env.UPSTASH_REDIS_REST_URL || '').trim(),
    token: (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim(),
  };
}

function parseAllowlist(entries: string[]): {
  exact: Set<string>;
  blockList: BlockList;
  hasEntries: boolean;
  invalidEntries: string[];
} {
  const exact = new Set<string>();
  const blockList = new BlockList();
  const invalidEntries: string[] = [];
  let validEntriesCount = 0;

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    if (!entry.includes('/')) {
      const normalizedIp = normalizeIp(entry);
      if (isIP(normalizedIp) === 0) {
        invalidEntries.push(rawEntry);
        continue;
      }
      exact.add(normalizedIp);
      validEntriesCount += 1;
      continue;
    }

    const segments = entry.split('/');
    if (segments.length !== 2) {
      invalidEntries.push(rawEntry);
      continue;
    }

    const network = normalizeIp(segments[0] || '');
    const prefix = Number(segments[1]);
    const family = isIP(network);
    const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;

    if (!family || !Number.isFinite(prefix) || prefix < 0 || prefix > maxPrefix) {
      invalidEntries.push(rawEntry);
      continue;
    }

    try {
      blockList.addSubnet(network, Math.floor(prefix), family === 4 ? 'ipv4' : 'ipv6');
      validEntriesCount += 1;
    } catch {
      invalidEntries.push(rawEntry);
    }
  }

  return {
    exact,
    blockList,
    hasEntries: validEntriesCount > 0,
    invalidEntries,
  };
}

export function getAdminAuthConfigurationSnapshot(): {
  tokenConfigured: boolean;
  allowlistConfigured: boolean;
  invalidAllowlistEntriesCount: number;
  trustProxyHeaders: boolean;
} {
  const adminTokenResult = requireAdminToken();
  const allowlist = parseAllowlist(resolveAllowlistEntries());
  return {
    tokenConfigured: adminTokenResult.ok,
    allowlistConfigured: allowlist.hasEntries,
    invalidAllowlistEntriesCount: allowlist.invalidEntries.length,
    trustProxyHeaders: shouldTrustProxyHeaders(),
  };
}

function isAllowlistedIp(ip: string, allowlist: { exact: Set<string>; blockList: BlockList }): boolean {
  if (!ip) return false;
  if (allowlist.exact.has(ip)) return true;

  const family = isIP(ip);
  if (family === 4) {
    return allowlist.blockList.check(ip, 'ipv4');
  }
  if (family === 6) {
    return allowlist.blockList.check(ip, 'ipv6');
  }
  return false;
}

function findForbiddenQueryTokenKey(url: URL): string {
  for (const key of FORBIDDEN_QUERY_KEYS) {
    if (url.searchParams.has(key)) return key;
  }
  return '';
}

function makeAuthFailureResponse(status: number, code: AdminAuthCode, retryAfterSec?: number): Response {
  const headers = new Headers(JSON_HEADERS);
  if (retryAfterSec && retryAfterSec > 0) {
    headers.set('Retry-After', String(retryAfterSec));
  }
  return new Response(
    JSON.stringify({
      ok: false,
      code,
    }),
    {
      status,
      headers,
    }
  );
}

function hashTokenIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function resolveFailureIdentity(request: Request, clientIp: string): string {
  if (clientIp) {
    return `ip:${clientIp}`;
  }

  const fallbackParts = [
    (request.headers.get('user-agent') || '').trim(),
    (request.headers.get('accept-language') || '').trim(),
    (request.headers.get('sec-ch-ua') || '').trim(),
    (request.headers.get('host') || '').trim(),
    (request.headers.get('origin') || '').trim(),
  ].filter(Boolean);

  if (fallbackParts.length === 0) return 'unknown';
  return `fp:${hashTokenIdentity(fallbackParts.join('|'))}`;
}

async function redisCommand<T>(...args: Array<string | number>): Promise<T> {
  const { endpoint, token } = getRedisConfig();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    throw new Error(`REDIS_HTTP_${response.status}`);
  }

  const payload = (await response.json()) as UpstashResponse<T>;
  if (payload.error) {
    throw new Error(`REDIS_COMMAND_ERROR:${payload.error}`);
  }

  return payload.result as T;
}

function authFailureKeys(identity: string, rateLimitScope: string): { failKey: string; blockKey: string } {
  const keyIdentity = hashTokenIdentity(`${rateLimitScope}:${identity || 'unknown'}`);
  const prefix = `${resolveRedisPrefix()}:admin:auth`;
  return {
    failKey: `${prefix}:fail:${keyIdentity}`,
    blockKey: `${prefix}:block:${keyIdentity}`,
  };
}

function memoryFailureKey(identity: string, rateLimitScope: string): string {
  return `${rateLimitScope}:${identity || 'unknown'}`;
}

function cleanupMemoryFailureState(nowMs: number, windowSec: number) {
  const windowMs = windowSec * 1000;
  for (const [key, state] of memoryFailedAuthAttempts.entries()) {
    const isWindowExpired = nowMs - state.windowStartedAtMs > windowMs;
    const isBlockExpired = state.blockedUntilMs <= nowMs;
    if (isWindowExpired && isBlockExpired) {
      memoryFailedAuthAttempts.delete(key);
    }
  }
}

function getMemoryBlockRetryAfterSec(identity: string, nowMs: number, rateLimitScope: string): number {
  const state = memoryFailedAuthAttempts.get(memoryFailureKey(identity, rateLimitScope));
  if (!state) return 0;
  if (state.blockedUntilMs <= nowMs) return 0;
  return Math.max(1, Math.ceil((state.blockedUntilMs - nowMs) / 1000));
}

function registerMemoryFailure(
  identity: string,
  nowMs: number,
  rateLimitScope: string
): { blocked: boolean; retryAfterSec: number } {
  const windowSec = resolveAuthFailWindowSec();
  const maxAttempts = resolveAuthFailMaxAttempts();
  const blockSec = resolveAuthFailBlockSec();
  const windowMs = windowSec * 1000;
  const failureKey = memoryFailureKey(identity, rateLimitScope);

  cleanupMemoryFailureState(nowMs, windowSec);

  const current = memoryFailedAuthAttempts.get(failureKey);
  if (!current || nowMs - current.windowStartedAtMs > windowMs) {
    const next: FailedAuthState = {
      count: 1,
      windowStartedAtMs: nowMs,
      blockedUntilMs: 0,
    };
    memoryFailedAuthAttempts.set(failureKey, next);
    return { blocked: false, retryAfterSec: 0 };
  }

  current.count += 1;
  if (current.count >= maxAttempts) {
    current.count = 0;
    current.windowStartedAtMs = nowMs;
    current.blockedUntilMs = nowMs + blockSec * 1000;
    memoryFailedAuthAttempts.set(failureKey, current);
    return { blocked: true, retryAfterSec: Math.max(1, blockSec) };
  }

  memoryFailedAuthAttempts.set(failureKey, current);
  return { blocked: false, retryAfterSec: 0 };
}

function clearMemoryFailures(identity: string, rateLimitScope: string) {
  memoryFailedAuthAttempts.delete(memoryFailureKey(identity, rateLimitScope));
}

async function getRedisBlockRetryAfterSec(identity: string, rateLimitScope: string): Promise<number> {
  if (!hasRedisConfig()) return 0;
  const { blockKey } = authFailureKeys(identity, rateLimitScope);
  const ttl = await redisCommand<number>('TTL', blockKey);
  const normalized = Number(ttl);
  if (!Number.isFinite(normalized)) return 0;
  if (normalized <= 0) return 0;
  return Math.max(1, Math.floor(normalized));
}

async function registerRedisFailure(
  identity: string,
  rateLimitScope: string
): Promise<{ blocked: boolean; retryAfterSec: number }> {
  if (!hasRedisConfig()) return { blocked: false, retryAfterSec: 0 };

  const maxAttempts = resolveAuthFailMaxAttempts();
  const windowSec = resolveAuthFailWindowSec();
  const blockSec = resolveAuthFailBlockSec();
  const { failKey, blockKey } = authFailureKeys(identity, rateLimitScope);

  const count = Number(await redisCommand<number>('INCR', failKey));
  if (!Number.isFinite(count)) {
    throw new Error('REDIS_AUTH_INCR_INVALID');
  }

  if (count <= 1) {
    await redisCommand('EXPIRE', failKey, windowSec);
  }

  if (count >= maxAttempts) {
    await redisCommand('SET', blockKey, '1', 'EX', blockSec);
    await redisCommand('DEL', failKey);
    return {
      blocked: true,
      retryAfterSec: Math.max(1, blockSec),
    };
  }

  return {
    blocked: false,
    retryAfterSec: 0,
  };
}

async function clearRedisFailures(identity: string, rateLimitScope: string): Promise<void> {
  if (!hasRedisConfig()) return;
  const { failKey, blockKey } = authFailureKeys(identity, rateLimitScope);
  await redisCommand('DEL', failKey, blockKey);
}

async function getBlockRetryAfterSec(identity: string, nowMs: number, rateLimitScope: string): Promise<number> {
  if (hasRedisConfig()) {
    try {
      return await getRedisBlockRetryAfterSec(identity, rateLimitScope);
    } catch (error) {
      markAuthFallbackMemory(`get_block_retry_after_sec:${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
  }
  return getMemoryBlockRetryAfterSec(identity, nowMs, rateLimitScope);
}

async function registerFailure(
  identity: string,
  nowMs: number,
  rateLimitScope: string
): Promise<{ blocked: boolean; retryAfterSec: number }> {
  if (hasRedisConfig()) {
    try {
      return await registerRedisFailure(identity, rateLimitScope);
    } catch (error) {
      markAuthFallbackMemory(`register_failure:${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
  }
  return registerMemoryFailure(identity, nowMs, rateLimitScope);
}

async function clearFailures(identity: string, rateLimitScope: string): Promise<void> {
  if (hasRedisConfig()) {
    try {
      await clearRedisFailures(identity, rateLimitScope);
    } catch (error) {
      markAuthFallbackMemory(`clear_failures:${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
  }
  clearMemoryFailures(identity, rateLimitScope);
}

export async function authorizeAdminRequest(request: Request, options: AdminAuthOptions): Promise<AdminAuthResult> {
  const nowMs = Date.now();
  const scope = options.scope || 'admin';
  const rateLimitScope = String(options.rateLimitScope || scope).trim() || scope;
  const allowDevBypass = options.allowDevBypass !== false && isDevBypassEnabled();
  const url = new URL(request.url);
  const clientIp = resolveClientIpFromRequest(request, shouldTrustProxyHeaders(), options.clientAddress);
  const identity = resolveFailureIdentity(request, clientIp);

  const forbiddenQueryToken = findForbiddenQueryTokenKey(url);
  if (forbiddenQueryToken) {
    console.warn('[admin-auth] denied query-token', {
      scope,
      clientIp: clientIp || 'unknown',
      queryKey: forbiddenQueryToken,
    });
    return {
      ok: false,
      status: 400,
      code: 'TOKEN_IN_QUERY_NOT_ALLOWED',
      clientIp,
      response: makeAuthFailureResponse(400, 'TOKEN_IN_QUERY_NOT_ALLOWED'),
    };
  }

  const blockedRetryAfterSec = await getBlockRetryAfterSec(identity, nowMs, rateLimitScope);
  if (blockedRetryAfterSec > 0) {
    return {
      ok: false,
      status: 429,
      code: 'TOO_MANY_REQUESTS',
      clientIp,
      retryAfterSec: blockedRetryAfterSec,
      response: makeAuthFailureResponse(429, 'TOO_MANY_REQUESTS', blockedRetryAfterSec),
    };
  }

  const adminTokenResult = requireAdminToken();
  const adminToken = adminTokenResult.ok ? adminTokenResult.token : '';
  const allowlistEntries = resolveAllowlistEntries();
  const allowlist = parseAllowlist(allowlistEntries);
  if (allowlist.invalidEntries.length > 0) {
    console.warn('[admin-auth] invalid allowlist entries ignored', {
      scope,
      count: allowlist.invalidEntries.length,
    });
  }

  const tokenConfigured = adminTokenResult.ok;
  const allowlistConfigured = allowlist.hasEntries;

  if (isProductionAuthMode() && !tokenConfigured) {
    console.error('[admin-auth] missing METRICS_ADMIN_TOKEN in production', { scope });
    return {
      ok: false,
      status: 503,
      code: 'ADMIN_AUTH_NOT_CONFIGURED',
      clientIp,
      response: makeAuthFailureResponse(503, 'ADMIN_AUTH_NOT_CONFIGURED'),
    };
  }

  if (!isProductionAuthMode() && allowDevBypass && !tokenConfigured && !allowlistConfigured) {
    return {
      ok: true,
      method: 'dev-bypass',
      clientIp,
    };
  }

  const bearerToken = extractBearerToken(request);
  const bearerAuthorized = tokenConfigured && timingSafeCompare(adminToken, bearerToken);
  const allowlistAuthorized = allowlistConfigured && clientIp ? isAllowlistedIp(clientIp, allowlist) : false;

  if (bearerAuthorized || allowlistAuthorized) {
    await clearFailures(identity, rateLimitScope);
    return {
      ok: true,
      method: bearerAuthorized ? 'bearer' : 'allowlist',
      clientIp,
    };
  }

  const failure = await registerFailure(identity, nowMs, rateLimitScope);
  const status = failure.blocked ? 429 : 401;
  const code: AdminAuthCode = failure.blocked ? 'TOO_MANY_REQUESTS' : 'UNAUTHORIZED';
  console.warn('[admin-auth] unauthorized', {
    scope,
    rateLimitScope,
    clientIp: clientIp || 'unknown',
    hasAuthorizationHeader: Boolean(request.headers.get('authorization')),
    tokenConfigured,
    allowlistConfigured,
    blocked: failure.blocked,
    trustProxyHeaders: shouldTrustProxyHeaders(),
  });

  return {
    ok: false,
    status,
    code,
    clientIp,
    retryAfterSec: failure.retryAfterSec || undefined,
    response: makeAuthFailureResponse(status, code, failure.retryAfterSec),
  };
}
