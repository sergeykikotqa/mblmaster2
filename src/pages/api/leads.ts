import { createHash, randomUUID } from 'crypto';

import { getLeadStore, hasRedisLeadStoreConfig, isRedisRuntimeError } from '~/server/leads/store';
import type { ContactSuccessResponse, LeadRecord } from '~/server/leads/types';
import { notifyBotProtectionDegraded, notifyLeadStoreDegraded } from '~/server/leads/alerts';
import { hasWebhookSecretConfig, isWebhookConfigured } from '~/server/leads/webhook';
import { appendLeadBackup } from '~/server/leads/backup-log';
import { recordFunnelMetric, resolveFunnelDimensions } from '~/server/metrics/funnel';
import { parseBooleanEnv } from '~/server/utils/auth';
import { resolveClientIp as resolveClientIpFromRequest } from '~/server/utils/ip';

export const prerender = false;

type ContactRequestBody = {
  name?: string;
  phone?: string;
  message?: string;
  comment?: string;
  consent?: boolean | string;
  website?: string;
  turnstileToken?: string;
  'cf-turnstile-response'?: string;
  redirectTo?: string;
  errorRedirectTo?: string;
  _redirect?: string;
  attribution?: Record<string, unknown> | string;
  formContext?: Record<string, unknown> | string;
  city?: string;
  district?: string;
  service?: string;
  pageType?: string;
  pageSlug?: string;
  [key: string]: unknown;
};

type ContactRouteContext = {
  request: Request;
  clientAddress?: string;
};

type RateLimitIdentity = {
  ip: string;
  rateLimitKey: string | null;
  rateLimitSource: 'ip' | 'fingerprint' | 'disabled';
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MAX_META_KEYS = 20;
const MAX_META_VALUE_LENGTH = 300;
const DEFAULT_IDEMPOTENCY_WINDOW_SEC = 120;
const DEFAULT_LEAD_RECORD_TTL_SEC = 60 * 60 * 24 * 30;
const DEFAULT_RATE_LIMIT_MAX = 5;
const DEFAULT_RATE_LIMIT_WINDOW_SEC = 10 * 60;
const DEFAULT_WORKER_TRIGGER_TIMEOUT_MS = 800;
const DEFAULT_WORKER_TRIGGER_LIMIT = 3;
const DEFAULT_TURNSTILE_TIMEOUT_MS = 4000;
const DEFAULT_TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DEFAULT_TURNSTILE_DEGRADED_ALERT_COOLDOWN_SEC = 900;
const DEFAULT_LEAD_STORE_DEGRADED_ALERT_COOLDOWN_SEC = 900;
const DEFAULT_QUEUE_MAX_DEPTH = 1000;
const DEFAULT_QUEUE_BACKPRESSURE_RETRY_AFTER_SEC = 60;

type TurnstileFailureMode = 'closed' | 'open';

const isProduction = import.meta.env.PROD;
let lastTurnstileDegradedAlertAtMs = 0;
let lastLeadStoreDegradedAlertAtMs = 0;

function jsonError(status: number, code: string, message: string, headers?: Record<string, string>) {
  return new Response(JSON.stringify({ success: false, code, message }), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...(headers || {}),
    },
  });
}

function jsonSuccess(payload: ContactSuccessResponse) {
  return new Response(JSON.stringify(payload), { status: 200, headers: JSON_HEADERS });
}

function wantsHtmlRedirect(request: Request): boolean {
  const accept = (request.headers.get('accept') || '').toLowerCase();
  const secFetchMode = (request.headers.get('sec-fetch-mode') || '').toLowerCase();
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  const isFormSubmission =
    contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');
  if (isFormSubmission) return true;
  return accept.includes('text/html') && secFetchMode !== 'cors';
}

function sanitizeRedirectPath(rawValue: unknown, fallback: string): string {
  if (typeof rawValue !== 'string') return fallback;
  const value = rawValue.trim();
  if (!value) return fallback;

  const normalizePathAndSearch = (pathname: string, search: string) => {
    const safePath = `/${String(pathname || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .trim()}`;
    return `${safePath}${search || ''}`;
  };

  if (value.startsWith('/')) {
    if (value.startsWith('//')) return fallback;
    try {
      const parsed = new URL(value, 'https://local.internal');
      if (parsed.origin !== 'https://local.internal') return fallback;
      return normalizePathAndSearch(parsed.pathname, parsed.search);
    } catch {
      return fallback;
    }
  }

  try {
    const parsed = new URL(value);
    return normalizePathAndSearch(parsed.pathname, parsed.search);
  } catch {
    return fallback;
  }
}

function withQueryParam(pathname: string, key: string, value: string): string {
  const parsed = new URL(pathname, 'https://local.internal');
  parsed.searchParams.set(key, value);
  return `${parsed.pathname}${parsed.search}`;
}

function toAbsoluteRedirectUrl(targetPath: string, request: Request, fallbackPath: string): string {
  try {
    return new URL(targetPath, request.url).toString();
  } catch {
    return new URL(fallbackPath, request.url).toString();
  }
}

function normalizePhone(phone: string): string | null {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return `+7${digits.slice(1)}`;
  }
  return null;
}

function parseConsent(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'on' || normalized === 'yes';
  }
  return false;
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function shouldTrustProxyHeaders(): boolean {
  return parseBooleanEnv(process.env.CONTACT_TRUST_PROXY_HEADERS, false);
}

async function recordFormSubmittedMetricSafe(dimensions: ReturnType<typeof resolveFunnelDimensions>): Promise<void> {
  if (!dimensions) return;
  try {
    await recordFunnelMetric({
      eventName: 'form_submitted',
      pageSlug: dimensions.pageSlug,
      city: dimensions.city,
      district: dimensions.district,
      service: dimensions.service,
      pageType: dimensions.pageType,
    });
  } catch (error) {
    console.warn('[contact] funnel_metric_record_failed', {
      code: error instanceof Error ? error.message : 'UNKNOWN',
      pageSlug: dimensions.pageSlug,
    });
  }
}

function resolveTurnstileSecret(): string {
  return (process.env.TURNSTILE_SECRET_KEY || '').trim();
}

function resolveTurnstileTimeoutMs(): number {
  return parsePositiveInt(process.env.TURNSTILE_TIMEOUT_MS, DEFAULT_TURNSTILE_TIMEOUT_MS, 500);
}

function isTurnstileRequired(): boolean {
  return parseBooleanEnv(process.env.CONTACT_TURNSTILE_REQUIRED, isProduction);
}

function resolveTurnstileFailureMode(): TurnstileFailureMode {
  const configured = (process.env.CONTACT_TURNSTILE_FAILURE_MODE || '').trim().toLowerCase();
  if (configured === 'open') return 'open';
  if (configured === 'closed') return 'closed';
  return isProduction ? 'closed' : 'open';
}

function resolveTurnstileVerifyUrl(): string {
  const configured = (process.env.TURNSTILE_VERIFY_URL || '').trim();
  if (!configured) return DEFAULT_TURNSTILE_VERIFY_URL;

  try {
    const parsed = new URL(configured);
    return parsed.toString();
  } catch {
    return DEFAULT_TURNSTILE_VERIFY_URL;
  }
}

function resolveTurnstileToken(body: ContactRequestBody): string {
  const rawToken = body.turnstileToken ?? body['cf-turnstile-response'];
  return typeof rawToken === 'string' ? rawToken.trim() : '';
}

function resolveTurnstileDegradedAlertCooldownMs(): number {
  const seconds = parsePositiveInt(
    process.env.CONTACT_TURNSTILE_DEGRADED_ALERT_COOLDOWN_SEC,
    DEFAULT_TURNSTILE_DEGRADED_ALERT_COOLDOWN_SEC,
    60
  );
  return seconds * 1000;
}

function resolveLeadStoreDegradedAlertCooldownMs(): number {
  const seconds = parsePositiveInt(
    process.env.CONTACT_LEAD_STORE_DEGRADED_ALERT_COOLDOWN_SEC,
    DEFAULT_LEAD_STORE_DEGRADED_ALERT_COOLDOWN_SEC,
    60
  );
  return seconds * 1000;
}

type TurnstileVerificationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    };

async function verifyTurnstileToken(token: string, ipAddress: string): Promise<TurnstileVerificationResult> {
  const secret = resolveTurnstileSecret();
  if (!secret) {
    return {
      ok: false,
      status: 500,
      code: 'BOT_PROTECTION_NOT_CONFIGURED',
      message: 'Turnstile secret is not configured',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveTurnstileTimeoutMs());

  const payload = new URLSearchParams();
  payload.set('secret', secret);
  payload.set('response', token);
  if (ipAddress) {
    payload.set('remoteip', ipAddress);
  }

  try {
    const response = await fetch(resolveTurnstileVerifyUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: payload.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: 503,
        code: 'BOT_PROTECTION_UNAVAILABLE',
        message: `Turnstile verification failed with status ${response.status}`,
      };
    }

    const result = (await response.json()) as {
      success?: boolean;
      'error-codes'?: unknown;
    };

    if (result?.success === true) {
      return { ok: true };
    }

    const errorCodes = Array.isArray(result?.['error-codes'])
      ? result['error-codes'].map((item) => String(item)).slice(0, 5)
      : [];

    return {
      ok: false,
      status: 400,
      code: 'BOT_PROTECTION_FAILED',
      message: errorCodes.length > 0 ? `Turnstile rejected token: ${errorCodes.join(',')}` : 'Turnstile rejected token',
    };
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError';
    return {
      ok: false,
      status: 503,
      code: 'BOT_PROTECTION_UNAVAILABLE',
      message: isTimeout ? 'Turnstile verification timed out' : 'Turnstile verification request failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function maybeNotifyTurnstileDegradedAlert(params: { code: string; message: string }): Promise<boolean> {
  if (!isProduction) return false;

  const nowMs = Date.now();
  const cooldownMs = resolveTurnstileDegradedAlertCooldownMs();
  if (nowMs - lastTurnstileDegradedAlertAtMs < cooldownMs) {
    return false;
  }

  const sent = await notifyBotProtectionDegraded({
    provider: 'turnstile',
    failureMode: 'open',
    code: params.code,
    message: params.message,
    generatedAtMs: nowMs,
  });

  if (sent) {
    lastTurnstileDegradedAlertAtMs = nowMs;
  }

  return sent;
}

async function maybeNotifyLeadStoreDegradedAlert(params: {
  code: string;
  message: string;
  operation: string;
}): Promise<boolean> {
  if (!isProduction) return false;

  const nowMs = Date.now();
  const cooldownMs = resolveLeadStoreDegradedAlertCooldownMs();
  if (nowMs - lastLeadStoreDegradedAlertAtMs < cooldownMs) {
    return false;
  }

  const sent = await notifyLeadStoreDegraded({
    code: params.code,
    message: params.message,
    operation: params.operation,
    generatedAtMs: nowMs,
  });

  if (sent) {
    lastLeadStoreDegradedAlertAtMs = nowMs;
  }

  return sent;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseObjectField(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};

  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sanitizeMetaObject(value: unknown): Record<string, string> {
  const source = parseObjectField(value);
  const sanitized: Record<string, string> = {};
  const entries = Object.entries(source).slice(0, MAX_META_KEYS);

  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue;
    const normalizedValue = String(rawValue).trim().slice(0, MAX_META_VALUE_LENGTH);
    if (!normalizedValue) continue;
    sanitized[key] = normalizedValue;
  }

  return sanitized;
}

function hashForStorage(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveRateLimitIdentity(
  request: Request,
  clientAddress: string | undefined,
  windowSec: number,
  nowMs: number
): RateLimitIdentity {
  const ip = resolveClientIpFromRequest(request, shouldTrustProxyHeaders(), clientAddress);
  if (ip) {
    return {
      ip,
      rateLimitKey: `ip:${hashForStorage(ip).slice(0, 32)}`,
      rateLimitSource: 'ip',
    };
  }

  const fingerprintParts = [
    (request.headers.get('user-agent') || '').trim(),
    (request.headers.get('accept-language') || '').trim(),
    (request.headers.get('sec-ch-ua') || '').trim(),
    (request.headers.get('accept') || '').trim(),
    (request.headers.get('sec-fetch-site') || '').trim(),
    (request.headers.get('origin') || '').trim(),
  ].filter(Boolean);

  if (fingerprintParts.length === 0) {
    return {
      ip: '',
      rateLimitKey: null,
      rateLimitSource: 'disabled',
    };
  }

  const bucket = Math.floor(nowMs / (Math.max(1, windowSec) * 1000));
  const fingerprint = hashForStorage(`${fingerprintParts.join('|')}|${bucket}`).slice(0, 32);

  return {
    ip: '',
    rateLimitKey: `fp:${fingerprint}`,
    rateLimitSource: 'fingerprint',
  };
}

function resolveIdempotencyHash(
  request: Request,
  normalizedPhone: string,
  message: string,
  timestampMs: number
): string {
  const provided = (request.headers.get('x-idempotency-key') || '').trim();
  if (provided) {
    return hashForStorage(`header:${provided.slice(0, 200)}`);
  }

  const minuteBucket = Math.floor(timestampMs / 60_000);
  return hashForStorage(`${normalizedPhone}|${message}|${minuteBucket}`);
}

function resolvePayloadFingerprint(name: string, normalizedPhone: string, message: string): string {
  return hashForStorage(`${name}|${normalizedPhone}|${message}`);
}

function resolveIdempotencyWindowSec(): number {
  const sec = parsePositiveInt(process.env.CONTACT_IDEMPOTENCY_WINDOW_SEC, DEFAULT_IDEMPOTENCY_WINDOW_SEC, 1);
  const legacyMsRaw = Number(process.env.CONTACT_IDEMPOTENCY_TTL_MS);
  if (Number.isFinite(legacyMsRaw) && legacyMsRaw > 0 && !process.env.CONTACT_IDEMPOTENCY_WINDOW_SEC) {
    return Math.max(1, Math.floor(legacyMsRaw / 1000));
  }
  return sec;
}

function resolveLeadRecordTtlSec(): number {
  return parsePositiveInt(process.env.CONTACT_LEAD_RECORD_TTL_SEC, DEFAULT_LEAD_RECORD_TTL_SEC, 0);
}

function resolveRateLimitMax(): number {
  return parsePositiveInt(process.env.CONTACT_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX, 1);
}

function resolveRateLimitWindowSec(): number {
  return parsePositiveInt(process.env.CONTACT_RATE_LIMIT_WINDOW_SEC, DEFAULT_RATE_LIMIT_WINDOW_SEC, 1);
}

function resolveWorkerToken(): string {
  return (process.env.CONTACT_WORKER_TOKEN || '').trim();
}

function isWorkerPaused(): boolean {
  return parseBooleanEnv(process.env.CONTACT_WORKER_PAUSED, false);
}

function resolveQueueMaxDepth(): number {
  return parsePositiveInt(process.env.CONTACT_QUEUE_MAX_DEPTH, DEFAULT_QUEUE_MAX_DEPTH, 1);
}

function resolveQueueBackpressureRetryAfterSec(): number {
  return parsePositiveInt(
    process.env.CONTACT_QUEUE_BACKPRESSURE_RETRY_AFTER_SEC,
    DEFAULT_QUEUE_BACKPRESSURE_RETRY_AFTER_SEC,
    1
  );
}

function resolveWorkerTriggerLimit(): number {
  return parsePositiveInt(process.env.CONTACT_WORKER_TRIGGER_LIMIT, DEFAULT_WORKER_TRIGGER_LIMIT, 1);
}

function resolveWorkerTriggerTimeoutMs(): number {
  return parsePositiveInt(process.env.CONTACT_WORKER_TRIGGER_TIMEOUT_MS, DEFAULT_WORKER_TRIGGER_TIMEOUT_MS, 100);
}

function resolveWorkerTriggerUrl(request: Request): URL {
  const fallback = new URL('/api/workers/lead-delivery', request.url);
  const configured = (process.env.CONTACT_WORKER_URL || '').trim();
  if (!configured) return fallback;

  let resolved: URL;

  try {
    if (configured.startsWith('http://') || configured.startsWith('https://')) {
      resolved = new URL(configured);
    } else {
      resolved = new URL(configured, request.url);
    }
  } catch {
    return fallback;
  }

  resolved.searchParams.delete('token');
  return resolved;
}

function triggerLeadDeliveryWorker(request: Request) {
  const workerToken = resolveWorkerToken();
  if (!workerToken) {
    if (!isProduction) {
      console.warn('[contact] worker trigger skipped: CONTACT_WORKER_TOKEN is not configured');
    }
    return;
  }

  const workerUrl = resolveWorkerTriggerUrl(request);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveWorkerTriggerTimeoutMs());

  const payload = {
    limit: resolveWorkerTriggerLimit(),
  };

  void fetch(workerUrl.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${workerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .catch((error) => {
      console.warn('[contact] worker_trigger_failed', {
        code: error instanceof Error ? error.name : 'UNKNOWN',
      });
    })
    .finally(() => clearTimeout(timeout));
}

async function readRequestBody(request: Request): Promise<ContactRequestBody> {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return (await request.json()) as ContactRequestBody;
  }

  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const body: ContactRequestBody = {};
    form.forEach((value, key) => {
      body[key] = value?.toString();
    });
    return body;
  }

  const raw = await request.text();
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw) as ContactRequestBody;
  } catch {
    throw new Error('INVALID_PAYLOAD');
  }
}

export async function post({ request, clientAddress }: ContactRouteContext) {
  const shouldRedirectHtml = wantsHtmlRedirect(request);
  const fallbackErrorRedirect = sanitizeRedirectPath(request.headers.get('referer'), '/contacts');

  try {
    const body = await readRequestBody(request);
    const successRedirect = sanitizeRedirectPath(body.redirectTo ?? body._redirect, '/thanks');
    const errorRedirect = sanitizeRedirectPath(body.errorRedirectTo, fallbackErrorRedirect);

    const fail = (status: number, code: string, message: string, headers?: Record<string, string>) => {
      if (shouldRedirectHtml) {
        const target = toAbsoluteRedirectUrl(
          withQueryParam(errorRedirect, 'contact_error', code),
          request,
          '/contacts'
        );
        return Response.redirect(target, 303);
      }
      return jsonError(status, code, message, headers);
    };

    const succeed = (payload: ContactSuccessResponse) => {
      if (shouldRedirectHtml) {
        const target = toAbsoluteRedirectUrl(successRedirect, request, '/thanks');
        return Response.redirect(target, 303);
      }
      return jsonSuccess(payload);
    };

    if (isProduction && !isWebhookConfigured()) {
      return fail(500, 'WEBHOOK_NOT_CONFIGURED', 'Contact webhook is not configured');
    }

    if (isProduction && !hasWebhookSecretConfig()) {
      return fail(500, 'WEBHOOK_SECRET_NOT_CONFIGURED', 'Contact webhook signing secret is not configured');
    }

    if (isProduction && !hasRedisLeadStoreConfig()) {
      await maybeNotifyLeadStoreDegradedAlert({
        code: 'REDIS_NOT_CONFIGURED',
        message: 'Redis lead store config is missing in production',
        operation: 'preflight',
      });
      return fail(500, 'LEAD_STORE_NOT_CONFIGURED', 'Redis lead store is not configured');
    }

    if (isProduction && !resolveWorkerToken()) {
      return fail(500, 'WORKER_TOKEN_NOT_CONFIGURED', 'Lead delivery worker token is not configured');
    }

    const turnstileRequired = isTurnstileRequired();
    const turnstileFailureMode = resolveTurnstileFailureMode();
    if (turnstileRequired && !resolveTurnstileSecret()) {
      return fail(500, 'BOT_PROTECTION_NOT_CONFIGURED', 'Turnstile bot protection is not configured');
    }

    const name = (body.name || '').toString().trim();
    const phoneRaw = (body.phone || '').toString().trim();
    const message = (body.message || body.comment || '').toString().trim();
    const website = (body.website || '').toString().trim();
    const consent = parseConsent(body.consent);

    if (website) {
      return fail(400, 'SPAM_DETECTED', 'Spam protection triggered');
    }

    const clientIp = resolveClientIpFromRequest(request, shouldTrustProxyHeaders(), clientAddress);
    const leadStore = getLeadStore();
    const rateLimitWindowSec = resolveRateLimitWindowSec();
    const rateLimitCheckedAtMs = Date.now();
    const rateLimitIdentity = resolveRateLimitIdentity(
      request,
      clientAddress,
      rateLimitWindowSec,
      rateLimitCheckedAtMs
    );
    if (rateLimitIdentity.rateLimitKey) {
      try {
        const rateLimit = await leadStore.checkRateLimit(
          rateLimitIdentity.rateLimitKey,
          resolveRateLimitMax(),
          rateLimitWindowSec
        );
        if (!rateLimit.allowed) {
          return fail(429, 'RATE_LIMITED', 'Too many requests. Please retry later.', {
            'Retry-After': String(Math.max(1, rateLimit.retryAfterSec)),
          });
        }
      } catch (error) {
        if (isRedisRuntimeError(error)) {
          await maybeNotifyLeadStoreDegradedAlert({
            code: error instanceof Error ? error.message : 'REDIS_UNKNOWN_RUNTIME_ERROR',
            message: 'Lead queue runtime failure during rate limit check',
            operation: 'rate_limit',
          });
          return fail(503, 'LEAD_STORE_UNAVAILABLE', 'Lead queue is temporarily unavailable');
        }
        throw error;
      }
    }

    const queueBackpressureRetryAfterSec = resolveQueueBackpressureRetryAfterSec();
    if (isWorkerPaused()) {
      return fail(503, 'WORKER_PAUSED', 'Lead delivery worker is temporarily paused', {
        'Retry-After': String(queueBackpressureRetryAfterSec),
      });
    }

    try {
      const queueDepth = await leadStore.getQueueDepth();
      const queueMaxDepth = resolveQueueMaxDepth();
      if (queueDepth >= queueMaxDepth) {
        await maybeNotifyLeadStoreDegradedAlert({
          code: 'QUEUE_BACKPRESSURE',
          message: `Lead queue depth ${queueDepth} reached threshold ${queueMaxDepth}`,
          operation: 'queue_backpressure',
        });
        return fail(503, 'QUEUE_BACKPRESSURE', 'Lead queue is temporarily overloaded. Please retry later.', {
          'Retry-After': String(queueBackpressureRetryAfterSec),
        });
      }
    } catch (error) {
      if (isRedisRuntimeError(error)) {
        await maybeNotifyLeadStoreDegradedAlert({
          code: error instanceof Error ? error.message : 'REDIS_UNKNOWN_RUNTIME_ERROR',
          message: 'Lead queue runtime failure during queue depth check',
          operation: 'queue_depth',
        });
        return fail(503, 'LEAD_STORE_UNAVAILABLE', 'Lead queue is temporarily unavailable');
      }
      throw error;
    }

    let botProtectionBypassed = false;
    let turnstileFailureCode = '';
    if (turnstileRequired) {
      const turnstileToken = resolveTurnstileToken(body);
      if (!turnstileToken) {
        return fail(400, 'BOT_PROTECTION_REQUIRED', 'Bot protection token is required');
      }

      const turnstileCheck = await verifyTurnstileToken(turnstileToken, clientIp);
      if (!turnstileCheck.ok) {
        const providerUnavailable = turnstileCheck.code === 'BOT_PROTECTION_UNAVAILABLE';
        if (providerUnavailable && turnstileFailureMode === 'open') {
          botProtectionBypassed = true;
          turnstileFailureCode = turnstileCheck.code;
          const degradedAlertSent = await maybeNotifyTurnstileDegradedAlert({
            code: turnstileCheck.code,
            message: turnstileCheck.message,
          });
          console.warn('[contact] turnstile_fail_open', {
            code: turnstileCheck.code,
            status: turnstileCheck.status,
            message: turnstileCheck.message,
            degradedAlertSent,
          });
        } else {
          return fail(turnstileCheck.status, turnstileCheck.code, turnstileCheck.message);
        }
      }
    }

    if (!consent) {
      return fail(400, 'CONSENT_REQUIRED', 'Consent is required');
    }

    if (name.length < 2 || name.length > 80) {
      return fail(400, 'INVALID_NAME', 'Name must contain from 2 to 80 characters');
    }

    const phone = normalizePhone(phoneRaw);
    if (!phone) {
      return fail(400, 'INVALID_PHONE', 'Phone format is invalid');
    }

    if (message.length > 2000) {
      return fail(400, 'INVALID_MESSAGE', 'Message is too long');
    }

    const attribution = sanitizeMetaObject(body.attribution);
    const inferredFormContext = sanitizeMetaObject({
      city: body.city,
      district: body.district,
      service: body.service,
      pageType: body.pageType,
      pageSlug: body.pageSlug,
    });
    const explicitFormContext = sanitizeMetaObject(body.formContext);
    const formContext = {
      ...inferredFormContext,
      ...explicitFormContext,
    };
    const funnelDimensions = resolveFunnelDimensions({
      pageSlug: formContext.pageSlug || body.pageSlug || attribution.currentPath,
      city: formContext.city || body.city,
      district: formContext.district || body.district,
      service: formContext.service || body.service,
      pageType: formContext.pageType || body.pageType,
      fallbackPage: attribution.currentPath,
    });
    const nowMs = Date.now();
    const receivedAt = new Date(nowMs).toISOString();
    const leadId = randomUUID();
    const idempotencyHash = resolveIdempotencyHash(request, phone, message, nowMs);
    const payloadFingerprint = resolvePayloadFingerprint(name, phone, message);
    const successResponse: ContactSuccessResponse = {
      success: true,
      leadId,
      receivedAt,
      ...(botProtectionBypassed ? { botProtectionBypassed: true } : {}),
    };

    const webhookPayload: Record<string, unknown> = {
      schemaVersion: '2.0',
      lead: {
        leadId,
        name,
        phone,
        message,
        consent: true,
        receivedAt,
      },
      attribution,
      formContext,
      technical: {
        source: 'website',
        webhookId: leadId,
        userAgent: request.headers.get('user-agent') || '',
        ip: rateLimitIdentity.ip,
        rateLimitSource: rateLimitIdentity.rateLimitSource,
        idempotencyHash,
        payloadFingerprint,
        botProtection: {
          provider: 'turnstile',
          required: turnstileRequired,
          failureMode: turnstileFailureMode,
          bypassed: botProtectionBypassed,
          failureCode: turnstileFailureCode || undefined,
        },
      },
    };

    const leadRecord: LeadRecord = {
      leadId,
      receivedAt,
      idempotencyHash,
      payloadFingerprint,
      webhookPayload,
      status: 'pending',
      retryCount: 0,
      nextRetryAt: nowMs,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    };

    let enqueueResult:
      | {
          duplicate: false;
        }
      | {
          duplicate: true;
          response: ContactSuccessResponse;
        };
    try {
      enqueueResult = await leadStore.enqueueLeadWithIdempotency({
        idempotencyHash,
        idempotencyTtlSec: resolveIdempotencyWindowSec(),
        successResponse,
        leadRecord,
        leadRecordTtlSec: resolveLeadRecordTtlSec(),
      });
    } catch (queueError) {
      if (isRedisRuntimeError(queueError)) {
        await maybeNotifyLeadStoreDegradedAlert({
          code: queueError instanceof Error ? queueError.message : 'REDIS_UNKNOWN_RUNTIME_ERROR',
          message: 'Lead queue runtime failure; request was not accepted',
          operation: 'enqueue',
        });
        return fail(503, 'LEAD_STORE_UNAVAILABLE', 'Lead queue is temporarily unavailable');
      }
      throw queueError;
    }

    if (enqueueResult.duplicate) {
      return succeed({
        ...enqueueResult.response,
        duplicate: true,
      });
    }

    await appendLeadBackup({
      schemaVersion: '1.0',
      loggedAt: new Date().toISOString(),
      leadId,
      webhookPayload,
      queueMode: leadStore.mode,
      hasDurableStorage: leadStore.hasDurableStorage,
    });

    console.info('[contact] lead_queued', {
      leadId,
      status: 'pending',
      storage: leadStore.mode,
      hasMessage: message.length > 0,
      pageType: formContext.pageType || '',
      placement: formContext.placement || '',
      rateLimitSource: rateLimitIdentity.rateLimitSource,
    });

    await recordFormSubmittedMetricSafe(funnelDimensions);
    triggerLeadDeliveryWorker(request);
    return succeed(successResponse);
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_PAYLOAD') {
      if (shouldRedirectHtml) {
        const target = toAbsoluteRedirectUrl(
          withQueryParam(fallbackErrorRedirect, 'contact_error', 'INVALID_PAYLOAD'),
          request,
          '/contacts'
        );
        return Response.redirect(target, 303);
      }
      return jsonError(400, 'INVALID_PAYLOAD', 'Invalid request payload');
    }

    if (error instanceof Error && error.message === 'REDIS_NOT_CONFIGURED') {
      await maybeNotifyLeadStoreDegradedAlert({
        code: 'REDIS_NOT_CONFIGURED',
        message: 'Redis lead store is not configured',
        operation: 'runtime',
      });
      if (shouldRedirectHtml) {
        const target = toAbsoluteRedirectUrl(
          withQueryParam(fallbackErrorRedirect, 'contact_error', 'LEAD_STORE_NOT_CONFIGURED'),
          request,
          '/contacts'
        );
        return Response.redirect(target, 303);
      }
      return jsonError(500, 'LEAD_STORE_NOT_CONFIGURED', 'Redis lead store is not configured');
    }

    console.error('[contact] unhandled_error', error);
    if (shouldRedirectHtml) {
      const target = toAbsoluteRedirectUrl(
        withQueryParam(fallbackErrorRedirect, 'contact_error', 'INTERNAL_ERROR'),
        request,
        '/contacts'
      );
      return Response.redirect(target, 303);
    }
    return jsonError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export const POST = post;
