import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const host = process.env.METRICS_HEALTH_STATE_SMOKE_HOST || '127.0.0.1';
const port = Number(process.env.METRICS_HEALTH_STATE_SMOKE_PORT || 4328);
const baseUrl = `http://${host}:${port}`;
const npmCommand = 'npm';
const serverStartTimeoutMs = Number(process.env.METRICS_HEALTH_STATE_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.METRICS_HEALTH_STATE_SMOKE_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const smokePageSlug = '/kuhni';
const openedEventsToSend = Number(process.env.METRICS_HEALTH_STATE_SMOKE_OPENED_EVENTS || 16);
const workerToken = String(
  process.env.METRICS_HEALTH_STATE_SMOKE_WORKER_TOKEN || 'metrics_health_state_worker_smoke_token'
).trim();
const adminToken = String(
  process.env.METRICS_HEALTH_STATE_SMOKE_ADMIN_TOKEN || 'metrics_health_state_admin_smoke_token'
).trim();

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

function startServer() {
  const child = spawn(npmCommand, ['run', 'dev', '--', '--host', host, '--port', String(port)], {
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      METRICS_HEALTH_WORKER_TOKEN: workerToken,
      METRICS_ADMIN_TOKEN: adminToken,
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
      sendAlert: false,
    }),
  });

  const payload = await response.json().catch(() => null);
  assert(response.ok, `POST /api/workers/metrics-health-eval failed with status ${response.status}`);
  assert(payload?.success === true, 'metrics-health-eval worker returned success=false');
  return payload;
}

async function assertAdminUnauthorized() {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/metrics-health?view=summary`, {
    method: 'GET',
  });
  const payload = await response.json().catch(() => null);

  assert(response.status === 401, `Expected 401 for unauthorized admin metrics-health call, got ${response.status}`);
  assert(payload?.ok === false, 'Unauthorized admin metrics-health payload must return ok=false');
}

async function getAdminStates() {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/metrics-health?view=states&limit=500`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });
  const payload = await response.json().catch(() => null);

  assert(response.ok, `GET /api/admin/metrics-health?view=states failed with status ${response.status}`);
  assert(payload?.ok === true, 'Admin states payload must return ok=true');
  assert(Array.isArray(payload?.states), 'Admin states payload must contain states[]');
  assert(payload.states.length > 0, 'Admin states payload returned empty states[]');

  const globalState = payload.states.find((item) => item?.scope === 'global' && item?.key === 'global');
  assert(Boolean(globalState), 'Admin states payload must contain global scope record');
  assert(
    ['CRITICAL', 'DEGRADED', 'RECOVERING'].includes(String(globalState?.state || '')),
    `Expected global state to be non-healthy after seeded events, got "${String(globalState?.state || '')}"`
  );

  return payload;
}

async function getAdminTransitions() {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/metrics-health?view=transitions&limit=500`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });
  const payload = await response.json().catch(() => null);

  assert(response.ok, `GET /api/admin/metrics-health?view=transitions failed with status ${response.status}`);
  assert(payload?.ok === true, 'Admin transitions payload must return ok=true');
  assert(Array.isArray(payload?.transitions), 'Admin transitions payload must contain transitions[]');
  assert(payload.transitions.length > 0, 'Admin transitions payload returned empty transitions[]');
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
  const server = startServer();
  const day = new Date().toISOString().slice(0, 10);

  try {
    await waitForHealth(server);
    await seedOpenedEvents();
    await assertAdminUnauthorized();

    const firstRun = await runHealthEvalWorker(day);
    assert(
      Number(firstRun?.evaluation?.summary?.transitions || 0) > 0,
      `First health eval expected transitions > 0, got ${JSON.stringify(firstRun?.evaluation?.summary || {})}`
    );

    const secondRun = await runHealthEvalWorker(day);
    assert(
      Number(secondRun?.evaluation?.summary?.transitions || 0) === 0,
      `Second health eval expected transitions = 0, got ${JSON.stringify(secondRun?.evaluation?.summary || {})}`
    );

    const statesPayload = await getAdminStates();
    const transitionsPayload = await getAdminTransitions();

    assert(
      Number(statesPayload?.summary?.statesTracked || 0) > 0,
      'Admin states summary must report statesTracked > 0'
    );
    assert(
      Number(transitionsPayload?.summary?.transitionsSampled || 0) > 0,
      'Admin transitions summary must report transitionsSampled > 0'
    );

    console.log(
      `Metrics health state-store smoke passed: states=${statesPayload.summary.statesTracked}, transitionsSampled=${transitionsPayload.summary.transitionsSampled}, firstTransitions=${firstRun.evaluation.summary.transitions}, secondTransitions=${secondRun.evaluation.summary.transitions}`
    );
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error('Metrics health state-store smoke check failed.');
  console.error(error);
  if (serverLogs.length > 0) {
    console.error('Recent dev server logs:');
    console.error(tailServerLogs());
  }
  process.exit(1);
});
