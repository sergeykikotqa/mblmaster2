import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const host = process.env.CONTACT_API_SMOKE_HOST || '127.0.0.1';
const port = Number(process.env.CONTACT_API_SMOKE_PORT || 4351);
const serverStartTimeoutMs = Number(process.env.CONTACT_API_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.CONTACT_API_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const serverLogs = [];

function createBaseUrl(targetPort) {
  return `http://${host}:${targetPort}`;
}

function createSmokeRedisPrefix(scope) {
  return `lead-smoke-${scope}-${Date.now().toString(36)}`;
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

function fetchWithTimeout(url, init = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startServer({ targetPort, redisPrefix, extraEnv = {} }) {
  const child = spawn(npmCommand, ['run', 'dev', '--', '--host', host, '--port', String(targetPort)], {
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      CONTACT_RATE_LIMIT_MAX: '100',
      CONTACT_RATE_LIMIT_WINDOW_SEC: '60',
      CONTACT_REDIS_PREFIX: redisPrefix,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });

  child.stdout?.on('data', (chunk) => addServerLogs('stdout', chunk));
  child.stderr?.on('data', (chunk) => addServerLogs('stderr', chunk));

  return child;
}

async function waitForHealth(server, targetBaseUrl) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < serverStartTimeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(`Dev server exited before readiness (code ${server.exitCode}).\n${tailServerLogs()}`);
    }

    try {
      const response = await fetchWithTimeout(`${targetBaseUrl}/api/health`, { method: 'GET' });
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

async function postLead(targetBaseUrl, idempotencyKey) {
  const payload = {
    name: 'CI Smoke',
    phone: '+7 (912) 345-67-89',
    message: 'CI smoke check',
    consent: true,
    attribution: {
      utm_source: 'ci',
      utm_medium: 'smoke',
    },
    formContext: {
      formId: 'ci-smoke-form',
      pageType: 'ci',
      placement: 'ci',
    },
  };

  const response = await fetchWithTimeout(`${targetBaseUrl}/api/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text();
  let json;
  try {
    json = JSON.parse(rawBody);
  } catch (error) {
    throw new Error(
      `Contact API returned invalid JSON (status ${response.status}): ${rawBody.slice(0, 300)}\n${String(error)}`
    );
  }

  return {
    status: response.status,
    body: json,
    retryAfter: response.headers.get('retry-after') || '',
  };
}

async function postLeadAsForm(targetBaseUrl) {
  const form = new URLSearchParams({
    name: 'NoJS Smoke',
    phone: '+7 (912) 345-67-89',
    message: 'No JS form submit',
    consent: 'on',
    redirectTo: '/thanks',
  });

  const response = await fetchWithTimeout(`${targetBaseUrl}/api/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
    },
    body: form.toString(),
    redirect: 'manual',
  });

  return {
    status: response.status,
    location: response.headers.get('location') || '',
  };
}

async function checkLegacyContactAlias(targetBaseUrl) {
  const response = await fetchWithTimeout(`${targetBaseUrl}/api/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
    redirect: 'manual',
  });

  return {
    status: response.status,
    location: response.headers.get('location') || '',
  };
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
    // Process already exited
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

async function main() {
  const defaultBaseUrl = createBaseUrl(port);
  const server = startServer({
    targetPort: port,
    redisPrefix: createSmokeRedisPrefix('main'),
  });
  try {
    await waitForHealth(server, defaultBaseUrl);

    const idempotencyKey = `ci-smoke-${Date.now()}`;
    const first = await postLead(defaultBaseUrl, idempotencyKey);
    const second = await postLead(defaultBaseUrl, idempotencyKey);

    assert(first.status === 200, `First POST /api/leads must return 200, got ${first.status}`);
    assert(first.body?.success === true, 'First POST /api/leads must return { success: true }');
    assert(
      typeof first.body?.leadId === 'string' && first.body.leadId.length > 0,
      'First response must include leadId'
    );

    assert(second.status === 200, `Second POST /api/leads must return 200, got ${second.status}`);
    assert(second.body?.success === true, 'Second POST /api/leads must return { success: true }');
    assert(second.body?.duplicate === true, 'Second POST /api/leads must return { duplicate: true }');
    assert(second.body?.leadId === first.body?.leadId, 'Second POST must return same leadId for idempotency key');

    const concurrentKey = `ci-race-${Date.now()}`;
    const [raceA, raceB] = await Promise.all([
      postLead(defaultBaseUrl, concurrentKey),
      postLead(defaultBaseUrl, concurrentKey),
    ]);

    assert(raceA.status === 200, `Concurrent request A must return 200, got ${raceA.status}`);
    assert(raceB.status === 200, `Concurrent request B must return 200, got ${raceB.status}`);
    assert(
      raceA.body?.success === true && raceB.body?.success === true,
      'Concurrent requests must return { success: true }'
    );
    assert(
      typeof raceA.body?.leadId === 'string' && typeof raceB.body?.leadId === 'string',
      'Concurrent requests must include leadId'
    );
    assert(
      raceA.body?.leadId === raceB.body?.leadId,
      'Concurrent requests with same idempotency key must resolve to the same leadId'
    );
    assert(
      raceA.body?.duplicate === true || raceB.body?.duplicate === true,
      'At least one concurrent request must be marked as duplicate'
    );

    const formPost = await postLeadAsForm(defaultBaseUrl);
    assert(formPost.status === 303, `Form POST /api/leads must return 303, got ${formPost.status}`);
    assert(
      formPost.location === '/thanks' || formPost.location.endsWith('/thanks'),
      `Form POST must redirect to /thanks, got ${formPost.location}`
    );

    const legacyAlias = await checkLegacyContactAlias(defaultBaseUrl);
    assert(legacyAlias.status === 307, `Legacy POST /api/contact must return 307, got ${legacyAlias.status}`);
    assert(
      legacyAlias.location.includes('/api/leads'),
      `Legacy alias location must point to /api/leads, got ${legacyAlias.location}`
    );

    console.log(
      `Lead API smoke check passed: leadId=${first.body.leadId}, duplicate=${String(second.body.duplicate)}, raceLeadId=${raceA.body.leadId}, raceDuplicateA=${String(raceA.body.duplicate)}, raceDuplicateB=${String(raceB.body.duplicate)}, formRedirect=${formPost.location}, legacyAlias=${legacyAlias.status}`
    );
  } finally {
    await stopServer(server);
  }

  const backpressurePort = port + 1;
  const backpressureBaseUrl = createBaseUrl(backpressurePort);
  const backpressureServer = startServer({
    targetPort: backpressurePort,
    redisPrefix: createSmokeRedisPrefix('backpressure'),
    extraEnv: {
      CONTACT_QUEUE_MAX_DEPTH: '1',
    },
  });

  try {
    await waitForHealth(backpressureServer, backpressureBaseUrl);

    const firstBackpressure = await postLead(backpressureBaseUrl, `ci-backpressure-first-${Date.now()}`);
    const secondBackpressure = await postLead(backpressureBaseUrl, `ci-backpressure-second-${Date.now()}`);

    assert(
      firstBackpressure.status === 200,
      `Backpressure first POST must return 200, got ${firstBackpressure.status}`
    );
    assert(
      secondBackpressure.status === 503,
      `Backpressure second POST must return 503, got ${secondBackpressure.status}`
    );
    assert(
      secondBackpressure.body?.code === 'QUEUE_BACKPRESSURE',
      `Backpressure second POST must return code=QUEUE_BACKPRESSURE, got ${secondBackpressure.body?.code}`
    );
    assert(
      secondBackpressure.retryAfter === '60',
      `Backpressure second POST must include Retry-After=60, got ${secondBackpressure.retryAfter}`
    );
  } finally {
    await stopServer(backpressureServer);
  }

  const pausedPort = port + 2;
  const pausedBaseUrl = createBaseUrl(pausedPort);
  const pausedServer = startServer({
    targetPort: pausedPort,
    redisPrefix: createSmokeRedisPrefix('paused'),
    extraEnv: {
      CONTACT_WORKER_PAUSED: 'true',
    },
  });

  try {
    await waitForHealth(pausedServer, pausedBaseUrl);

    const pausedResponse = await postLead(pausedBaseUrl, `ci-paused-${Date.now()}`);

    assert(pausedResponse.status === 503, `Paused worker POST must return 503, got ${pausedResponse.status}`);
    assert(
      pausedResponse.body?.code === 'WORKER_PAUSED',
      `Paused worker POST must return code=WORKER_PAUSED, got ${pausedResponse.body?.code}`
    );
    assert(
      pausedResponse.retryAfter === '60',
      `Paused worker POST must include Retry-After=60, got ${pausedResponse.retryAfter}`
    );
  } finally {
    await stopServer(pausedServer);
  }
}

main().catch((error) => {
  console.error('Contact API smoke check failed.');
  console.error(error);
  if (serverLogs.length > 0) {
    console.error('Recent dev server logs:');
    console.error(tailServerLogs());
  }
  process.exit(1);
});
