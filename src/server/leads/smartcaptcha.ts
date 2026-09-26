const DEFAULT_SMARTCAPTCHA_TIMEOUT_MS = 4000;
const DEFAULT_SMARTCAPTCHA_VERIFY_URL = 'https://smartcaptcha.cloud.yandex.ru/validate';
const MAX_SMARTCAPTCHA_RESPONSE_BYTES = 8192;
const MAX_SMARTCAPTCHA_TOKEN_LENGTH = 4096;

type RuntimeEnv = Record<string, string | undefined>;
type FetchImplementation = typeof fetch;

export type SmartCaptchaVerificationResult =
  | {
      ok: true;
      host: string;
    }
  | {
      ok: false;
      status: number;
      code: 'BOT_PROTECTION_NOT_CONFIGURED' | 'BOT_PROTECTION_FAILED' | 'BOT_PROTECTION_UNAVAILABLE';
      message: string;
      diagnostic: string;
    };

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function normalizeHostname(value: string): string {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!raw) return '';

  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return '';
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function isSmartCaptchaRequired(env: RuntimeEnv = process.env): boolean {
  if (import.meta.env.PROD || env.NODE_ENV === 'production') return true;
  return parseBoolean(env.CONTACT_SMARTCAPTCHA_REQUIRED, true);
}

export function resolveSmartCaptchaClientKey(env: RuntimeEnv = process.env): string {
  return String(env.SMARTCAPTCHA_CLIENT_KEY || '').trim();
}

export function resolveSmartCaptchaServerKey(env: RuntimeEnv = process.env): string {
  return String(env.SMARTCAPTCHA_SERVER_KEY || '').trim();
}

export function resolveSmartCaptchaAllowedHosts(env: RuntimeEnv = process.env): string[] {
  return Array.from(
    new Set(
      String(env.SMARTCAPTCHA_ALLOWED_HOSTS || '')
        .split(',')
        .map((item) => normalizeHostname(item))
        .filter(Boolean)
    )
  );
}

export function resolveSmartCaptchaTimeoutMs(env: RuntimeEnv = process.env): number {
  return parsePositiveInt(env.SMARTCAPTCHA_TIMEOUT_MS, DEFAULT_SMARTCAPTCHA_TIMEOUT_MS, 500);
}

export function resolveSmartCaptchaVerifyUrl(env: RuntimeEnv = process.env): string {
  const configured = String(env.SMARTCAPTCHA_VERIFY_URL || '').trim();
  const allowLocalOverride = parseBoolean(env.SMARTCAPTCHA_ALLOW_LOCAL_VERIFY_OVERRIDE, false);
  if (!configured || !allowLocalOverride || env.NODE_ENV === 'production') return DEFAULT_SMARTCAPTCHA_VERIFY_URL;

  try {
    const parsed = new URL(configured);
    if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackHostname(parsed.hostname)) {
      return DEFAULT_SMARTCAPTCHA_VERIFY_URL;
    }
    return parsed.toString();
  } catch {
    return DEFAULT_SMARTCAPTCHA_VERIFY_URL;
  }
}

export function isSmartCaptchaReady(env: RuntimeEnv = process.env): boolean {
  if (!isSmartCaptchaRequired(env)) return true;
  const clientKey = resolveSmartCaptchaClientKey(env);
  const serverKey = resolveSmartCaptchaServerKey(env);
  const allowedHosts = resolveSmartCaptchaAllowedHosts(env);
  return (
    clientKey.startsWith('ysc1_') &&
    serverKey.startsWith('ysc2_') &&
    clientKey.length >= 25 &&
    serverKey.length >= 25 &&
    clientKey.slice(5, 25) === serverKey.slice(5, 25) &&
    allowedHosts.length > 0
  );
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_SMARTCAPTCHA_RESPONSE_BYTES) {
    throw new Error('RESPONSE_TOO_LARGE');
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_SMARTCAPTCHA_RESPONSE_BYTES) {
        await reader.cancel('response_too_large').catch(() => undefined);
        throw new Error('RESPONSE_TOO_LARGE');
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
}

export async function verifySmartCaptchaToken(
  token: string,
  ipAddress: string,
  options: {
    env?: RuntimeEnv;
    fetchImpl?: FetchImplementation;
  } = {}
): Promise<SmartCaptchaVerificationResult> {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const secret = resolveSmartCaptchaServerKey(env);

  if (!secret) {
    return {
      ok: false,
      status: 500,
      code: 'BOT_PROTECTION_NOT_CONFIGURED',
      message: 'Защита формы не настроена.',
      diagnostic: 'server_key_missing',
    };
  }

  const normalizedToken = String(token || '').trim();
  if (!normalizedToken || normalizedToken.length > MAX_SMARTCAPTCHA_TOKEN_LENGTH) {
    return {
      ok: false,
      status: 400,
      code: 'BOT_PROTECTION_FAILED',
      message: 'Не удалось подтвердить проверку. Пройдите её ещё раз.',
      diagnostic: normalizedToken ? 'token_too_long' : 'token_missing',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveSmartCaptchaTimeoutMs(env));
  const payload = new URLSearchParams({
    secret,
    token: normalizedToken,
  });
  if (ipAddress) payload.set('ip', ipAddress);

  try {
    const response = await fetchImpl(resolveSmartCaptchaVerifyUrl(env), {
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
        message: 'Проверка формы временно недоступна. Попробуйте ещё раз.',
        diagnostic: `provider_http_${response.status}`,
      };
    }

    let result: { status?: unknown; host?: unknown };
    try {
      const rawBody = await readBoundedResponseText(response);
      result = JSON.parse(rawBody) as { status?: unknown; host?: unknown };
    } catch {
      return {
        ok: false,
        status: 503,
        code: 'BOT_PROTECTION_UNAVAILABLE',
        message: 'Проверка формы временно недоступна. Попробуйте ещё раз.',
        diagnostic: 'provider_invalid_response',
      };
    }

    if (result.status !== 'ok') {
      if (result.status === 'failed') {
        return {
          ok: false,
          status: 400,
          code: 'BOT_PROTECTION_FAILED',
          message: 'Не удалось подтвердить проверку. Пройдите её ещё раз.',
          diagnostic: 'provider_rejected',
        };
      }

      return {
        ok: false,
        status: 503,
        code: 'BOT_PROTECTION_UNAVAILABLE',
        message: 'Проверка формы временно недоступна. Попробуйте ещё раз.',
        diagnostic: 'provider_unknown_status',
      };
    }

    const host = normalizeHostname(typeof result.host === 'string' ? result.host : '');
    const allowedHosts = resolveSmartCaptchaAllowedHosts(env);
    if (!host || !allowedHosts.includes(host)) {
      return {
        ok: false,
        status: 400,
        code: 'BOT_PROTECTION_FAILED',
        message: 'Не удалось подтвердить проверку. Пройдите её ещё раз.',
        diagnostic: host ? 'host_not_allowed' : 'host_missing',
      };
    }

    return { ok: true, host };
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError';
    return {
      ok: false,
      status: 503,
      code: 'BOT_PROTECTION_UNAVAILABLE',
      message: 'Проверка формы временно недоступна. Попробуйте ещё раз.',
      diagnostic: isTimeout ? 'provider_timeout' : 'provider_network_error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const SMARTCAPTCHA_OFFICIAL_VERIFY_URL = DEFAULT_SMARTCAPTCHA_VERIFY_URL;
