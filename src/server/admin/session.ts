import { createHash, randomBytes } from 'node:crypto';

import { assertMemoryFallbackAllowed, hasRedisConfig, redisCommand } from '~/server/redis/client';
import { isProd, timingSafeCompare } from '~/server/utils/auth';
import { isTelegramAdminOwnerAllowed } from '~/server/admin/telegram-oidc';

export const ADMIN_SESSION_COOKIE = 'mbl_admin_session';
export const ADMIN_OIDC_FLOW_COOKIE = 'mbl_admin_oidc_flow';
export const ADMIN_CSRF_COOKIE = 'mbl_admin_csrf';

const SESSION_SCHEMA = 1;
const FLOW_SCHEMA = 1;
const DEFAULT_SESSION_TTL_SEC = 8 * 60 * 60;
const DEFAULT_FLOW_TTL_SEC = 5 * 60;
const MIN_SESSION_TTL_SEC = 5 * 60;
const MAX_SESSION_TTL_SEC = 24 * 60 * 60;
const MIN_FLOW_TTL_SEC = 60;
const MAX_FLOW_TTL_SEC = 10 * 60;

export type AdminSessionRecord = {
  schema: 1;
  ownerTelegramId: string;
  csrfHash: string;
  userAgentHash: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type AdminLoginFlowRecord = {
  schema: 1;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  nextPath: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type AdminSessionValidation =
  | { ok: true; sessionId: string; record: AdminSessionRecord }
  | { ok: false; code: 'MISSING' | 'INVALID' | 'EXPIRED' | 'STORE_UNAVAILABLE' };

const memoryValues = new Map<string, { value: string; expiresAtMs: number }>();

function assertAdminSessionMemoryFallbackAllowed(error?: unknown): void {
  if (isProd('ADMIN_AUTH_FORCE_PROD_MODE')) {
    throw error instanceof Error ? error : new Error('ADMIN_SESSION_STORE_UNAVAILABLE');
  }
  assertMemoryFallbackAllowed(error);
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function resolveAdminSessionTtlSec(): number {
  return parsePositiveInt(
    process.env.ADMIN_SESSION_TTL_SEC,
    DEFAULT_SESSION_TTL_SEC,
    MIN_SESSION_TTL_SEC,
    MAX_SESSION_TTL_SEC
  );
}

export function resolveAdminLoginFlowTtlSec(): number {
  return parsePositiveInt(
    process.env.ADMIN_OIDC_FLOW_TTL_SEC,
    DEFAULT_FLOW_TTL_SEC,
    MIN_FLOW_TTL_SEC,
    MAX_FLOW_TTL_SEC
  );
}

function redisPrefix(): string {
  const prefix = String(process.env.CONTACT_REDIS_PREFIX || 'lead')
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, '-');
  return prefix || 'lead';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sessionKey(sessionId: string): string {
  return `${redisPrefix()}:admin:session:${digest(sessionId)}`;
}

function flowKey(flowId: string): string {
  return `${redisPrefix()}:admin:oidc-flow:${digest(flowId)}`;
}

function cleanupMemory(nowMs = Date.now()) {
  for (const [key, entry] of memoryValues.entries()) {
    if (entry.expiresAtMs <= nowMs) memoryValues.delete(key);
  }
}

async function storeValue(key: string, value: string, ttlSec: number): Promise<void> {
  if (hasRedisConfig()) {
    try {
      await redisCommand('SET', key, value, 'EX', ttlSec);
      return;
    } catch (error) {
      assertAdminSessionMemoryFallbackAllowed(error);
    }
  } else {
    assertAdminSessionMemoryFallbackAllowed();
  }

  cleanupMemory();
  memoryValues.set(key, { value, expiresAtMs: Date.now() + ttlSec * 1000 });
}

async function readValue(key: string): Promise<string | null> {
  if (hasRedisConfig()) {
    try {
      return await redisCommand<string | null>('GET', key);
    } catch (error) {
      assertAdminSessionMemoryFallbackAllowed(error);
    }
  } else {
    assertAdminSessionMemoryFallbackAllowed();
  }

  cleanupMemory();
  return memoryValues.get(key)?.value ?? null;
}

async function consumeValue(key: string): Promise<string | null> {
  if (hasRedisConfig()) {
    try {
      return await redisCommand<string | null>('GETDEL', key);
    } catch (error) {
      assertAdminSessionMemoryFallbackAllowed(error);
    }
  } else {
    assertAdminSessionMemoryFallbackAllowed();
  }

  cleanupMemory();
  const value = memoryValues.get(key)?.value ?? null;
  memoryValues.delete(key);
  return value;
}

async function deleteValue(key: string): Promise<void> {
  if (hasRedisConfig()) {
    try {
      await redisCommand('DEL', key);
      return;
    } catch (error) {
      assertAdminSessionMemoryFallbackAllowed(error);
    }
  } else {
    assertAdminSessionMemoryFallbackAllowed();
  }

  memoryValues.delete(key);
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function userAgentHash(request: Request): string {
  return digest((request.headers.get('user-agent') || '').trim().slice(0, 512));
}

function cookieMap(request: Request): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value) continue;
    try {
      values.set(name, decodeURIComponent(value));
    } catch {
      // Malformed cookie values are ignored and never treated as credentials.
    }
  }
  return values;
}

function validOpaqueToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,64}$/.test(value);
}

function validSessionRecord(value: unknown): value is AdminSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<AdminSessionRecord>;
  return (
    record.schema === SESSION_SCHEMA &&
    typeof record.ownerTelegramId === 'string' &&
    /^\d{3,20}$/.test(record.ownerTelegramId) &&
    typeof record.csrfHash === 'string' &&
    /^[a-f0-9]{64}$/.test(record.csrfHash) &&
    typeof record.userAgentHash === 'string' &&
    /^[a-f0-9]{64}$/.test(record.userAgentHash) &&
    Number.isSafeInteger(record.createdAtMs) &&
    Number.isSafeInteger(record.expiresAtMs) &&
    Number(record.expiresAtMs) > Number(record.createdAtMs)
  );
}

function validFlowRecord(value: unknown): value is AdminLoginFlowRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<AdminLoginFlowRecord>;
  return (
    record.schema === FLOW_SCHEMA &&
    validOpaqueToken(String(record.state || '')) &&
    validOpaqueToken(String(record.nonce || '')) &&
    /^[A-Za-z0-9_-]{43,128}$/.test(String(record.codeVerifier || '')) &&
    typeof record.redirectUri === 'string' &&
    record.redirectUri.length <= 2048 &&
    typeof record.nextPath === 'string' &&
    record.nextPath.startsWith('/admin') &&
    Number.isSafeInteger(record.createdAtMs) &&
    Number.isSafeInteger(record.expiresAtMs) &&
    Number(record.expiresAtMs) > Number(record.createdAtMs)
  );
}

function parseStoredJson(raw: string): unknown {
  if (!raw || raw.length > 8192) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readAdminSessionId(request: Request): string {
  const value = cookieMap(request).get(ADMIN_SESSION_COOKIE) || '';
  return validOpaqueToken(value) ? value : '';
}

export function readAdminLoginFlowId(request: Request): string {
  const value = cookieMap(request).get(ADMIN_OIDC_FLOW_COOKIE) || '';
  return validOpaqueToken(value) ? value : '';
}

export async function createAdminSession(
  request: Request,
  ownerTelegramId: string,
  nowMs = Date.now()
): Promise<{ sessionId: string; csrfToken: string; record: AdminSessionRecord }> {
  if (!/^\d{3,20}$/.test(ownerTelegramId)) throw new Error('ADMIN_OWNER_ID_INVALID');
  const sessionId = opaqueToken();
  const csrfToken = opaqueToken();
  const ttlSec = resolveAdminSessionTtlSec();
  const record: AdminSessionRecord = {
    schema: SESSION_SCHEMA,
    ownerTelegramId,
    csrfHash: digest(csrfToken),
    userAgentHash: userAgentHash(request),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlSec * 1000,
  };
  await storeValue(sessionKey(sessionId), JSON.stringify(record), ttlSec);
  return { sessionId, csrfToken, record };
}

export async function validateAdminSession(request: Request, nowMs = Date.now()): Promise<AdminSessionValidation> {
  const sessionId = readAdminSessionId(request);
  if (!sessionId) return { ok: false, code: 'MISSING' };

  let raw: string | null;
  try {
    raw = await readValue(sessionKey(sessionId));
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
  if (!raw) return { ok: false, code: 'INVALID' };

  const record = parseStoredJson(raw);
  if (!validSessionRecord(record)) return { ok: false, code: 'INVALID' };
  if (record.expiresAtMs <= nowMs) {
    await deleteValue(sessionKey(sessionId)).catch(() => {});
    return { ok: false, code: 'EXPIRED' };
  }
  if (!timingSafeCompare(record.userAgentHash, userAgentHash(request))) {
    return { ok: false, code: 'INVALID' };
  }
  if (!isTelegramAdminOwnerAllowed(record.ownerTelegramId)) {
    await deleteValue(sessionKey(sessionId)).catch(() => {});
    return { ok: false, code: 'INVALID' };
  }
  return { ok: true, sessionId, record };
}

export function validateAdminCsrf(request: Request, record: AdminSessionRecord): boolean {
  const candidate = (request.headers.get('x-csrf-token') || '').trim();
  return timingSafeCompare(record.csrfHash, digest(candidate));
}

export async function revokeAdminSession(sessionId: string): Promise<void> {
  if (!validOpaqueToken(sessionId)) return;
  await deleteValue(sessionKey(sessionId));
}

export async function createAdminLoginFlow(
  redirectUri: string,
  nextPath: string,
  nowMs = Date.now()
): Promise<{ flowId: string; record: AdminLoginFlowRecord }> {
  const flowId = opaqueToken();
  const ttlSec = resolveAdminLoginFlowTtlSec();
  const record: AdminLoginFlowRecord = {
    schema: FLOW_SCHEMA,
    state: opaqueToken(),
    nonce: opaqueToken(),
    codeVerifier: opaqueToken(),
    redirectUri,
    nextPath,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlSec * 1000,
  };
  await storeValue(flowKey(flowId), JSON.stringify(record), ttlSec);
  return { flowId, record };
}

export async function consumeAdminLoginFlow(flowId: string, nowMs = Date.now()): Promise<AdminLoginFlowRecord | null> {
  if (!validOpaqueToken(flowId)) return null;
  const raw = await consumeValue(flowKey(flowId));
  const record = parseStoredJson(raw || '');
  if (!validFlowRecord(record) || record.expiresAtMs <= nowMs) return null;
  return record;
}

export function serializeAdminCookie(
  name: string,
  value: string,
  options: { maxAgeSec: number; secure: boolean; path: string }
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function serializeAdminCsrfCookie(value: string, options: { maxAgeSec: number; secure: boolean }): string {
  const parts = [
    `${ADMIN_CSRF_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`,
    'SameSite=Strict',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function shouldUseSecureAdminCookies(request: Request): boolean {
  return isProd('ADMIN_AUTH_FORCE_PROD_MODE') || new URL(request.url).protocol === 'https:';
}

export function __resetAdminSessionMemoryForTests() {
  memoryValues.clear();
}
