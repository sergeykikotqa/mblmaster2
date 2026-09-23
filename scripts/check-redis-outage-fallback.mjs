import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import fs from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const host = process.env.REDIS_OUTAGE_SMOKE_HOST || '127.0.0.1';
const port = Number(process.env.REDIS_OUTAGE_SMOKE_PORT || 4324);
const baseUrl = `http://${host}:${port}`;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const serverStartTimeoutMs = Number(process.env.REDIS_OUTAGE_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.REDIS_OUTAGE_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const requestedLocalMode = String(process.env.REDIS_OUTAGE_SMOKE_LOCAL_MODE || 'dev')
  .trim()
  .toLowerCase();
const localMode = ['node', 'preview'].includes(requestedLocalMode) ? requestedLocalMode : 'dev';
const testWebhookUrl = 'https://mbl-test-webhook.invalid/webhook';
const testWebhookProxyRequire = '--require=./scripts/test-webhook-fetch-proxy.cjs';
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

function fetchWithTimeout(url, init = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

async function startMockWebhookServer() {
  const attempts = [];

  const server = createServer(async (req, res) => {
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

    attempts.push({
      payload,
      rawBody,
      receivedAt: new Date().toISOString(),
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
    throw new Error('Mock webhook server failed to start.');
  }

  return {
    server,
    attempts,
    webhookUrl: testWebhookUrl,
    localWebhookUrl: `http://${host}:${address.port}/webhook`,
    async stop() {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function startAstroServer(webhookUrl, localWebhookUrl) {
  const npmArgs =
    localMode === 'node'
      ? ['start']
      : [
          'run',
          localMode,
          '--',
          '--host',
          host,
          '--port',
          String(port),
          ...(localMode === 'dev' ? ['--ignore-lock'] : []),
        ];
  const child = spawn(npmCommand, npmArgs, {
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      ...(localMode === 'dev' ? { ASTRO_DEV_BACKGROUND: '0' } : {}),
      HOST: host,
      PORT: String(port),
      CONTACT_WEBHOOK_URL: webhookUrl,
      CONTACT_WEBHOOK_SECRET: 'redis-outage-local-mock-secret',
      MBL_TEST_WEBHOOK_HTTPS_URL: webhookUrl,
      MBL_TEST_WEBHOOK_HTTP_TARGET: localWebhookUrl,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, testWebhookProxyRequire].filter(Boolean).join(' '),
      CONTACT_WORKER_TOKEN: `redis-outage-worker-${Date.now().toString(36)}`,
      CONTACT_WORKER_URL: '',
      CONTACT_SMARTCAPTCHA_REQUIRED: 'false',
      REDIS_URL: process.env.REDIS_OUTAGE_URL || 'redis://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });

  child.stdout?.on('data', (chunk) => addServerLogs('stdout', chunk));
  child.stderr?.on('data', (chunk) => addServerLogs('stderr', chunk));

  return child;
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
      throw new Error(`Local server exited before readiness (code ${server.exitCode}).\n${tailServerLogs()}`);
    }

    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/health`, { method: 'GET' });
      if ([200, 503].includes(response.status)) {
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

function ensureProductionBuild() {
  const artifactExists = localMode === 'node' ? fs.existsSync('.output/server/entry.mjs') : fs.existsSync('dist');
  if (['node', 'preview'].includes(localMode) && !artifactExists) {
    throw new Error('Production artifact is missing. Run `npm run build` before Redis outage fail-closed check.');
  }
}

async function postLead() {
  const response = await fetchWithTimeout(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `ci-redis-outage-${Date.now()}`,
    },
    body: JSON.stringify({
      name: 'Redis Outage CI',
      phone: '+7 (912) 345-67-89',
      message: 'Redis outage fallback smoke test',
      consent: true,
      attribution: { utm_source: 'ci', utm_medium: 'redis-outage' },
      formContext: { formId: 'ci-redis-outage-form', pageType: 'contacts', placement: 'ci' },
    }),
  });

  const rawBody = await response.text();
  let body = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = null;
  }

  return {
    status: response.status,
    body,
    rawBody,
  };
}

async function main() {
  ensureProductionBuild();

  const mockWebhook = await startMockWebhookServer();
  const astroServer = startAstroServer(mockWebhook.webhookUrl, mockWebhook.localWebhookUrl);

  try {
    await waitForHealth(astroServer);

    const health = await fetchWithTimeout(`${baseUrl}/api/health`, { method: 'GET' });
    assert(health.status === 503, `GET /api/health must return 503 during Redis outage, got ${health.status}`);

    const contact = await postLead();
    assert(
      contact.status === 503,
      `POST /api/leads must return 503 during Redis outage fail-closed, got ${contact.status}`
    );
    assert(
      contact.body?.success === false,
      'Contact API must return { success: false } during Redis outage fail-closed'
    );
    assert(
      contact.body?.code === 'LEAD_STORE_UNAVAILABLE',
      `Expected LEAD_STORE_UNAVAILABLE during Redis outage fail-closed, got ${contact.body?.code}`
    );

    await delay(300);

    assert(
      mockWebhook.attempts.length === 0,
      `Expected 0 webhook attempts during fail-closed outage, got ${mockWebhook.attempts.length}`
    );

    console.log(
      `Redis outage fail-closed check passed: mode=${localMode}, status=${contact.status}, code=${contact.body?.code}, webhookAttempts=${mockWebhook.attempts.length}`
    );
  } finally {
    await stopAstroServer(astroServer);
    await mockWebhook.stop();
  }
}

main().catch((error) => {
  console.error('Redis outage fallback check failed.');
  console.error(error);
  if (serverLogs.length > 0) {
    console.error('Recent local server logs:');
    console.error(tailServerLogs());
  }
  process.exit(1);
});
