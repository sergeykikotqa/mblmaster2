import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = process.cwd();
const ARTICLE_SEO_STATE_PATH = path.join(ROOT, 'data', 'article-seo-state.json');
const host = process.env.PROD_RUNTIME_SMOKE_HOST || '127.0.0.1';
const port = Number(process.env.PROD_RUNTIME_SMOKE_PORT || 4370);
const baseUrl = `http://${host}:${port}`;
const serverStartTimeoutMs = Number(process.env.PROD_RUNTIME_SMOKE_TIMEOUT_MS || 60000);
const requestTimeoutMs = Number(process.env.PROD_RUNTIME_REQUEST_TIMEOUT_MS || 12000);
const pollIntervalMs = 500;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const retryBaseDelaySec = Number(process.env.PROD_RUNTIME_RETRY_BASE_DELAY_SEC || 1);
const webhookTimeoutMs = Number(process.env.PROD_RUNTIME_WEBHOOK_TIMEOUT_MS || 1000);
const simulatedTimeoutDelayMs = Number(process.env.PROD_RUNTIME_WEBHOOK_SIMULATED_TIMEOUT_DELAY_MS || 1800);
const requestedLocalMode = String(process.env.PROD_RUNTIME_LOCAL_MODE || 'dev')
  .trim()
  .toLowerCase();
const localMode = ['node', 'preview'].includes(requestedLocalMode) ? requestedLocalMode : 'dev';

const serverLogs = [];

function addServerLogs(source, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    serverLogs.push(`[${source}] ${line}`);
  }

  if (serverLogs.length > 300) {
    serverLogs.splice(0, serverLogs.length - 300);
  }
}

function tailServerLogs() {
  return serverLogs.slice(-50).join('\n') || '(no server logs)';
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

function fetchWithTimeout(url, init = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

async function fetchHtml(url, init = {}, timeoutMs = requestTimeoutMs) {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  const html = await response.text();
  return { response, html };
}

function extractCanonicalFromHtml(html) {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const relMatch = tag.match(/\brel=(['"])(.*?)\1/i);
    if (
      !relMatch ||
      !String(relMatch[2] || '')
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

async function checkCanonicalRoute(routePath) {
  const expectedPath = normalizePathname(routePath);
  const { response, html } = await fetchHtml(`${baseUrl}${expectedPath === '/' ? '/' : expectedPath}`);
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

async function checkTrailingSlashNormalization(routePath) {
  const expectedPath = normalizePathname(routePath);
  if (expectedPath === '/') return;

  const slashVariant = `${expectedPath}/`;
  const { response, html } = await fetchHtml(`${baseUrl}${slashVariant}`);
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

async function readJsonResponse(response, label) {
  const rawBody = await response.text();
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`${label}: invalid JSON (status ${response.status}): ${rawBody.slice(0, 300)}\n${String(error)}`);
  }
}

async function startMockWebhookServer() {
  const attempts = [];
  const leadAttempts = new Map();

  const server = createServer(async (req, res) => {
    if ((req.method === 'HEAD' || req.method === 'GET') && req.url === '/webhook') {
      res.statusCode = 405;
      res.end();
      return;
    }

    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.statusCode = 404;
      res.end('not_found');
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');
    let payload = null;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = null;
    }

    const leadId = String(payload?.lead?.leadId || '');
    const message = String(payload?.lead?.message || '');
    const attemptNo = (leadAttempts.get(leadId) || 0) + 1;
    leadAttempts.set(leadId, attemptNo);

    let statusCode = 200;
    let simulated = 'none';
    if (message.includes('[mock-webhook-500]') && attemptNo === 1) {
      statusCode = 500;
      simulated = 'http_500_once';
    } else if (message.includes('[mock-webhook-timeout]') && attemptNo === 1) {
      simulated = 'timeout_once';
      await delay(simulatedTimeoutDelayMs);
    }

    attempts.push({
      payload,
      rawBody,
      receivedAt: new Date().toISOString(),
      statusCode,
      leadId,
      attemptNo,
      simulated,
    });

    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: statusCode === 200 }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('Mock webhook server failed to start.');
  }

  return {
    server,
    attempts,
    webhookUrl: `http://${host}:${address.port}/webhook`,
    async stop() {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function startLocalServer(mockWebhookUrl, workerToken, adminToken) {
  const webhookSecret = `prod-runtime-webhook-secret-${Date.now().toString(36)}`;
  const npmArgs = localMode === 'node' ? ['start'] : ['run', localMode, '--', '--host', host, '--port', String(port)];
  const child = spawn(npmCommand, npmArgs, {
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      HOST: host,
      PORT: String(port),
      CONTACT_WEBHOOK_URL: mockWebhookUrl,
      CONTACT_WEBHOOK_SECRET: webhookSecret,
      CONTACT_ALERT_WEBHOOK_URL: mockWebhookUrl,
      CONTACT_WORKER_TOKEN: workerToken,
      METRICS_ADMIN_TOKEN: adminToken,
      CONTACT_WORKER_URL: '',
      CONTACT_WORKER_TRIGGER_TIMEOUT_MS: '1000',
      CONTACT_WORKER_TRIGGER_LIMIT: '3',
      CONTACT_SMARTCAPTCHA_REQUIRED: 'false',
      CONTACT_WEBHOOK_TIMEOUT_MS: String(webhookTimeoutMs),
      CONTACT_RETRY_BASE_DELAY_SEC: String(retryBaseDelaySec),
      CONTACT_DELIVERY_MAX_RETRIES: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });

  child.stdout?.on('data', (chunk) => addServerLogs('stdout', chunk));
  child.stderr?.on('data', (chunk) => addServerLogs('stderr', chunk));

  return child;
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    await once(killer, 'exit').catch(() => {});
    return;
  }

  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    return;
  }

  const graceful = Promise.race([once(server, 'exit'), delay(5000)]);
  await graceful;

  if (server.exitCode === null) {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      // Process already exited
    }
    await once(server, 'exit').catch(() => {});
  }
}

async function waitForHealth(server) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < serverStartTimeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(`Local server exited before readiness (code ${server.exitCode}).\n${tailServerLogs()}`);
    }

    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/health`, { method: 'GET' });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (payload && typeof payload === 'object') return;
      }
    } catch {
      // Keep polling until timeout
    }

    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for /api/health.\n${tailServerLogs()}`);
}

async function postLead(options = {}) {
  const message =
    typeof options.message === 'string' && options.message.trim()
      ? options.message.trim()
      : 'Production runtime smoke check';
  const idempotencyKeySuffix =
    typeof options.idempotencyKeySuffix === 'string' && options.idempotencyKeySuffix.trim()
      ? options.idempotencyKeySuffix.trim()
      : `${Date.now()}`;

  const payload = {
    name: 'Preview Smoke',
    phone: '+7 (912) 345-67-89',
    message,
    consent: true,
    attribution: {
      utm_source: 'ci',
      utm_medium: 'prod-runtime',
    },
    formContext: {
      formId: 'ci-prod-runtime-form',
      pageType: 'ci',
      placement: 'ci',
    },
  };

  const response = await fetchWithTimeout(`${baseUrl}/api/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `ci-prod-runtime-${idempotencyKeySuffix}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await readJsonResponse(response, 'POST /api/contact');
  return { status: response.status, body };
}

async function runWorker(workerToken) {
  const response = await fetchWithTimeout(`${baseUrl}/api/workers/lead-delivery?limit=20`, {
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

async function runWorkerUnauthorized() {
  const response = await fetchWithTimeout(`${baseUrl}/api/workers/lead-delivery?limit=20`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer invalid-worker-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 20 }),
  });

  const body = await readJsonResponse(response, 'POST /api/workers/lead-delivery (unauthorized)');
  return { status: response.status, body };
}

async function fetchAdminUnauthorized() {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/health`, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer invalid-admin-token',
    },
  });

  const body = await readJsonResponse(response, 'GET /api/admin/health (unauthorized)');
  return { status: response.status, body };
}

async function postInvalidLead() {
  const response = await fetchWithTimeout(`${baseUrl}/api/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `ci-prod-runtime-invalid-${Date.now()}`,
    },
    body: JSON.stringify({
      name: 'A',
      phone: '12345',
      consent: false,
      message: 'invalid payload',
    }),
  });

  const body = await readJsonResponse(response, 'POST /api/contact (invalid payload)');
  return { status: response.status, body };
}

async function fetchLeadPipelineHealth(adminToken) {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/health/pipeline`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });
  const body = await readJsonResponse(response, 'GET /api/admin/health/pipeline');
  return { status: response.status, body };
}

async function fetchWorkerHealth(adminToken) {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/health/worker`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });
  const body = await readJsonResponse(response, 'GET /api/admin/health/worker');
  return { status: response.status, body };
}

async function checkAdminShellHeaders(routePath) {
  const response = await fetchWithTimeout(`${baseUrl}${routePath}`, { method: 'GET' });
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

async function waitForWebhookLead(mockWebhook, leadId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const hit = mockWebhook.attempts.find((item) => item?.payload?.lead?.leadId === leadId);
    if (hit) return hit;
    await delay(200);
  }

  return null;
}

async function waitForWebhookLeadAttempts(mockWebhook, leadId, expectedAttempts) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    const hits = mockWebhook.attempts.filter((item) => item?.payload?.lead?.leadId === leadId);
    if (hits.length >= expectedAttempts) {
      return hits;
    }
    await delay(200);
  }

  return [];
}

function ensureProductionEnv() {
  const artifactExists = localMode === 'node' ? fs.existsSync('.output/server/entry.mjs') : fs.existsSync('dist');
  if (['node', 'preview'].includes(localMode) && !artifactExists) {
    throw new Error('Production artifact is missing. Run `npm run build` before production runtime smoke check.');
  }

  const missing = [];
  for (const key of ['REDIS_URL']) {
    if (!String(process.env[key] || '').trim()) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    if (['node', 'preview'].includes(localMode)) {
      throw new Error(`Missing required env for production runtime smoke check: ${missing.join(', ')}`);
    }

    console.warn(
      `[prod-runtime] missing ${missing.join(', ')}; running local dev smoke with memory fallback. ` +
        'Preview/deployed runtime smoke remains the source of truth for Redis-backed lead delivery.'
    );
  }
}

async function main() {
  ensureProductionEnv();
  const readyArticlePaths = readReadyArticlePaths();

  const workerToken = `preview-worker-${Date.now().toString(36)}`;
  const adminToken = `preview-admin-${Date.now().toString(36)}`;
  const mockWebhook = await startMockWebhookServer();
  const localServer = startLocalServer(mockWebhook.webhookUrl, workerToken, adminToken);

  try {
    await waitForHealth(localServer);
    await checkCanonicalRoute('/');
    await checkCanonicalRoute('/kuhni');
    await checkCanonicalRoute('/contacts');
    if (['node', 'preview'].includes(localMode)) {
      await checkTrailingSlashNormalization('/kuhni');
      await checkTrailingSlashNormalization('/contacts');
    }
    // Standalone Node does not execute the legacy static _headers policy; Nginx owns it in the next checkpoint.
    if (localMode !== 'node') {
      await checkAdminShellHeaders('/admin');
      await checkAdminShellHeaders('/admin/metrics');
    }
    if (readyArticlePaths.length > 0) {
      await checkCanonicalRoute(readyArticlePaths[0]);
      if (['node', 'preview'].includes(localMode)) {
        await checkTrailingSlashNormalization(readyArticlePaths[0]);
      }
    }

    const contact = await postLead();
    assert(contact.status === 200, `POST /api/contact must return 200, got ${contact.status}`);
    assert(contact.body?.success === true, 'POST /api/contact must return { success: true }');
    assert(
      typeof contact.body?.leadId === 'string' && contact.body.leadId.length > 0,
      'POST /api/contact must include leadId'
    );

    const workerRun = await runWorker(workerToken);
    assert(workerRun.status === 200, `POST /api/workers/lead-delivery must return 200, got ${workerRun.status}`);
    assert(workerRun.body?.success === true, 'Worker endpoint must return { success: true }');

    const deliveredAttempt = await waitForWebhookLead(mockWebhook, contact.body.leadId);
    assert(
      Boolean(deliveredAttempt),
      `Mock webhook did not receive lead ${contact.body.leadId} from preview runtime within timeout`
    );

    const invalidPayload = await postInvalidLead();
    assert(invalidPayload.status === 400, `Invalid contact payload must return 400, got ${invalidPayload.status}`);
    assert(invalidPayload.body?.success === false, 'Invalid contact payload must return success=false');

    const unauthorizedWorker = await runWorkerUnauthorized();
    assert(
      unauthorizedWorker.status === 401,
      `Unauthorized worker request must return 401, got ${unauthorizedWorker.status}`
    );
    assert(
      unauthorizedWorker.body?.code === 'UNAUTHORIZED',
      `Unauthorized worker response must return code=UNAUTHORIZED, got ${String(unauthorizedWorker.body?.code || '')}`
    );

    const unauthorizedAdmin = await fetchAdminUnauthorized();
    assert(
      unauthorizedAdmin.status === 401,
      `Unauthorized admin request must return 401, got ${unauthorizedAdmin.status}`
    );
    assert(
      unauthorizedAdmin.body?.code === 'UNAUTHORIZED',
      `Unauthorized admin response must return code=UNAUTHORIZED, got ${String(unauthorizedAdmin.body?.code || '')}`
    );

    const webhook500Lead = await postLead({
      message: 'Production runtime negative path [mock-webhook-500]',
      idempotencyKeySuffix: `mock500-${Date.now()}`,
    });
    assert(webhook500Lead.status === 200, `Webhook 500 lead enqueue must return 200, got ${webhook500Lead.status}`);
    assert(webhook500Lead.body?.success === true, 'Webhook 500 lead enqueue must return success=true');

    const webhook500FirstRun = await runWorker(workerToken);
    assert(
      webhook500FirstRun.status === 200,
      `Webhook 500 worker first run must return 200, got ${webhook500FirstRun.status}`
    );

    await delay(retryBaseDelaySec * 1000 + 300);

    const webhook500SecondRun = await runWorker(workerToken);
    assert(
      webhook500SecondRun.status === 200,
      `Webhook 500 worker second run must return 200, got ${webhook500SecondRun.status}`
    );

    const webhook500Attempts = await waitForWebhookLeadAttempts(mockWebhook, webhook500Lead.body.leadId, 2);
    assert(webhook500Attempts.length >= 2, 'Webhook 500 negative path must produce at least 2 delivery attempts');
    assert(
      webhook500Attempts[0]?.statusCode === 500,
      `First webhook 500 attempt must be 500, got ${webhook500Attempts[0]?.statusCode}`
    );
    assert(
      webhook500Attempts[1]?.statusCode === 200,
      `Second webhook 500 attempt must be 200, got ${webhook500Attempts[1]?.statusCode}`
    );

    const webhookTimeoutLead = await postLead({
      message: 'Production runtime negative path [mock-webhook-timeout]',
      idempotencyKeySuffix: `mocktimeout-${Date.now()}`,
    });
    assert(
      webhookTimeoutLead.status === 200,
      `Webhook timeout lead enqueue must return 200, got ${webhookTimeoutLead.status}`
    );
    assert(webhookTimeoutLead.body?.success === true, 'Webhook timeout lead enqueue must return success=true');

    const webhookTimeoutFirstRun = await runWorker(workerToken);
    assert(
      webhookTimeoutFirstRun.status === 200,
      `Webhook timeout worker first run must return 200, got ${webhookTimeoutFirstRun.status}`
    );

    await delay(simulatedTimeoutDelayMs + retryBaseDelaySec * 1000 + 500);

    const webhookTimeoutSecondRun = await runWorker(workerToken);
    assert(
      webhookTimeoutSecondRun.status === 200,
      `Webhook timeout worker second run must return 200, got ${webhookTimeoutSecondRun.status}`
    );

    const webhookTimeoutAttempts = await waitForWebhookLeadAttempts(mockWebhook, webhookTimeoutLead.body.leadId, 2);
    assert(
      webhookTimeoutAttempts.length >= 2,
      'Webhook timeout negative path must produce at least 2 delivery attempts'
    );

    const health = await fetchLeadPipelineHealth(adminToken);
    assert(
      health.status === 200 || health.status === 503,
      `GET /api/admin/health/pipeline must return 200/503, got ${health.status}`
    );
    assert(typeof health.body?.retryRateLastHour === 'number', 'lead-pipeline health must include retryRateLastHour');
    assert(typeof health.body?.dlqLastHour === 'number', 'lead-pipeline health must include dlqLastHour');
    assert(
      health.body?.p95LatencyMs === null || typeof health.body?.p95LatencyMs === 'number',
      'lead-pipeline health must include p95LatencyMs'
    );
    assert(
      health.body?.queueDepth === null || typeof health.body?.queueDepth === 'number',
      'lead-pipeline health must include queueDepth'
    );
    assert(
      typeof health.body?.queueBackpressureThreshold === 'number',
      'lead-pipeline health must include queueBackpressureThreshold'
    );
    assert(typeof health.body?.workerPaused === 'boolean', 'lead-pipeline health must include workerPaused');
    assert(
      typeof health.body?.alerts?.alertChannelConfigured === 'boolean',
      'lead-pipeline health alerts must include alertChannelConfigured'
    );
    assert(
      typeof health.body?.alerts?.alertEndpointReachable === 'boolean',
      'lead-pipeline health alerts must include alertEndpointReachable'
    );

    const workerHealth = await fetchWorkerHealth(adminToken);
    assert(
      workerHealth.status === 200 || workerHealth.status === 503,
      `GET /api/admin/health/worker must return 200/503, got ${workerHealth.status}`
    );
    assert(workerHealth.body?.service === 'lead-worker', 'worker health must return lead-worker service');
    assert(
      typeof workerHealth.body?.dependencies?.webhookSecretConfigured === 'boolean',
      'worker health dependencies must include webhookSecretConfigured'
    );
    assert(
      typeof workerHealth.body?.dependencies?.alertChannelConfigured === 'boolean',
      'worker health dependencies must include alertChannelConfigured'
    );
    assert(
      typeof workerHealth.body?.dependencies?.alertEndpointReachable === 'boolean',
      'worker health dependencies must include alertEndpointReachable'
    );
    assert(
      typeof workerHealth.body?.dependencies?.workerPaused === 'boolean',
      'worker health must include workerPaused'
    );
    if (workerHealth.status === 200) {
      assert(typeof workerHealth.body?.ok === 'boolean', 'worker health must include boolean ok when status=200');
      assert(
        workerHealth.body?.status === 'ok' || workerHealth.body?.status === 'degraded',
        `worker health status must be ok/degraded when status=200, got ${String(workerHealth.body?.status || '')}`
      );
    } else {
      assert(workerHealth.body?.ok === false, 'worker health must return ok=false when status=503');
      assert(workerHealth.body?.status === 'degraded', 'worker health status must be degraded when status=503');
    }

    console.log(
      `Production runtime smoke passed via local mode=${localMode}: leadId=${contact.body.leadId}, webhookAttempts=${mockWebhook.attempts.length}, retryRate=${health.body.retryRateLastHour}, dlq=${health.body.dlqLastHour}, webhook500Retries=${webhook500Attempts.length}, timeoutRetries=${webhookTimeoutAttempts.length}`
    );
  } finally {
    await stopServer(localServer);
    await mockWebhook.stop();
  }
}

main().catch((error) => {
  console.error('Production runtime smoke check failed.');
  console.error(error);
  if (serverLogs.length > 0) {
    console.error('Recent local server logs:');
    console.error(tailServerLogs());
  }
  process.exit(1);
});
