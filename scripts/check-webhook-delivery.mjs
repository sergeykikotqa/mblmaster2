import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const host = process.env.WEBHOOK_SMOKE_HOST || '127.0.0.1';
const port = Number(process.env.WEBHOOK_SMOKE_PORT || 4361);
const baseUrl = `http://${host}:${port}`;
const serverStartTimeoutMs = Number(process.env.WEBHOOK_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.WEBHOOK_SMOKE_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const retryBackoffMs = Number(process.env.WEBHOOK_SMOKE_RETRY_WAIT_MS || 1300);
const retryBaseDelaySec = Number(process.env.WEBHOOK_SMOKE_RETRY_BASE_DELAY_SEC || 1);
const maxRetries = Number(process.env.WEBHOOK_SMOKE_MAX_RETRIES || 4);
const testWebhookUrl = 'https://mbl-test-webhook.invalid/webhook';
const testWebhookProxyRequire = '--require=./scripts/test-webhook-fetch-proxy.cjs';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const astroCliPath = join(projectRoot, 'node_modules', 'astro', 'bin', 'astro.mjs');
const astroDevMetadataPath = join(projectRoot, '.astro', 'dev.json');
const childExitTimeoutMs = 10000;
const portReleaseTimeoutMs = 5000;
const ansiColorPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const serverLogs = [];

class BlockedByEnvironmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedByEnvironmentError';
    this.code = 'BLOCKED_BY_ENV';
  }
}

function addServerLogs(source, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    serverLogs.push(`[${source}] ${line}`);
  }

  if (serverLogs.length > 200) {
    serverLogs.splice(0, serverLogs.length - 200);
  }
}

function tailServerLogs() {
  return serverLogs.slice(-40).join('\n') || '(no server logs)';
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function findExistingProjectAstro() {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(astroDevMetadataPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Unable to inspect Astro dev metadata at ${astroDevMetadataPath}`, { cause: error });
  }

  const pid = Number(metadata?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessRunning(pid)) return null;

  return {
    pid,
    url: typeof metadata?.url === 'string' && metadata.url ? metadata.url : '(address unavailable)',
  };
}

async function canBindPort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (error) => {
      if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') {
        resolve(false);
        return;
      }
      reject(error);
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

async function assertSmokeEnvironment() {
  const existingAstro = await findExistingProjectAstro();
  if (existingAstro) {
    throw new BlockedByEnvironmentError(
      `Astro for this project is already running at ${existingAstro.url} (pid ${existingAstro.pid}). ` +
        'Stop it from its owning terminal with Ctrl+C, verify that ports 4321 and 4361 are free, then rerun the smoke. ' +
        'The existing server was not stopped and a second Astro server was not started.'
    );
  }

  if (!(await canBindPort())) {
    throw new BlockedByEnvironmentError(
      `Test server port ${host}:${port} is already in use. Free that port manually and rerun the smoke. ` +
        'No Astro server was started, and an existing /api/health response was not accepted.'
    );
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function getHeaderValue(headers, name) {
  const value = headers?.[String(name || '').toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] || '';
  }
  return typeof value === 'string' ? value : '';
}

function parseIsoMs(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Number(new Date(value).getTime());
}

function fetchWithTimeout(url, init = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
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
  let failuresLeft = 1;
  const attempts = [];

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

    const statusCode = failuresLeft > 0 ? 500 : 200;
    if (failuresLeft > 0) failuresLeft -= 1;

    attempts.push({
      statusCode,
      payload,
      rawBody,
      headers: req.headers,
      receivedAt: new Date().toISOString(),
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

  const webhookUrl = `http://${host}:${address.port}/webhook`;

  return {
    server,
    attempts,
    webhookUrl,
    async stop() {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function startAstroServer(webhookUrl, adminToken) {
  const workerToken =
    String(process.env.CONTACT_WORKER_TOKEN || '').trim() || `webhook-worker-${Date.now().toString(36)}`;
  const webhookSecret = `webhook-secret-${Date.now().toString(36)}-ci`;
  const child = spawn(process.execPath, [astroCliPath, 'dev', '--host', host, '--port', String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      ASTRO_DEV_BACKGROUND: '0',
      CONTACT_WEBHOOK_URL: testWebhookUrl,
      CONTACT_WEBHOOK_SECRET: webhookSecret,
      MBL_TEST_WEBHOOK_HTTPS_URL: testWebhookUrl,
      MBL_TEST_WEBHOOK_HTTP_TARGET: webhookUrl,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, testWebhookProxyRequire].filter(Boolean).join(' '),
      METRICS_ADMIN_TOKEN: adminToken,
      CONTACT_RETRY_BASE_DELAY_SEC: String(retryBaseDelaySec),
      CONTACT_DELIVERY_MAX_RETRIES: String(maxRetries),
      CONTACT_WORKER_BATCH_SIZE: '20',
      CONTACT_WORKER_TOKEN: workerToken,
      CONTACT_WORKER_URL: 'http://127.0.0.1:1/__mbl_test_no_auto_worker__',
      CONTACT_WORKER_TRIGGER_TIMEOUT_MS: '100',
      CONTACT_SMARTCAPTCHA_REQUIRED: 'false',
      REDIS_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: false,
  });

  const runtime = {
    child,
    workerToken,
    webhookSecret,
    readyObserved: false,
    exitRecord: null,
    spawnError: null,
  };

  const observeLogs = (source, chunk) => {
    const text = String(chunk);
    addServerLogs(source, text);
    const plainText = text.replace(ansiColorPattern, '');
    if (/astro\s+v[^\r\n]*ready in/i.test(plainText)) runtime.readyObserved = true;
  };

  child.stdout?.on('data', (chunk) => observeLogs('stdout', chunk));
  child.stderr?.on('data', (chunk) => observeLogs('stderr', chunk));
  runtime.exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      runtime.exitRecord = { code, signal };
      resolve(runtime.exitRecord);
    });
  });
  child.once('error', (error) => {
    runtime.spawnError = error;
  });

  return runtime;
}

function formatExitRecord(record) {
  if (!record) return 'exit not observed';
  return `code=${String(record.code)}, signal=${String(record.signal)}`;
}

async function waitForAstroExit(runtime, timeoutMs = childExitTimeoutMs) {
  if (runtime.exitRecord) return runtime.exitRecord;
  if (runtime.spawnError && !runtime.child.pid) {
    throw new Error(`Astro failed to spawn: ${runtime.spawnError.message}`, { cause: runtime.spawnError });
  }

  const timeoutMarker = Symbol('child-exit-timeout');
  const result = await Promise.race([runtime.exitPromise, delay(timeoutMs, timeoutMarker)]);
  if (result === timeoutMarker) {
    throw new Error(
      `Astro child pid ${String(runtime.child.pid || 'unknown')} did not confirm exit within ${timeoutMs}ms`
    );
  }
  return result;
}

async function waitForPortRelease() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < portReleaseTimeoutMs) {
    if (await canBindPort()) return;
    await delay(100);
  }
  throw new Error(`Test server port ${host}:${port} was not released within ${portReleaseTimeoutMs}ms`);
}

async function stopAstroServer(runtime) {
  if (!runtime) return null;
  if (runtime.exitRecord) {
    await waitForPortRelease();
    return runtime.exitRecord;
  }
  if (runtime.spawnError && !runtime.child.pid) {
    throw new Error(`Astro failed to spawn: ${runtime.spawnError.message}`, { cause: runtime.spawnError });
  }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(runtime.child.pid), '/T', '/F'], {
      stdio: 'ignore',
      shell: false,
    });
    const killerResult = await new Promise((resolve, reject) => {
      killer.once('error', reject);
      killer.once('exit', (code, signal) => resolve({ code, signal }));
    }).catch((error) => ({ error }));

    try {
      const exitRecord = await waitForAstroExit(runtime);
      await waitForPortRelease();
      return exitRecord;
    } catch (error) {
      if (killerResult?.error) {
        throw new AggregateError([error, killerResult.error], 'Astro cleanup and taskkill both failed');
      }
      throw new Error(`Astro cleanup failed after taskkill (${formatExitRecord(killerResult)}): ${error.message}`, {
        cause: error,
      });
    }
  }

  try {
    process.kill(-runtime.child.pid, 'SIGTERM');
  } catch (error) {
    if (!runtime.exitRecord) throw new Error('Unable to send SIGTERM to Astro process group', { cause: error });
  }

  try {
    const exitRecord = await waitForAstroExit(runtime, 5000);
    await waitForPortRelease();
    return exitRecord;
  } catch (gracefulError) {
    try {
      process.kill(-runtime.child.pid, 'SIGKILL');
    } catch (error) {
      if (!runtime.exitRecord) {
        throw new AggregateError([gracefulError, error], 'Astro graceful and forced cleanup both failed');
      }
    }
    const exitRecord = await waitForAstroExit(runtime);
    await waitForPortRelease();
    return exitRecord;
  }
}

async function waitForHealth(runtime) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < serverStartTimeoutMs) {
    if (runtime.spawnError) {
      throw new Error(`Dev server failed to start: ${runtime.spawnError.message}.\n${tailServerLogs()}`, {
        cause: runtime.spawnError,
      });
    }
    if (runtime.exitRecord) {
      throw new Error(
        `Dev server exited before readiness (${formatExitRecord(runtime.exitRecord)}).\n${tailServerLogs()}`
      );
    }

    if (runtime.readyObserved) {
      try {
        const response = await fetchWithTimeout(`${baseUrl}/api/health`, { method: 'GET' });
        if (response.ok) {
          const payload = await response.json().catch(() => null);
          if (payload?.ok === true && payload?.service === 'seo-lead-pipeline') return;
        }
      } catch {
        // Own Astro announced readiness, but the endpoint is not ready yet.
      }
    }

    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for /api/health.\n${tailServerLogs()}`);
}

async function postLead() {
  const payload = {
    name: 'Webhook CI',
    phone: '+7 (912) 345-67-89',
    message: 'Webhook delivery smoke test',
    consent: true,
    attribution: {
      utm_source: 'ci',
      utm_medium: 'integration',
      utm_campaign: 'webhook_delivery',
      utm_term: '(none)',
      utm_content: '(none)',
    },
    formContext: {
      formId: 'ci-webhook-form',
      pageType: 'contacts',
      placement: 'ci-test',
    },
  };

  const response = await fetchWithTimeout(`${baseUrl}/api/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `ci-webhook-${Date.now()}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await readJsonResponse(response, 'POST /api/contact');
  return { status: response.status, body };
}

async function runWorker(limit = 20) {
  const response = await fetchWithTimeout(`${baseUrl}/api/workers/lead-delivery?limit=${String(limit)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit }),
  });

  const body = await readJsonResponse(response, 'POST /api/workers/lead-delivery');
  return { status: response.status, body };
}

async function runWorkerAuthorized(workerToken, limit = 20) {
  const response = await fetchWithTimeout(`${baseUrl}/api/workers/lead-delivery?limit=${String(limit)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${workerToken}`,
    },
    body: JSON.stringify({ limit }),
  });

  const body = await readJsonResponse(response, 'POST /api/workers/lead-delivery (authorized)');
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
  return {
    status: response.status,
    body,
  };
}

async function fetchSystemHealth(adminToken) {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/health/system`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });
  const body = await readJsonResponse(response, 'GET /api/admin/health/system');
  return {
    status: response.status,
    body,
  };
}

async function main() {
  await assertSmokeEnvironment();

  const adminToken = `webhook-admin-${Date.now().toString(36)}`;
  let mockWebhook = null;
  let astroServer = null;
  let primaryError = null;
  let passSummary = '';

  try {
    mockWebhook = await startMockWebhookServer();
    astroServer = startAstroServer(mockWebhook.webhookUrl, adminToken);
    await waitForHealth(astroServer);

    const unauthorizedWorkerRun = await runWorker(20);
    assert(
      unauthorizedWorkerRun.status === 401,
      `Unauthorized worker run must return 401, got ${unauthorizedWorkerRun.status}`
    );
    assert(
      unauthorizedWorkerRun.body?.code === 'UNAUTHORIZED',
      `Unauthorized worker run must return code=UNAUTHORIZED, got ${unauthorizedWorkerRun.body?.code}`
    );

    const contact = await postLead();
    assert(contact.status === 200, `POST /api/contact must return 200, got ${contact.status}`);
    assert(contact.body?.success === true, 'Contact API must return { success: true }');
    assert(typeof contact.body?.leadId === 'string' && contact.body.leadId.length > 0, 'Missing leadId in response');

    const firstWorkerRun = await runWorkerAuthorized(astroServer.workerToken, 20);
    assert(firstWorkerRun.status === 200, `First worker run must return 200, got ${firstWorkerRun.status}`);
    assert(firstWorkerRun.body?.success === true, 'First worker run must return { success: true }');
    assert(firstWorkerRun.body?.summary?.retried >= 1, 'First worker run must schedule retry after webhook failure');
    assert(
      mockWebhook.attempts.length === 1,
      `Expected exactly 1 webhook POST after first worker run, got ${mockWebhook.attempts.length}`
    );

    const firstAttempt = mockWebhook.attempts[0];
    assert(firstAttempt?.statusCode === 500, `First webhook attempt must be 500, got ${firstAttempt?.statusCode}`);
    assert(firstAttempt?.payload?.delivery?.attempt === 1, 'First webhook payload must include delivery.attempt=1');
    assert(
      firstAttempt?.payload?.delivery?.retryCount === 0,
      'First webhook payload must include delivery.retryCount=0'
    );
    assert(
      firstAttempt?.payload?.delivery?.maxRetries === maxRetries,
      'First webhook payload must include delivery.maxRetries'
    );
    const firstWebhookId = getHeaderValue(firstAttempt?.headers, 'x-webhook-id');
    const firstWebhookTimestamp = getHeaderValue(firstAttempt?.headers, 'x-webhook-timestamp');
    const firstWebhookSignature = getHeaderValue(firstAttempt?.headers, 'x-hub-signature-256');
    assert(firstWebhookId, 'First webhook attempt must include X-Webhook-Id');
    assert(firstWebhookTimestamp, 'First webhook attempt must include X-Webhook-Timestamp');
    assert(firstWebhookSignature, 'First webhook attempt must include X-Hub-Signature-256');
    assert(
      firstWebhookId === contact.body.leadId,
      `First webhook id must match leadId, got ${String(firstWebhookId || '')}`
    );
    const firstSignature = createHmac('sha256', astroServer.webhookSecret)
      .update(`${firstWebhookTimestamp}.${firstWebhookId}.${firstAttempt.rawBody}`)
      .digest('hex');
    assert(
      firstWebhookSignature === `sha256=${firstSignature}`,
      'First webhook signature must match HMAC(timestamp.webhookId.rawBody)'
    );

    await delay(retryBackoffMs);

    const secondWorkerRun = await runWorkerAuthorized(astroServer.workerToken, 20);
    assert(secondWorkerRun.status === 200, `Second worker run must return 200, got ${secondWorkerRun.status}`);
    assert(secondWorkerRun.body?.success === true, 'Second worker run must return { success: true }');
    assert(secondWorkerRun.body?.summary?.delivered >= 1, 'Second worker run must deliver queued lead');
    assert(
      mockWebhook.attempts.length === 2,
      `Expected exactly 2 webhook attempts, got ${mockWebhook.attempts.length}`
    );

    const secondAttempt = mockWebhook.attempts[1];
    assert(secondAttempt?.statusCode === 200, `Second webhook attempt must be 200, got ${secondAttempt?.statusCode}`);
    assert(secondAttempt?.payload?.delivery?.attempt === 2, 'Second webhook payload must include delivery.attempt=2');
    assert(
      secondAttempt?.payload?.delivery?.retryCount === 1,
      'Second webhook payload must include delivery.retryCount=1'
    );
    assert(
      secondAttempt?.payload?.delivery?.maxRetries === maxRetries,
      'Second webhook payload must include delivery.maxRetries'
    );
    assert(
      secondAttempt?.payload?.delivery?.retryBaseDelaySec === retryBaseDelaySec,
      'Second webhook payload must include delivery.retryBaseDelaySec'
    );
    const secondWebhookId = getHeaderValue(secondAttempt?.headers, 'x-webhook-id');
    const secondWebhookTimestamp = getHeaderValue(secondAttempt?.headers, 'x-webhook-timestamp');
    const secondWebhookSignature = getHeaderValue(secondAttempt?.headers, 'x-hub-signature-256');
    assert(secondWebhookId, 'Second webhook attempt must include X-Webhook-Id');
    assert(secondWebhookTimestamp, 'Second webhook attempt must include X-Webhook-Timestamp');
    assert(secondWebhookSignature, 'Second webhook attempt must include X-Hub-Signature-256');
    assert(
      secondWebhookId === contact.body.leadId,
      `Second webhook id must match leadId, got ${String(secondWebhookId || '')}`
    );
    assert(secondWebhookId === firstWebhookId, 'Webhook retries must reuse the same stable X-Webhook-Id');
    const secondSignature = createHmac('sha256', astroServer.webhookSecret)
      .update(`${secondWebhookTimestamp}.${secondWebhookId}.${secondAttempt.rawBody}`)
      .digest('hex');
    assert(
      secondWebhookSignature === `sha256=${secondSignature}`,
      'Second webhook signature must match HMAC(timestamp.webhookId.rawBody)'
    );

    const firstAttemptMs = parseIsoMs(firstAttempt?.receivedAt);
    const secondAttemptMs = parseIsoMs(secondAttempt?.receivedAt);
    assert(
      Number.isFinite(firstAttemptMs) && Number.isFinite(secondAttemptMs),
      'Webhook attempts must include valid receivedAt timestamps'
    );
    const backoffDeltaMs = secondAttemptMs - firstAttemptMs;
    assert(
      backoffDeltaMs >= retryBaseDelaySec * 1000,
      `Webhook retry backoff is too short: expected >= ${retryBaseDelaySec * 1000}ms, got ${backoffDeltaMs}ms`
    );

    const payload = secondAttempt.payload;

    assert(payload && typeof payload === 'object', 'Webhook payload must be valid JSON object');
    assert(payload?.lead?.leadId === contact.body.leadId, 'Webhook payload leadId does not match API response leadId');
    assert(payload?.attribution?.utm_source === 'ci', 'Webhook payload attribution.utm_source is missing');
    assert(payload?.attribution?.utm_medium === 'integration', 'Webhook payload attribution.utm_medium is missing');
    assert(payload?.formContext?.formId === 'ci-webhook-form', 'Webhook payload formContext.formId is missing');
    assert(payload?.formContext?.placement === 'ci-test', 'Webhook payload formContext.placement is missing');

    const health = await fetchLeadPipelineHealth(adminToken);
    assert(
      health.status === 200 || health.status === 503,
      `Lead pipeline health endpoint must return 200/503, got ${health.status}`
    );
    assert(typeof health.body?.retryRateLastHour === 'number', 'Lead pipeline health must include retryRateLastHour');
    assert(typeof health.body?.dlqLastHour === 'number', 'Lead pipeline health must include dlqLastHour');
    assert(
      health.body?.p95LatencyMs === null || typeof health.body?.p95LatencyMs === 'number',
      'Lead pipeline health must include p95LatencyMs'
    );
    assert(health.body?.dlqLastHour === 0, `Expected dlqLastHour=0, got ${health.body?.dlqLastHour}`);
    assert(
      Number(health.body?.retryRateLastHour) > 0,
      `Expected retryRateLastHour > 0 due to forced retry, got ${health.body?.retryRateLastHour}`
    );
    assert(
      Number(health.body?.counters?.delivery_retry_total) >= 1,
      'Lead pipeline counters must include delivery_retry_total >= 1'
    );
    assert(
      Number(health.body?.counters?.delivery_success_total) >= 1,
      'Lead pipeline counters must include delivery_success_total >= 1'
    );

    const systemHealth = await fetchSystemHealth(adminToken);
    assert(systemHealth.status === 200, `System health endpoint must return 200, got ${systemHealth.status}`);
    assert(systemHealth.body?.ok === true, 'System health must return ok=true');

    passSummary = `Webhook delivery smoke check passed: leadId=${contact.body.leadId}, attempts=${mockWebhook.attempts.length}, firstStatus=${firstAttempt?.statusCode}, secondStatus=${secondAttempt?.statusCode}, backoffMs=${backoffDeltaMs}, retryRate=${health.body?.retryRateLastHour}, p95=${health.body?.p95LatencyMs}, systemHealthOk=${systemHealth.body?.ok}`;
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  let astroExitRecord = null;

  if (astroServer) {
    try {
      astroExitRecord = await stopAstroServer(astroServer);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (mockWebhook) {
    try {
      await mockWebhook.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], 'Webhook smoke failed and cleanup also failed');
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Webhook smoke assertions passed, but cleanup failed');
  }
  if (primaryError) throw primaryError;

  console.log(passSummary);
  console.log(`Webhook delivery smoke cleanup passed: Astro ${formatExitRecord(astroExitRecord)}; port released=true`);
}

main().catch((error) => {
  if (error?.code === 'BLOCKED_BY_ENV') {
    console.error('Webhook delivery smoke check BLOCKED_BY_ENV.');
    console.error(error.message);
    process.exit(2);
  }

  console.error('Webhook delivery smoke check failed.');
  console.error(error);
  if (serverLogs.length > 0) {
    console.error('Recent dev server logs:');
    console.error(tailServerLogs());
  }
  process.exit(1);
});
