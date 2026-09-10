import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const host = process.env.WEBHOOK_SMOKE_HOST || '127.0.0.1';
const port = Number(process.env.WEBHOOK_SMOKE_PORT || 4361);
const baseUrl = `http://${host}:${port}`;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const serverStartTimeoutMs = Number(process.env.WEBHOOK_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.WEBHOOK_SMOKE_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const retryBackoffMs = Number(process.env.WEBHOOK_SMOKE_RETRY_WAIT_MS || 1300);
const retryBaseDelaySec = Number(process.env.WEBHOOK_SMOKE_RETRY_BASE_DELAY_SEC || 1);
const maxRetries = Number(process.env.WEBHOOK_SMOKE_MAX_RETRIES || 4);

const serverLogs = [];

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
  const child = spawn(npmCommand, ['run', 'dev', '--', '--host', host, '--port', String(port)], {
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      CONTACT_WEBHOOK_URL: webhookUrl,
      CONTACT_WEBHOOK_SECRET: webhookSecret,
      METRICS_ADMIN_TOKEN: adminToken,
      CONTACT_RETRY_BASE_DELAY_SEC: String(retryBaseDelaySec),
      CONTACT_DELIVERY_MAX_RETRIES: String(maxRetries),
      CONTACT_WORKER_BATCH_SIZE: '20',
      CONTACT_WORKER_TOKEN: workerToken,
      CONTACT_WORKER_URL: '',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });

  child.stdout?.on('data', (chunk) => addServerLogs('stdout', chunk));
  child.stderr?.on('data', (chunk) => addServerLogs('stderr', chunk));

  return {
    child,
    workerToken,
    webhookSecret,
  };
}

async function stopAstroServer(server) {
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
      // process already exited
    }
    await once(server, 'exit').catch(() => {});
  }
}

async function waitForHealth(server) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < serverStartTimeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(`Dev server exited before readiness (code ${server.exitCode}).\n${tailServerLogs()}`);
    }

    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/health`, { method: 'GET' });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (payload && typeof payload === 'object') return;
      }
    } catch {
      // continue polling
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
  const adminToken = `webhook-admin-${Date.now().toString(36)}`;
  const mockWebhook = await startMockWebhookServer();
  const astroServer = startAstroServer(mockWebhook.webhookUrl, adminToken);

  try {
    await waitForHealth(astroServer.child);

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

    console.log(
      `Webhook delivery smoke check passed: leadId=${contact.body.leadId}, attempts=${mockWebhook.attempts.length}, firstStatus=${firstAttempt?.statusCode}, secondStatus=${secondAttempt?.statusCode}, backoffMs=${backoffDeltaMs}, retryRate=${health.body?.retryRateLastHour}, p95=${health.body?.p95LatencyMs}, systemHealthOk=${systemHealth.body?.ok}`
    );
  } finally {
    await stopAstroServer(astroServer.child);
    await mockWebhook.stop();
  }
}

main().catch((error) => {
  console.error('Webhook delivery smoke check failed.');
  console.error(error);
  if (serverLogs.length > 0) {
    console.error('Recent dev server logs:');
    console.error(tailServerLogs());
  }
  process.exit(1);
});
