import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const host = process.env.METRICS_SMOKE_HOST || '127.0.0.1';
const port = Number(process.env.METRICS_SMOKE_PORT || 4322);
const baseUrl = `http://${host}:${port}`;
const npmCommand = 'npm';
const serverStartTimeoutMs = Number(process.env.METRICS_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.METRICS_SMOKE_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const smokePageSlug = '/kuhni';
const adminToken = String(process.env.METRICS_SMOKE_ADMIN_TOKEN || process.env.METRICS_ADMIN_TOKEN || '').trim();
const isCi =
  String(process.env.CI || '')
    .trim()
    .toLowerCase() === 'true';

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

function startServer() {
  const child = spawn(npmCommand, ['run', 'dev', '--', '--host', host, '--port', String(port)], {
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
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

async function getFunnelCounters() {
  const headers = adminToken
    ? {
        Authorization: `Bearer ${adminToken}`,
      }
    : {};

  const response = await fetchWithTimeout(
    `${baseUrl}/api/admin/metrics?span=day&pageSlug=${encodeURIComponent(smokePageSlug)}&city=irkutsk&service=kuhni-na-zakaz&limit=5`,
    {
      method: 'GET',
      headers,
    }
  );
  const payload = await response.json();

  assert(response.ok, `Metrics rollup endpoint failed with status ${response.status}`);
  assert(payload?.ok === true, 'Metrics rollup endpoint returned { ok: false }');

  const entry =
    Array.isArray(payload.entries) && payload.entries.find((item) => String(item?.pageSlug || '') === smokePageSlug);

  return {
    opened: Number(entry?.formOpened || 0),
    submitted: Number(entry?.formSubmitted || 0),
    phoneValid: Number(payload?.totalOps?.formPhoneValid || 0),
    submitAttempt: Number(payload?.totalOps?.formSubmitAttempt || 0),
  };
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

  const payload = await response.json();
  assert(response.ok, `POST /api/track failed with status ${response.status}`);
  assert(payload?.success === true, 'POST /api/track returned non-success payload');
}

async function postOpsEvent(event, reason = '') {
  const response = await fetchWithTimeout(`${baseUrl}/api/track`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event,
      page: smokePageSlug,
      sentAt: new Date().toISOString(),
      payload: {
        city: 'irkutsk',
        district: 'oktyabrskiy',
        service: 'kuhni-na-zakaz',
        page_slug: smokePageSlug,
        lead_page_type: 'money',
        reason,
      },
    }),
  });

  const payload = await response.json();
  assert(response.ok, `POST /api/track (${event}) failed with status ${response.status}`);
  assert(payload?.success === true, `POST /api/track (${event}) returned non-success payload`);
  assert(payload?.funnelMetricRecorded === true, `POST /api/track (${event}) did not record funnel metric`);
}

async function postContactLead(idempotencyKey) {
  const response = await fetchWithTimeout(`${baseUrl}/api/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      name: 'Metrics Smoke',
      phone: '+7 (912) 345-67-89',
      message: 'Metrics smoke check',
      consent: true,
      city: 'irkutsk',
      district: 'oktyabrskiy',
      service: 'kuhni-na-zakaz',
      pageType: 'money',
      pageSlug: smokePageSlug,
      formContext: {
        formId: 'metrics-smoke',
        placement: 'ci',
        city: 'irkutsk',
        district: 'oktyabrskiy',
        service: 'kuhni-na-zakaz',
        pageType: 'money',
        pageSlug: smokePageSlug,
      },
      attribution: {
        currentPath: smokePageSlug,
        utm_source: 'ci',
      },
    }),
  });

  const payload = await response.json();
  assert(response.ok, `POST /api/contact failed with status ${response.status}`);
  assert(payload?.success === true, 'POST /api/contact returned non-success payload');
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
  if (isCi && !adminToken) {
    throw new Error('METRICS_ADMIN_TOKEN is required when CI=true for the metrics smoke check.');
  }

  const server = startServer();
  try {
    await waitForHealth(server);

    const before = await getFunnelCounters();
    await postFormOpenedEvent();
    await postOpsEvent('form_phone_valid');
    await postOpsEvent('form_submit_attempt');
    await postContactLead(`metrics-smoke-${Date.now()}`);
    await delay(400);
    const after = await getFunnelCounters();

    assert(
      after.opened >= before.opened + 1,
      `form_opened counter did not increase (${before.opened} -> ${after.opened})`
    );
    assert(
      after.submitted >= before.submitted + 1,
      `form_submitted counter did not increase (${before.submitted} -> ${after.submitted})`
    );
    assert(
      after.phoneValid >= before.phoneValid + 1,
      `form_phone_valid counter did not increase (${before.phoneValid} -> ${after.phoneValid})`
    );
    assert(
      after.submitAttempt >= before.submitAttempt + 1,
      `form_submit_attempt counter did not increase (${before.submitAttempt} -> ${after.submitAttempt})`
    );

    console.log(
      `Metrics smoke check passed: opened ${before.opened} -> ${after.opened}, phoneValid ${before.phoneValid} -> ${after.phoneValid}, submitAttempt ${before.submitAttempt} -> ${after.submitAttempt}, submitted ${before.submitted} -> ${after.submitted}`
    );
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error('Metrics smoke check failed.');
  console.error(error);
  if (serverLogs.length > 0) {
    console.error('Recent dev server logs:');
    console.error(tailServerLogs());
  }
  process.exit(1);
});
