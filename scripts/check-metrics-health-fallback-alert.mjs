import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const host = process.env.METRICS_HEALTH_FALLBACK_ALERT_SMOKE_HOST || '127.0.0.1';
const port = Number(process.env.METRICS_HEALTH_FALLBACK_ALERT_SMOKE_PORT || 4331);
const baseUrl = `http://${host}:${port}`;
const npmCommand = 'npm';
const serverStartTimeoutMs = Number(process.env.METRICS_HEALTH_FALLBACK_ALERT_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.METRICS_HEALTH_FALLBACK_ALERT_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const openedEventsToSend = Number(process.env.METRICS_HEALTH_FALLBACK_ALERT_OPENED_EVENTS || 16);
const smokePageSlug = '/kuhni';
const workerToken = String(
  process.env.METRICS_HEALTH_FALLBACK_ALERT_WORKER_TOKEN || 'metrics_health_fallback_alert_worker_token'
).trim();
const alertToken = String(
  process.env.METRICS_HEALTH_FALLBACK_ALERT_WEBHOOK_TOKEN || 'metrics_health_fallback_alert_webhook_token'
).trim();
const cooldownSec = Number(process.env.METRICS_HEALTH_FALLBACK_ALERT_COOLDOWN_SEC || 3600);

const serverLogs = [];

function addServerLogs(source, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    serverLogs.push(`[${source}] ${line}`);
  }

  if (serverLogs.length > 250) {
    serverLogs.splice(0, serverLogs.length - 250);
  }
}

function tailServerLogs() {
  return serverLogs.slice(-50).join('\n') || '(no server logs)';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fetchWithTimeout(url, init = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

async function startMockAlertServer() {
  const events = [];

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/alert') {
      res.statusCode = 404;
      res.end('not_found');
      return;
    }

    const authorization = req.headers.authorization || '';
    if (authorization !== `Bearer ${alertToken}`) {
      res.statusCode = 401;
      res.end('unauthorized');
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

    events.push({
      receivedAt: new Date().toISOString(),
      payload,
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
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
    throw new Error('Mock alert server failed to start.');
  }

  return {
    server,
    events,
    alertWebhookUrl: `http://${host}:${address.port}/alert`,
    async stop() {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function startServer(alertWebhookUrl) {
  const child = spawn(npmCommand, ['run', 'dev', '--', '--host', host, '--port', String(port)], {
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      METRICS_HEALTH_WORKER_TOKEN: workerToken,
      REDIS_URL: 'redis://127.0.0.1:1',
      CONTACT_REDIS_PREFIX: 'lead-health-fallback-alert-smoke',
      CONTACT_ALERT_WEBHOOK_URL: alertWebhookUrl,
      CONTACT_ALERT_WEBHOOK_TOKEN: alertToken,
      CONTACT_ALERT_WEBHOOK_URL_SECONDARY: '',
      METRICS_HEALTH_STORE_FALLBACK_ALERT_COOLDOWN_SEC: String(cooldownSec),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });

  child.stdout?.on('data', (chunk) => addServerLogs('stdout', chunk));
  child.stderr?.on('data', (chunk) => addServerLogs('stderr', chunk));
  return child;
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

async function postFormOpenedEvent() {
  const response = await fetchWithTimeout(`${baseUrl}/api/track`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event: 'form_opened',
      page: smokePageSlug,
      sentAt: new Date().toISOString(),
      payload: {
        city: 'irkutsk',
        district: 'oktyabrskiy',
        service: 'kuhni-na-zakaz',
        page_slug: smokePageSlug,
        lead_page_type: 'money',
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  assert(response.ok, `POST /api/track failed with status ${response.status}`);
  assert(payload?.success === true, 'POST /api/track returned non-success payload');
}

async function seedOpenedEvents() {
  for (let i = 0; i < openedEventsToSend; i += 1) {
    await postFormOpenedEvent();
  }
}

async function runHealthEvalWorker(day) {
  const response = await fetchWithTimeout(`${baseUrl}/api/workers/metrics-health-eval`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${workerToken}`,
    },
    body: JSON.stringify({
      day,
      baselineDays: 1,
      includePageType: true,
      sendAlert: true,
    }),
  });

  const payload = await response.json().catch(() => null);
  assert(response.ok, `POST /api/workers/metrics-health-eval failed with status ${response.status}`);
  assert(payload?.success === true, 'metrics-health-eval worker returned success=false');
  return payload;
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
      // noop
    }
    await once(server, 'exit').catch(() => {});
  }
}

async function main() {
  const mockAlertServer = await startMockAlertServer();
  const server = startServer(mockAlertServer.alertWebhookUrl);
  const day = new Date().toISOString().slice(0, 10);

  try {
    await waitForHealth(server);
    await seedOpenedEvents();

    const firstRun = await runHealthEvalWorker(day);
    const secondRun = await runHealthEvalWorker(day);

    assert(
      firstRun?.healthStoreFallbackAlertSent === true,
      `First run should send fallback alert once, got ${String(firstRun?.healthStoreFallbackAlertSent)}`
    );
    assert(
      secondRun?.healthStoreFallbackAlertSent === false,
      `Second run should be blocked by cooldown, got ${String(secondRun?.healthStoreFallbackAlertSent)}`
    );

    const fallbackAlerts = mockAlertServer.events.filter(
      (entry) => String(entry?.payload?.event || '') === 'conversion_health_store_fallback_alert'
    );
    assert(fallbackAlerts.length === 1, `Expected exactly 1 fallback alert event, got ${fallbackAlerts.length}`);

    console.log(
      `Metrics health fallback alert smoke passed: firstAlert=${String(firstRun.healthStoreFallbackAlertSent)}, secondAlert=${String(secondRun.healthStoreFallbackAlertSent)}, fallbackEvents=${fallbackAlerts.length}, totalAlertEvents=${mockAlertServer.events.length}`
    );
  } finally {
    await stopServer(server);
    await mockAlertServer.stop();
  }
}

main().catch((error) => {
  console.error('Metrics health fallback alert smoke check failed.');
  console.error(error);
  if (serverLogs.length > 0) {
    console.error('Recent dev server logs:');
    console.error(tailServerLogs());
  }
  process.exit(1);
});
