import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = process.cwd();
const ARTICLE_SEO_STATE_PATH = path.join(ROOT, 'data', 'article-seo-state.json');
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_SMOKE_BUDGET_MS = 120_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 800;

function parsePositiveInt(value, fallback, min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveBaseUrl() {
  const raw = String(process.env.DEPLOY_SMOKE_BASE_URL || '').trim();
  if (!raw) {
    throw new Error('DEPLOY_SMOKE_BASE_URL is required');
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('DEPLOY_SMOKE_BASE_URL must be a valid absolute URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('DEPLOY_SMOKE_BASE_URL must use http/https');
  }

  const normalized = parsed.toString().replace(/\/+$/, '');
  return normalized;
}

function resolveWorkerToken() {
  return String(process.env.DEPLOY_SMOKE_WORKER_TOKEN || '').trim();
}

function resolveAdminToken() {
  return String(process.env.DEPLOY_SMOKE_ADMIN_TOKEN || process.env.METRICS_ADMIN_TOKEN || '').trim();
}

function resolveExpectedYandexVerification() {
  return String(process.env.PUBLIC_YANDEX_VERIFICATION || '').trim();
}

function resolveExpectedYandexMetrikaId() {
  return String(process.env.PUBLIC_YANDEX_METRIKA_ID || '').trim();
}

function parseBoolean(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function isSmartCaptchaExpected() {
  return parseBoolean(process.env.DEPLOY_SMOKE_EXPECT_SMARTCAPTCHA, false);
}

function allowDegradedResult() {
  return parseBoolean(process.env.DEPLOY_SMOKE_ALLOW_DEGRADED, false);
}

function resolveBudgetMs() {
  return parsePositiveInt(process.env.DEPLOY_SMOKE_BUDGET_MS, DEFAULT_SMOKE_BUDGET_MS, 5_000);
}

function resolveRetryAttempts() {
  return parsePositiveInt(process.env.DEPLOY_SMOKE_RETRY_ATTEMPTS, DEFAULT_RETRY_ATTEMPTS, 1);
}

function resolveRetryBaseDelayMs() {
  return parsePositiveInt(process.env.DEPLOY_SMOKE_RETRY_BASE_DELAY_MS, DEFAULT_RETRY_BASE_DELAY_MS, 50);
}

function resolveSmartCaptchaToken() {
  return String(process.env.DEPLOY_SMOKE_SMARTCAPTCHA_TOKEN || '').trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizePathname(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

function readReadyArticlePaths() {
  if (!fs.existsSync(ARTICLE_SEO_STATE_PATH)) return [];

  try {
    const payload = JSON.parse(fs.readFileSync(ARTICLE_SEO_STATE_PATH, 'utf8'));
    return Array.isArray(payload?.readyArticlePaths)
      ? payload.readyArticlePaths.map((item) => normalizePathname(String(item || ''))).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function isTransientError(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  return (
    message.includes('abort') ||
    message.includes('timeout') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('status 429') ||
    message.includes('status 500') ||
    message.includes('status 502') ||
    message.includes('status 503') ||
    message.includes('status 504')
  );
}

function createSmokeContext() {
  const startedAtMs = Date.now();
  return {
    startedAtMs,
    deadlineMs: startedAtMs + resolveBudgetMs(),
    requestTimeoutMs: parsePositiveInt(process.env.DEPLOY_SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000),
  };
}

function assertBudget(context, label) {
  if (Date.now() > context.deadlineMs) {
    throw new Error(`Smoke budget exceeded before ${label}`);
  }
}

async function fetchWithTimeout(context, url, init = {}) {
  assertBudget(context, `request ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.requestTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHtml(context, url, init = {}) {
  const response = await fetchWithTimeout(context, url, init);
  const html = await response.text();
  return { response, html };
}

function extractCanonicalFromHtml(html) {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const match = tag.match(/\brel=(['"])(.*?)\1/i);
    if (
      !match ||
      !String(match[2] || '')
        .toLowerCase()
        .split(/\s+/)
        .includes('canonical')
    )
      continue;
    const hrefMatch = tag.match(/\bhref=(['"])(.*?)\1/i);
    if (hrefMatch) {
      return String(hrefMatch[2] || '').trim();
    }
  }
  return '';
}

function extractMetaContentByName(html, metaName) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const nameMatch = tag.match(/\bname=(['"])(.*?)\1/i);
    if (
      !nameMatch ||
      String(nameMatch[2] || '')
        .trim()
        .toLowerCase() !== String(metaName || '').toLowerCase()
    ) {
      continue;
    }
    const contentMatch = tag.match(/\bcontent=(['"])(.*?)\1/i);
    return contentMatch ? String(contentMatch[2] || '').trim() : '';
  }
  return '';
}

async function checkCanonicalRoute(context, baseUrl, routePath) {
  const expectedPath = normalizePathname(routePath);
  const { response, html } = await fetchHtml(context, `${baseUrl}${expectedPath === '/' ? '/' : expectedPath}`);
  assert(response.status === 200, `GET ${expectedPath} must return 200, got ${response.status}`);

  const finalPath = new URL(response.url).pathname || '/';
  assert(finalPath === expectedPath, `GET ${expectedPath} must resolve to "${expectedPath}", got "${finalPath}"`);

  const canonical = extractCanonicalFromHtml(html);
  assert(canonical, `GET ${expectedPath} must include rel=canonical`);
  const canonicalPath = new URL(canonical).pathname || '/';
  assert(
    canonicalPath === expectedPath,
    `GET ${expectedPath} must emit canonical "${expectedPath}", got "${canonicalPath}"`
  );
}

async function checkYandexHeadSignals(context, baseUrl, expectedVerification, expectedMetrikaId) {
  const { response, html } = await fetchHtml(context, `${baseUrl}/`);
  assert(response.status === 200, `GET / must return 200, got ${response.status}`);

  if (expectedVerification) {
    const actualVerification = extractMetaContentByName(html, 'yandex-verification');
    assert(actualVerification, 'GET / must include meta name="yandex-verification"');
    assert(
      actualVerification === expectedVerification,
      `GET / must emit expected yandex-verification content, got "${actualVerification}"`
    );
  }

  if (expectedMetrikaId) {
    const hasConsentCookieConfig = html.includes('site_analytics_consent');
    const hasWatchPixel = html.includes(`https://mc.yandex.ru/watch/${expectedMetrikaId}`);
    const hasDirectYmInit = html.includes(`ym(${Number(expectedMetrikaId)}`);
    assert(hasConsentCookieConfig, 'GET / must include analytics consent wiring');
    assert(!hasWatchPixel, 'GET / must not render Yandex watch pixel before analytics consent');
    assert(!hasDirectYmInit, 'GET / must not eagerly initialize Yandex Metrika before analytics consent');
  }
}

async function checkTrailingSlashNormalization(context, baseUrl, routePath) {
  const expectedPath = normalizePathname(routePath);
  if (expectedPath === '/') return;

  const slashVariant = `${expectedPath}/`;
  const { response, html } = await fetchHtml(context, `${baseUrl}${slashVariant}`);
  assert(response.status === 200, `GET ${slashVariant} must resolve to 200, got ${response.status}`);

  const finalPath = new URL(response.url).pathname || '/';
  assert(finalPath === expectedPath, `GET ${slashVariant} must normalize to "${expectedPath}", got "${finalPath}"`);

  const canonical = extractCanonicalFromHtml(html);
  assert(canonical, `GET ${slashVariant} must include rel=canonical`);
  const canonicalPath = new URL(canonical).pathname || '/';
  assert(
    canonicalPath === expectedPath,
    `GET ${slashVariant} must emit canonical "${expectedPath}", got "${canonicalPath}"`
  );
}

async function checkDecapCmsRobotsHeader(context, baseUrl) {
  const response = await fetchWithTimeout(context, `${baseUrl}/decapcms/`, { method: 'GET' });
  const headerValue = String(response.headers.get('x-robots-tag') || '')
    .trim()
    .toLowerCase();
  assert(response.status === 200, `GET /decapcms/ must return 200, got ${response.status}`);
  assert(
    headerValue === 'noindex, nofollow' || headerValue === 'noindex,nofollow',
    `GET /decapcms/ must emit X-Robots-Tag "noindex, nofollow", got "${headerValue || '(missing)'}"`
  );
}

async function checkAdminShellHeaders(context, baseUrl, routePath) {
  const response = await fetchWithTimeout(context, `${baseUrl}${routePath}`, { method: 'GET' });
  assert(response.status === 200, `GET ${routePath} must return 200, got ${response.status}`);

  const robots = String(response.headers.get('x-robots-tag') || '')
    .trim()
    .toLowerCase();
  const cacheControl = String(response.headers.get('cache-control') || '')
    .trim()
    .toLowerCase();
  const frameOptions = String(response.headers.get('x-frame-options') || '')
    .trim()
    .toUpperCase();
  const referrerPolicy = String(response.headers.get('referrer-policy') || '')
    .trim()
    .toLowerCase();

  assert(
    robots === 'noindex, nofollow' || robots === 'noindex,nofollow',
    `GET ${routePath} must emit X-Robots-Tag "noindex, nofollow", got "${robots || '(missing)'}"`
  );
  assert(cacheControl.includes('no-store'), `GET ${routePath} must emit Cache-Control with no-store`);
  assert(
    frameOptions === 'DENY',
    `GET ${routePath} must emit X-Frame-Options DENY, got "${frameOptions || '(missing)'}"`
  );
  assert(
    referrerPolicy === 'same-origin',
    `GET ${routePath} must emit Referrer-Policy same-origin, got "${referrerPolicy || '(missing)'}"`
  );
}

async function withRetry(context, label, operation, options = { allowRetry: isTransientError }) {
  const attempts = resolveRetryAttempts();
  const baseDelayMs = resolveRetryBaseDelayMs();
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assertBudget(context, label);
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const canRetry = attempt < attempts && options.allowRetry(lastError);
      if (!canRetry) break;
      const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
      if (Date.now() + waitMs > context.deadlineMs) {
        break;
      }
      console.warn(`[deploy-smoke] retrying ${label} attempt=${attempt + 1}/${attempts} waitMs=${waitMs}`);
      await delay(waitMs);
    }
  }

  throw lastError || new Error(`${label} failed`);
}

async function readJsonResponse(response, label) {
  const rawBody = await response.text();
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`${label}: invalid JSON (status ${response.status}): ${rawBody.slice(0, 300)}\n${String(error)}`);
  }
}

async function checkHealth(context, baseUrl) {
  const response = await fetchWithTimeout(context, `${baseUrl}/api/health`, { method: 'GET' });
  const body = await readJsonResponse(response, 'GET /api/health');
  assert(response.status === 200, `GET /api/health must return 200, got ${response.status}`);
  assert(body?.ok === true, 'GET /api/health must return ok=true');
  assert(typeof body?.service === 'string', 'GET /api/health must return service');
  assert(typeof body?.now === 'number', 'GET /api/health must return now');
}

async function checkLeadPipelineHealth(context, baseUrl, adminToken) {
  const response = await fetchWithTimeout(context, `${baseUrl}/api/admin/health/pipeline`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });
  const body = await readJsonResponse(response, 'GET /api/admin/health/pipeline');
  assert(
    response.status === 200 || response.status === 503,
    `GET /api/admin/health/pipeline must return 200/503, got ${response.status}`
  );
  assert(typeof body?.retryRateLastHour === 'number', 'Lead pipeline health must include retryRateLastHour');
  assert(typeof body?.dlqLastHour === 'number', 'Lead pipeline health must include dlqLastHour');
  assert(
    body?.p95LatencyMs === null || typeof body?.p95LatencyMs === 'number',
    'Lead pipeline health must include p95LatencyMs'
  );
  assert(
    body?.queueDepth === null || typeof body?.queueDepth === 'number',
    'Lead pipeline health must include queueDepth'
  );
  assert(
    typeof body?.queueBackpressureThreshold === 'number',
    'Lead pipeline health must include queueBackpressureThreshold'
  );
  assert(typeof body?.workerPaused === 'boolean', 'Lead pipeline health must include workerPaused');
  assert(
    typeof body?.alerts?.alertChannelConfigured === 'boolean',
    'Lead pipeline health alerts must include alertChannelConfigured'
  );
  assert(
    typeof body?.alerts?.alertEndpointReachable === 'boolean',
    'Lead pipeline health alerts must include alertEndpointReachable'
  );
  return body;
}

async function checkWorkerHealth(context, baseUrl, adminToken) {
  const response = await fetchWithTimeout(context, `${baseUrl}/api/admin/health/worker`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });
  const body = await readJsonResponse(response, 'GET /api/admin/health/worker');
  assert(
    response.status === 200 || response.status === 503,
    `GET /api/admin/health/worker must return 200/503, got ${response.status}`
  );
  assert(typeof body?.ok === 'boolean', 'Worker health must include ok');
  assert(body?.service === 'lead-worker', 'Worker health service must be lead-worker');
  assert(typeof body?.status === 'string', 'Worker health must include status');
  assert(
    typeof body?.dependencies?.webhookSecretConfigured === 'boolean',
    'Worker health dependencies must include webhookSecretConfigured'
  );
  assert(
    typeof body?.dependencies?.alertChannelConfigured === 'boolean',
    'Worker health dependencies must include alertChannelConfigured'
  );
  assert(
    typeof body?.dependencies?.alertEndpointReachable === 'boolean',
    'Worker health dependencies must include alertEndpointReachable'
  );
  assert(typeof body?.dependencies?.workerPaused === 'boolean', 'Worker health dependencies must include workerPaused');
  return { status: response.status, body };
}

function createContactPayload() {
  return {
    name: 'Deployed Smoke',
    phone: '+7 (912) 345-67-89',
    message: 'Post-deploy smoke check',
    consent: true,
    attribution: {
      utm_source: 'ci',
      utm_medium: 'post-deploy-smoke',
    },
    formContext: {
      formId: 'ci-deploy-smoke-form',
      pageType: 'ci',
      placement: 'ci',
    },
  };
}

async function postContact(context, baseUrl, options = { includeSmartCaptchaToken: true }) {
  const payload = createContactPayload();
  const smartCaptchaToken = resolveSmartCaptchaToken();
  if (options.includeSmartCaptchaToken && smartCaptchaToken) {
    payload.smartCaptchaToken = smartCaptchaToken;
  }

  const response = await fetchWithTimeout(context, `${baseUrl}/api/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `deploy-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await readJsonResponse(response, 'POST /api/contact');
  return { status: response.status, body };
}

async function runWorker(context, baseUrl, workerToken) {
  const response = await fetchWithTimeout(context, `${baseUrl}/api/workers/lead-delivery?limit=20`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${workerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 20 }),
  });
  const body = await readJsonResponse(response, 'POST /api/workers/lead-delivery');
  return { status: response.status, body };
}

async function checkInvalidPayload(context, baseUrl) {
  const response = await fetchWithTimeout(context, `${baseUrl}/api/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `deploy-smoke-invalid-${Date.now()}`,
    },
    body: JSON.stringify({
      name: 'A',
      phone: '123',
      consent: false,
    }),
  });
  const body = await readJsonResponse(response, 'POST /api/contact (invalid)');
  assert(response.status === 400, `Invalid payload must return 400, got ${response.status}`);
  assert(body?.success === false, 'Invalid payload response must return success=false');
}

async function checkSmartCaptchaNegative(context, baseUrl) {
  if (!isSmartCaptchaExpected()) return;

  const response = await fetchWithTimeout(context, `${baseUrl}/api/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `deploy-smoke-smartcaptcha-${Date.now()}`,
    },
    body: JSON.stringify(createContactPayload()),
  });

  const body = await readJsonResponse(response, 'POST /api/contact (SmartCaptcha negative)');
  assert(
    response.status === 400 || response.status === 503,
    `SmartCaptcha negative must return 400/503, got ${response.status}`
  );
  assert(
    ['BOT_PROTECTION_REQUIRED', 'BOT_PROTECTION_FAILED', 'BOT_PROTECTION_UNAVAILABLE'].includes(
      String(body?.code || '')
    ),
    `Unexpected SmartCaptcha negative error code: ${String(body?.code || '(empty)')}`
  );
}

async function main() {
  const context = createSmokeContext();
  const baseUrl = resolveBaseUrl();
  const readyArticlePaths = readReadyArticlePaths();
  const workerToken = resolveWorkerToken();
  const adminToken = resolveAdminToken();
  const expectedYandexVerification = resolveExpectedYandexVerification();
  const expectedYandexMetrikaId = resolveExpectedYandexMetrikaId();
  const expectSmartCaptcha = isSmartCaptchaExpected();
  const smartCaptchaToken = resolveSmartCaptchaToken();
  if (!adminToken) {
    throw new Error('DEPLOY_SMOKE_ADMIN_TOKEN or METRICS_ADMIN_TOKEN is required for /api/admin/health checks');
  }

  if (expectSmartCaptcha && !smartCaptchaToken) {
    throw new Error(
      'DEPLOY_SMOKE_SMARTCAPTCHA_TOKEN must contain a fresh one-time test token when SmartCaptcha is required.'
    );
  }

  await withRetry(context, 'health', async () => checkHealth(context, baseUrl));
  await withRetry(context, 'canonical_home', async () => checkCanonicalRoute(context, baseUrl, '/'));
  await withRetry(context, 'yandex_head_signals', async () =>
    checkYandexHeadSignals(context, baseUrl, expectedYandexVerification, expectedYandexMetrikaId)
  );
  await withRetry(context, 'canonical_kuhni', async () => checkCanonicalRoute(context, baseUrl, '/kuhni'));
  await withRetry(context, 'canonical_contacts', async () => checkCanonicalRoute(context, baseUrl, '/contacts'));
  await withRetry(context, 'slash_kuhni', async () => checkTrailingSlashNormalization(context, baseUrl, '/kuhni'));
  await withRetry(context, 'slash_contacts', async () =>
    checkTrailingSlashNormalization(context, baseUrl, '/contacts')
  );
  if (readyArticlePaths.length > 0) {
    await withRetry(context, 'canonical_ready_article', async () =>
      checkCanonicalRoute(context, baseUrl, readyArticlePaths[0])
    );
    await withRetry(context, 'slash_ready_article', async () =>
      checkTrailingSlashNormalization(context, baseUrl, readyArticlePaths[0])
    );
  }
  await withRetry(context, 'decapcms_header', async () => checkDecapCmsRobotsHeader(context, baseUrl));
  await withRetry(context, 'admin_shell_headers_index', async () => checkAdminShellHeaders(context, baseUrl, '/admin'));
  await withRetry(context, 'admin_shell_headers_metrics', async () =>
    checkAdminShellHeaders(context, baseUrl, '/admin/metrics')
  );
  const workerHealth = await withRetry(context, 'worker_health', async () =>
    checkWorkerHealth(context, baseUrl, adminToken)
  );
  await withRetry(context, 'invalid_payload', async () => checkInvalidPayload(context, baseUrl), {
    allowRetry: () => false,
  });
  await withRetry(context, 'smartcaptcha_negative', async () => checkSmartCaptchaNegative(context, baseUrl), {
    allowRetry: isTransientError,
  });

  const contact = await withRetry(
    context,
    'contact_happy_path',
    async () => postContact(context, baseUrl, { includeSmartCaptchaToken: true }),
    // SmartCaptcha tokens are single-use. A retry must obtain a new token.
    { allowRetry: expectSmartCaptcha ? () => false : isTransientError }
  );
  assert(contact.status === 200, `POST /api/contact must return 200, got ${contact.status}`);
  assert(contact.body?.success === true, 'POST /api/contact must return success=true');
  assert(
    typeof contact.body?.leadId === 'string' && contact.body.leadId.length > 0,
    'POST /api/contact must include leadId'
  );

  let workerSummary = 'skipped';
  if (workerToken) {
    const workerRun = await withRetry(context, 'worker_run', async () => runWorker(context, baseUrl, workerToken));
    assert(workerRun.status === 200, `POST /api/workers/lead-delivery must return 200, got ${workerRun.status}`);
    assert(workerRun.body?.success === true, 'Worker endpoint must return success=true');
    workerSummary = JSON.stringify(workerRun.body?.summary || {});
  }

  const pipelineHealth = await withRetry(context, 'pipeline_health', async () =>
    checkLeadPipelineHealth(context, baseUrl, adminToken)
  );

  console.log(
    `Deployed runtime smoke passed: baseUrl=${baseUrl}, leadId=${contact.body.leadId}, workerHealthStatus=${workerHealth.status}, workerRun=${workerSummary}, retryRate=${pipelineHealth.retryRateLastHour}, dlq=${pipelineHealth.dlqLastHour}`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (allowDegradedResult() && isTransientError(error)) {
    console.warn(`Deployed runtime smoke degraded (allowed): ${message}`);
    process.exit(0);
    return;
  }

  console.error('Deployed runtime smoke failed.');
  console.error(message);
  process.exit(1);
});
