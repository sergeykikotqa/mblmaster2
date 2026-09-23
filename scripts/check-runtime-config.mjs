import process from 'node:process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from 'redis';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 400;
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

export function resolveContactWebhookSetting(env = process.env) {
  const primary = String(env.CONTACT_WEBHOOK_URL || '').trim();
  const legacy = String(env.CONTACT_WEBHOOK || '').trim();
  if (primary && legacy && primary !== legacy) {
    throw new Error('CONTACT_WEBHOOK_URL and legacy CONTACT_WEBHOOK must not disagree');
  }
  if (primary) return { envName: 'CONTACT_WEBHOOK_URL', value: primary };
  if (legacy) return { envName: 'CONTACT_WEBHOOK', value: legacy };
  throw new Error('Missing required env: CONTACT_WEBHOOK_URL (or legacy CONTACT_WEBHOOK)');
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

export function assertProductionContactWebhookUrl(rawValue, envName = 'CONTACT_WEBHOOK_URL') {
  const parsed = assertNotPlaceholderUrl(rawValue, envName);
  if (parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use HTTPS`);
  }
  return parsed;
}

export function assertTelegramLoginProductionConfig(env = process.env) {
  const publicSiteUrl = String(env.PUBLIC_SITE_URL || '').trim();
  const clientId = String(env.TELEGRAM_LOGIN_CLIENT_ID || '').trim();
  const clientSecret = String(env.TELEGRAM_LOGIN_CLIENT_SECRET || '').trim();
  const ownerIds = String(env.TELEGRAM_ADMIN_ALLOWED_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const redirectValue = String(env.TELEGRAM_LOGIN_REDIRECT_URI || '').trim();

  if (!/^\d{3,20}$/.test(clientId)) {
    throw new Error('TELEGRAM_LOGIN_CLIENT_ID must be a valid Telegram client ID');
  }
  if (clientSecret.length < 24 || /replace|example|changeme|placeholder|test/i.test(clientSecret)) {
    throw new Error('TELEGRAM_LOGIN_CLIENT_SECRET looks weak or placeholder');
  }
  if (ownerIds.length === 0 || ownerIds.some((value) => !/^\d{3,20}$/.test(value))) {
    throw new Error('TELEGRAM_ADMIN_ALLOWED_USER_IDS must contain valid Telegram user IDs');
  }
  if (!redirectValue) {
    throw new Error('Missing required env: TELEGRAM_LOGIN_REDIRECT_URI');
  }

  const publicUrl = parseAbsoluteHttpUrl(publicSiteUrl, 'PUBLIC_SITE_URL');
  const redirectUrl = parseAbsoluteHttpUrl(redirectValue, 'TELEGRAM_LOGIN_REDIRECT_URI');
  if (publicUrl.protocol !== 'https:' || redirectUrl.protocol !== 'https:') {
    throw new Error('Telegram Login public URL and callback must use HTTPS');
  }
  if (redirectUrl.username || redirectUrl.password || redirectUrl.search || redirectUrl.hash) {
    throw new Error('TELEGRAM_LOGIN_REDIRECT_URI must not contain credentials, query or fragment');
  }
  if (redirectUrl.pathname !== '/api/admin/auth/telegram/callback') {
    throw new Error('TELEGRAM_LOGIN_REDIRECT_URI must use /api/admin/auth/telegram/callback');
  }
  if (redirectUrl.origin !== publicUrl.origin) {
    throw new Error('TELEGRAM_LOGIN_REDIRECT_URI must use the PUBLIC_SITE_URL origin');
  }

  return { clientId, ownerIds: new Set(ownerIds), redirectUrl };
}

function assertRedisUrl(rawValue) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error('REDIS_URL must be an absolute redis:// or rediss:// URL');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash) {
    throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL');
  }
  if (parsed.pathname && parsed.pathname !== '/' && !/^\/\d+$/.test(parsed.pathname)) {
    throw new Error('REDIS_URL database path must be numeric');
  }
  if (isPlaceholderHost(parsed.hostname) && parsed.hostname !== 'localhost') {
    throw new Error('REDIS_URL cannot use a placeholder host');
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

async function assertRedisHealthy(redisUrl, timeoutMs) {
  const client = createClient({
    url: redisUrl,
    RESP: 2,
    disableOfflineQueue: true,
    socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
  });
  client.on('error', () => {});
  try {
    await withRetry('redis_ping', async () => {
      if (!client.isOpen) await client.connect();
      const result = await client.ping();
      if (String(result || '').toUpperCase() !== 'PONG') throw new Error('Redis ping returned unexpected result');
    });
  } catch {
    throw new Error('Redis ping failed');
  } finally {
    if (client.isOpen) await client.close().catch(() => client.destroy());
  }
}

async function main() {
  const timeoutMs = getTimeoutMs();
  const checks = [];

  const publicSiteUrl = readRequiredEnv('PUBLIC_SITE_URL');
  const webhookSetting = resolveContactWebhookSetting();
  const webhookUrl = webhookSetting.value;
  const webhookSecret = readRequiredEnv('CONTACT_WEBHOOK_SECRET');
  const redisUrl = readRequiredEnv('REDIS_URL');
  const smartCaptchaClientKey = readRequiredEnv('SMARTCAPTCHA_CLIENT_KEY');
  const smartCaptchaServerKey = readRequiredEnv('SMARTCAPTCHA_SERVER_KEY');
  const smartCaptchaAllowedHosts = readRequiredEnv('SMARTCAPTCHA_ALLOWED_HOSTS');
  const metricsAdminToken = readOptionalEnv('METRICS_ADMIN_TOKEN');
  const monitoringToken = readRequiredEnv('MBL_MONITORING_TOKEN');
  const ownerMetricsToken = readRequiredEnv('MBL_OWNER_METRICS_TOKEN');
  const backupStatusDir = readRequiredEnv('MBL_BACKUP_STATUS_DIR');
  const adminAllowlist = readOptionalEnv('ADMIN_ALLOWLIST_IPS');
  const allowDevBypass = parseBoolean(process.env.ALLOW_DEV_BYPASS, false);

  assertNotPlaceholderUrl(publicSiteUrl, 'PUBLIC_SITE_URL');
  checks.push('public_site_url_ok');

  assertTelegramLoginProductionConfig(process.env);
  checks.push('telegram_login_config_ok');

  const parsedWebhookUrl = assertProductionContactWebhookUrl(webhookUrl, webhookSetting.envName);
  checks.push('contact_webhook_url_ok');

  if (webhookSecret.length < 16 || /replace|example|changeme|placeholder|test/i.test(webhookSecret)) {
    throw new Error('CONTACT_WEBHOOK_SECRET looks weak or placeholder');
  }
  checks.push('contact_webhook_secret_ok');

  const alertWebhookUrls = readAlertWebhookUrls();
  checks.push('alert_channel_configured');

  assertRedisUrl(redisUrl);
  checks.push('redis_url_ok');

  if (!smartCaptchaClientKey.startsWith('ysc1_') || smartCaptchaClientKey.length < 25) {
    throw new Error('SMARTCAPTCHA_CLIENT_KEY must use the ysc1_ key format');
  }
  if (!smartCaptchaServerKey.startsWith('ysc2_') || smartCaptchaServerKey.length < 25) {
    throw new Error('SMARTCAPTCHA_SERVER_KEY must use the ysc2_ key format');
  }
  if (smartCaptchaClientKey.slice(5, 25) !== smartCaptchaServerKey.slice(5, 25)) {
    throw new Error('SmartCaptcha client/server keys do not belong to the same CAPTCHA');
  }
  if (!parseBoolean(process.env.CONTACT_SMARTCAPTCHA_REQUIRED, true)) {
    throw new Error('CONTACT_SMARTCAPTCHA_REQUIRED must remain true in production');
  }
  const allowedHosts = smartCaptchaAllowedHosts
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const publicHostname = new URL(publicSiteUrl).hostname.toLowerCase();
  if (!allowedHosts.includes(publicHostname)) {
    throw new Error(`SMARTCAPTCHA_ALLOWED_HOSTS must include ${publicHostname}`);
  }
  if (parseBoolean(process.env.SMARTCAPTCHA_ALLOW_LOCAL_VERIFY_OVERRIDE, false)) {
    throw new Error('SMARTCAPTCHA_ALLOW_LOCAL_VERIFY_OVERRIDE must be false in production configuration');
  }
  if (String(process.env.SMARTCAPTCHA_VERIFY_URL || '').trim()) {
    throw new Error('SMARTCAPTCHA_VERIFY_URL must be empty in production configuration');
  }
  checks.push('smartcaptcha_keys_and_hosts_ok');

  if (!metricsAdminToken) {
    throw new Error('Admin metrics auth is not configured: set METRICS_ADMIN_TOKEN');
  }

  if (metricsAdminToken.length < 16 || /replace|example|changeme|placeholder|test/i.test(metricsAdminToken)) {
    throw new Error('METRICS_ADMIN_TOKEN looks weak or placeholder');
  }
  checks.push('metrics_admin_token_ok');

  if (monitoringToken.length < 24 || /replace|example|changeme|placeholder|test/i.test(monitoringToken)) {
    throw new Error('MBL_MONITORING_TOKEN looks weak or placeholder');
  }
  checks.push('monitoring_token_ok');

  if (
    ownerMetricsToken.length < 24 ||
    /replace|example|changeme|placeholder|test/i.test(ownerMetricsToken) ||
    ownerMetricsToken === metricsAdminToken ||
    ownerMetricsToken === monitoringToken
  ) {
    throw new Error('MBL_OWNER_METRICS_TOKEN must be strong and distinct from admin/monitoring credentials');
  }
  checks.push('owner_metrics_token_ok');

  if (!backupStatusDir.startsWith('/') || backupStatusDir.split('/').includes('..')) {
    throw new Error('MBL_BACKUP_STATUS_DIR must be an absolute Linux path without traversal');
  }
  checks.push('backup_status_dir_ok');
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

  await assertRedisHealthy(redisUrl, timeoutMs);
  checks.push('redis_ping_ok');

  console.log(`Runtime config gate passed: ${checks.join(', ')}`);
}

const isMainModule = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  main().catch((error) => {
    console.error('Runtime config gate failed.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
