import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 400;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const PLACEHOLDER_HOST_PATTERNS = [
  'example.com',
  'example.org',
  'example.net',
  'your-domain',
  'your-real-domain',
  'placeholder',
  'test.local',
  'localhost',
];

function parsePositiveInt(value, fallback, min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function getTimeoutMs() {
  return parsePositiveInt(process.env.RUNTIME_CONFIG_CHECK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 500);
}

function getRetryAttempts() {
  return parsePositiveInt(process.env.RUNTIME_CONFIG_CHECK_RETRY_ATTEMPTS, DEFAULT_RETRY_ATTEMPTS, 1);
}

function getRetryBaseDelayMs() {
  return parsePositiveInt(process.env.RUNTIME_CONFIG_CHECK_RETRY_BASE_DELAY_MS, DEFAULT_RETRY_BASE_DELAY_MS, 50);
}

function parseBoolean(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function allowTurnstileDegraded() {
  return parseBoolean(process.env.RUNTIME_CONFIG_ALLOW_TURNSTILE_DEGRADED, false);
}

function isPlaceholderHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  return PLACEHOLDER_HOST_PATTERNS.some((pattern) => host.includes(pattern));
}

function readRequiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function readOptionalEnv(name) {
  return String(process.env[name] || '').trim();
}

function parseAbsoluteHttpUrl(rawValue, envName) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${envName} must be an absolute URL`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${envName} must use http/https`);
  }

  return parsed;
}

function assertNotPlaceholderUrl(rawValue, envName) {
  const parsed = parseAbsoluteHttpUrl(rawValue, envName);
  if (isPlaceholderHost(parsed.hostname)) {
    throw new Error(`${envName} cannot use placeholder host (${parsed.hostname})`);
  }
  return parsed;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isTransientError(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  return (
    message.includes('abort') ||
    message.includes('timeout') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('http 429') ||
    message.includes('http 500') ||
    message.includes('http 502') ||
    message.includes('http 503') ||
    message.includes('http 504')
  );
}

async function withRetry(label, operation, retryOptions = { allowRetry: isTransientError }) {
  const attempts = getRetryAttempts();
  const baseDelayMs = getRetryBaseDelayMs();

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const canRetry = attempt < attempts && retryOptions.allowRetry(lastError);
      if (!canRetry) break;
      const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[runtime-config] retrying ${label} attempt=${attempt + 1}/${attempts} waitMs=${waitMs}`);
      await delay(waitMs);
    }
  }

  throw lastError || new Error(`${label} failed`);
}

async function assertWebhookReachable(webhookUrl, timeoutMs) {
  const methods = ['HEAD', 'GET'];
  let lastError = '';

  for (const method of methods) {
    try {
      const response = await fetchWithTimeout(
        webhookUrl,
        {
          method,
        },
        timeoutMs
      );

      if (response.status === 429 || response.status >= 500) {
        lastError = `status ${response.status}`;
        continue;
      }

      return response.status;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'UNKNOWN';
    }
  }

  throw new Error(`CONTACT_WEBHOOK_URL is not reachable (${lastError || 'no response'})`);
}

function isReachableAlertStatus(status) {
  return (status >= 200 && status < 400) || status === 401 || status === 403 || status === 405;
}

function readAlertWebhookUrls() {
  const urls = [
    { envName: 'CONTACT_ALERT_WEBHOOK_URL', value: readOptionalEnv('CONTACT_ALERT_WEBHOOK_URL') },
    { envName: 'CONTACT_ALERT_WEBHOOK_URL_SECONDARY', value: readOptionalEnv('CONTACT_ALERT_WEBHOOK_URL_SECONDARY') },
  ].filter((item) => item.value);

  if (urls.length === 0) {
    throw new Error('Missing required env: CONTACT_ALERT_WEBHOOK_URL or CONTACT_ALERT_WEBHOOK_URL_SECONDARY');
  }

  return urls.map((item) => assertNotPlaceholderUrl(item.value, item.envName));
}

async function assertAlertEndpointReachable(alertUrls, timeoutMs) {
  let lastError = '';

  for (const alertUrl of alertUrls) {
    for (const method of ['HEAD', 'GET']) {
      try {
        const response = await fetchWithTimeout(
          alertUrl,
          {
            method,
          },
          timeoutMs
        );

        if (isReachableAlertStatus(response.status)) {
          return response.status;
        }

        if (response.status >= 500) {
          lastError = `status ${response.status}`;
          continue;
        }

        lastError = `status ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'UNKNOWN';
      }
    }
  }

  throw new Error(`Alert webhook is not reachable (${lastError || 'no response'})`);
}

async function assertRedisHealthy(endpoint, token, timeoutMs) {
  await withRetry('redis_ping', async () => {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['PING']),
      },
      timeoutMs
    );

    if (!response.ok) {
      throw new Error(`Redis ping failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload?.error) {
      throw new Error(`Redis ping failed: ${payload.error}`);
    }

    const result = String(payload?.result || '').toUpperCase();
    if (result !== 'PONG') {
      throw new Error(`Redis ping returned unexpected result: ${String(payload?.result)}`);
    }
  });
}

async function assertTurnstileSecretValid(secret, timeoutMs) {
  const run = async () => {
    const payload = new URLSearchParams();
    payload.set('secret', secret);
    payload.set('response', 'runtime-config-gate-test');

    const response = await fetchWithTimeout(
      TURNSTILE_VERIFY_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: payload.toString(),
      },
      timeoutMs
    );

    if (!response.ok) {
      throw new Error(`Turnstile verification endpoint failed with HTTP ${response.status}`);
    }

    const body = await response.json();
    const errorCodes = Array.isArray(body?.['error-codes']) ? body['error-codes'].map((item) => String(item)) : [];
    if (errorCodes.includes('invalid-input-secret')) {
      throw new Error('TURNSTILE_SECRET_KEY is invalid (invalid-input-secret)');
    }
  };

  if (allowTurnstileDegraded()) {
    try {
      await withRetry('turnstile_verify', run);
      return {
        degraded: false,
      };
    } catch (error) {
      const transient = isTransientError(error);
      if (!transient) throw error;
      console.warn(
        `[runtime-config] turnstile verification degraded (transient): ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        degraded: true,
      };
    }
  }

  await withRetry('turnstile_verify', run);
  return {
    degraded: false,
  };
}

async function main() {
  const timeoutMs = getTimeoutMs();
  const checks = [];

  const publicSiteUrl = readRequiredEnv('PUBLIC_SITE_URL');
  const webhookUrl = readRequiredEnv('CONTACT_WEBHOOK_URL');
  const webhookSecret = readRequiredEnv('CONTACT_WEBHOOK_SECRET');
  const redisEndpoint = readRequiredEnv('UPSTASH_REDIS_REST_URL');
  const redisToken = readRequiredEnv('UPSTASH_REDIS_REST_TOKEN');
  const turnstileSecret = readRequiredEnv('TURNSTILE_SECRET_KEY');
  const metricsAdminToken = readOptionalEnv('METRICS_ADMIN_TOKEN');
  const adminAllowlist = readOptionalEnv('ADMIN_ALLOWLIST_IPS');
  const allowDevBypass = parseBoolean(process.env.ALLOW_DEV_BYPASS, false);

  assertNotPlaceholderUrl(publicSiteUrl, 'PUBLIC_SITE_URL');
  checks.push('public_site_url_ok');

  const parsedWebhookUrl = assertNotPlaceholderUrl(webhookUrl, 'CONTACT_WEBHOOK_URL');
  checks.push('contact_webhook_url_ok');

  if (webhookSecret.length < 16 || /replace|example|changeme|placeholder|test/i.test(webhookSecret)) {
    throw new Error('CONTACT_WEBHOOK_SECRET looks weak or placeholder');
  }
  checks.push('contact_webhook_secret_ok');

  const alertWebhookUrls = readAlertWebhookUrls();
  checks.push('alert_channel_configured');

  const parsedRedisUrl = assertNotPlaceholderUrl(redisEndpoint, 'UPSTASH_REDIS_REST_URL');
  if (parsedRedisUrl.protocol !== 'https:') {
    throw new Error('UPSTASH_REDIS_REST_URL must use https in CI runtime checks');
  }
  checks.push('redis_url_ok');

  if (turnstileSecret.length < 10 || /replace|example|changeme|placeholder/i.test(turnstileSecret)) {
    throw new Error('TURNSTILE_SECRET_KEY looks like a placeholder');
  }
  checks.push('turnstile_secret_format_ok');

  if (!metricsAdminToken) {
    throw new Error('Admin metrics auth is not configured: set METRICS_ADMIN_TOKEN');
  }

  if (metricsAdminToken.length < 16 || /replace|example|changeme|placeholder|test/i.test(metricsAdminToken)) {
    throw new Error('METRICS_ADMIN_TOKEN looks weak or placeholder');
  }
  checks.push('metrics_admin_token_ok');
  if (adminAllowlist) {
    checks.push('admin_allowlist_configured');
  }

  if (allowDevBypass) {
    throw new Error('ALLOW_DEV_BYPASS must be false in runtime config gate');
  }
  checks.push('dev_bypass_disabled');

  if (String(process.env.CONTACT_WORKER_URL || '').trim()) {
    const workerUrl = String(process.env.CONTACT_WORKER_URL || '').trim();
    if (!workerUrl.startsWith('/')) {
      assertNotPlaceholderUrl(workerUrl, 'CONTACT_WORKER_URL');
    }
    checks.push('contact_worker_url_ok');
  }

  const webhookStatus = await withRetry('webhook_reachable', async () =>
    assertWebhookReachable(parsedWebhookUrl.toString(), timeoutMs)
  );
  checks.push(`webhook_reachable_status_${webhookStatus}`);

  const alertStatus = await withRetry('alert_reachable', async () =>
    assertAlertEndpointReachable(
      alertWebhookUrls.map((item) => item.toString()),
      timeoutMs
    )
  );
  checks.push(`alert_reachable_status_${alertStatus}`);

  await assertRedisHealthy(parsedRedisUrl.toString(), redisToken, timeoutMs);
  checks.push('redis_ping_ok');

  const turnstileStatus = await assertTurnstileSecretValid(turnstileSecret, timeoutMs);
  checks.push(turnstileStatus.degraded ? 'turnstile_secret_degraded' : 'turnstile_secret_valid');

  console.log(`Runtime config gate passed: ${checks.join(', ')}`);
}

main().catch((error) => {
  console.error('Runtime config gate failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
