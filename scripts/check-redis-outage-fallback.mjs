import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const host = process.env.REDIS_OUTAGE_SMOKE_HOST || '127.0.0.1';
const port = Number(process.env.REDIS_OUTAGE_SMOKE_PORT || 4324);
const baseUrl = `http://${host}:${port}`;
const serverStartTimeoutMs = Number(process.env.REDIS_OUTAGE_SMOKE_TIMEOUT_MS || 90000);
const transitionTimeoutMs = Number(process.env.REDIS_OUTAGE_TRANSITION_TIMEOUT_MS || 15000);
const requestTimeoutMs = Number(process.env.REDIS_OUTAGE_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 250;
const requestedLocalMode = String(process.env.REDIS_OUTAGE_SMOKE_LOCAL_MODE || 'dev')
  .trim()
  .toLowerCase();
const localMode = requestedLocalMode === 'node' ? 'node' : 'dev';
const testWebhookUrl = 'https://mbl-test-webhook.invalid/webhook';
const testWebhookProxyRequire = '--require=./scripts/test-webhook-fetch-proxy.cjs';
const redisImage = 'redis:7.4.7-alpine3.21';
const redisContainerName = `mbl-r181-redis-${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const astroCliPath = join(projectRoot, 'node_modules', 'astro', 'bin', 'astro.mjs');
const startNodePath = join(projectRoot, 'scripts', 'start-node.mjs');
const astroDevMetadataPath = join(projectRoot, '.astro', 'dev.json');
const childExitTimeoutMs = 10000;
const portReleaseTimeoutMs = 5000;
const serverLogs = [];

function addServerLogs(source, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) serverLogs.push(`[${source}] ${line}`);
  if (serverLogs.length > 200) serverLogs.splice(0, serverLogs.length - 200);
}

function tailServerLogs() {
  return serverLogs.slice(-40).join('\n') || '(no server logs)';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runDocker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw new Error(`Unable to run docker ${args[0] || ''}`, { cause: result.error });
  if (result.status !== 0 && !allowFailure) {
    const diagnostic = String(result.stderr || result.stdout || '').trim();
    throw new Error(`docker ${args[0] || ''} failed with status ${String(result.status)}: ${diagnostic}`);
  }
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
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
      if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') return resolve(false);
      reject(error);
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

async function assertSmokeEnvironment() {
  if (localMode === 'dev') {
    const existingAstro = await findExistingProjectAstro();
    if (existingAstro) {
      throw new Error(
        `BLOCKED_BY_ENV: Astro for this project is already running at ${existingAstro.url} ` +
          `(pid ${existingAstro.pid}). Stop it from its owning terminal and rerun the smoke.`
      );
    }
  }
  if (!(await canBindPort())) throw new Error(`BLOCKED_BY_ENV: test server port ${host}:${port} is already in use.`);
}

function fetchWithTimeout(url, init = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

async function readJsonResponse(url) {
  const response = await fetchWithTimeout(url, { method: 'GET' });
  const rawBody = await response.text();
  let body = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new Error(`Expected JSON from ${url}, got HTTP ${response.status}`);
  }
  return { status: response.status, body };
}

async function startMockWebhookServer() {
  const attempts = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.statusCode = 404;
      res.end('not_found');
      return;
    }
    for await (const chunk of req) {
      // Consume but never log the synthetic request body.
      void chunk;
    }
    attempts.push({ receivedAt: new Date().toISOString() });
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
  if (!address || typeof address !== 'object') throw new Error('Mock webhook server failed to start.');

  return {
    attempts,
    webhookUrl: testWebhookUrl,
    localWebhookUrl: `http://${host}:${address.port}/webhook`,
    async stop() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function startDisposableRedis() {
  runDocker([
    'run',
    '-d',
    '--rm',
    '--name',
    redisContainerName,
    '-p',
    '127.0.0.1::6379',
    redisImage,
    'redis-server',
    '--save',
    '',
    '--appendonly',
    'no',
  ]);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const ping = runDocker(['exec', redisContainerName, 'redis-cli', '--raw', 'PING'], { allowFailure: true });
    if (ping.ok && ping.stdout === 'PONG') {
      const portResult = runDocker(['port', redisContainerName, '6379/tcp']);
      const match = portResult.stdout.match(/:(\d+)$/m);
      if (!match) throw new Error(`Unable to resolve disposable Redis port: ${portResult.stdout}`);
      return { port: Number(match[1]) };
    }
    await delay(200);
  }
  throw new Error('Disposable Redis did not become ready within 15000ms.');
}

function dockerRedisCommand(...args) {
  return runDocker(['exec', redisContainerName, 'redis-cli', '--raw', ...args]);
}

function startApplicationServer(webhookUrl, localWebhookUrl, redisPort) {
  const args = localMode === 'node' ? [startNodePath] : [astroCliPath, 'dev', '--host', host, '--port', String(port)];
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      ...(localMode === 'dev' ? { ASTRO_DEV_BACKGROUND: '0' } : {}),
      HOST: host,
      PORT: String(port),
      CONTACT_WEBHOOK_URL: webhookUrl,
      CONTACT_WEBHOOK_SECRET: 'redis-outage-local-mock-secret',
      CONTACT_ALERT_WEBHOOK_URL: '',
      CONTACT_ALERT_WEBHOOK_URL_SECONDARY: '',
      CONTACT_ALERT_WEBHOOK_TOKEN: '',
      MBL_TEST_WEBHOOK_HTTPS_URL: webhookUrl,
      MBL_TEST_WEBHOOK_HTTP_TARGET: localWebhookUrl,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, testWebhookProxyRequire].filter(Boolean).join(' '),
      CONTACT_WORKER_TOKEN: `redis-outage-worker-${Date.now().toString(36)}`,
      CONTACT_WORKER_URL: '',
      CONTACT_SMARTCAPTCHA_REQUIRED: 'false',
      CONTACT_REDIS_TIMEOUT_MS: '1200',
      REDIS_READINESS_SUCCESS_CACHE_MS: '1000',
      REDIS_READINESS_FAILURE_CACHE_MS: '500',
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: false,
    windowsHide: true,
  });

  const runtime = { child, exitRecord: null, spawnError: null };
  child.stdout?.on('data', (chunk) => addServerLogs('stdout', chunk));
  child.stderr?.on('data', (chunk) => addServerLogs('stderr', chunk));
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

async function waitForApplicationExit(runtime, timeoutMs = childExitTimeoutMs) {
  if (runtime.exitRecord) return runtime.exitRecord;
  if (runtime.spawnError && !runtime.child.pid) {
    throw new Error(`Application server failed to spawn: ${runtime.spawnError.message}`, { cause: runtime.spawnError });
  }
  const timeoutMarker = Symbol('child-exit-timeout');
  const result = await Promise.race([runtime.exitPromise, delay(timeoutMs, timeoutMarker)]);
  if (result === timeoutMarker) {
    throw new Error(`Application child pid ${String(runtime.child.pid || 'unknown')} did not confirm exit.`);
  }
  return result;
}

async function waitForPortRelease() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < portReleaseTimeoutMs) {
    if (await canBindPort()) return;
    await delay(100);
  }
  throw new Error(`Test server port ${host}:${port} was not released within ${portReleaseTimeoutMs}ms.`);
}

async function stopApplicationServer(runtime) {
  if (!runtime) return null;
  if (!runtime.exitRecord) {
    if (runtime.spawnError && !runtime.child.pid) {
      throw new Error(`Application server failed to spawn: ${runtime.spawnError.message}`, {
        cause: runtime.spawnError,
      });
    }
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(runtime.child.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      const killerExit = await once(killer, 'exit');
      if (killerExit[0] !== 0 && !runtime.exitRecord) {
        throw new Error(`taskkill failed with status ${String(killerExit[0])}.`);
      }
    } else {
      try {
        process.kill(-runtime.child.pid, 'SIGTERM');
      } catch (error) {
        if (!runtime.exitRecord) throw new Error('Unable to stop application process group.', { cause: error });
      }
    }
  }
  const exitRecord = await waitForApplicationExit(runtime);
  await waitForPortRelease();
  return exitRecord;
}

async function stopDisposableRedis() {
  const exact = `^/${redisContainerName}$`;
  const existing = runDocker(['ps', '-a', '--filter', `name=${exact}`, '--format', '{{.Names}}']);
  if (!existing.stdout) return;
  runDocker(['rm', '-f', redisContainerName]);
  const remaining = runDocker(['ps', '-a', '--filter', `name=${exact}`, '--format', '{{.Names}}']);
  if (remaining.stdout) throw new Error(`Disposable Redis cleanup was not confirmed: ${remaining.stdout}`);
}

function ensureProductionBuild() {
  if (localMode === 'node' && !fs.existsSync(join(projectRoot, '.output', 'server', 'entry.mjs'))) {
    throw new Error('Production artifact is missing. Run `npm run build` before node-mode Redis outage check.');
  }
}

async function waitForServer(runtime) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < serverStartTimeoutMs) {
    if (runtime.spawnError) {
      throw new Error(`Application server failed to start: ${runtime.spawnError.message}.\n${tailServerLogs()}`, {
        cause: runtime.spawnError,
      });
    }
    if (runtime.exitRecord) throw new Error(`Application server exited before readiness.\n${tailServerLogs()}`);
    try {
      const live = await readJsonResponse(`${baseUrl}/health/live`);
      if (live.status === 200 && live.body?.status === 'live') return Date.now() - startedAt;
    } catch {
      // The owned server has not reached readiness yet.
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for /health/live.\n${tailServerLogs()}`);
}

async function waitForReadyStatus(runtime, expectedStatus) {
  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt < transitionTimeoutMs) {
    if (runtime.spawnError || runtime.exitRecord) {
      throw new Error(`Application server exited during Redis transition.\n${tailServerLogs()}`);
    }
    try {
      const readiness = await readJsonResponse(`${baseUrl}/health/ready`);
      lastStatus = readiness.status;
      if (readiness.status === expectedStatus) return Date.now() - startedAt;
    } catch {
      lastStatus = 'request_failed';
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for /health/ready=${expectedStatus}; last=${String(lastStatus)}.`);
}

async function readHealthPhase(label) {
  const [live, ready, api] = await Promise.all([
    readJsonResponse(`${baseUrl}/health/live`),
    readJsonResponse(`${baseUrl}/health/ready`),
    readJsonResponse(`${baseUrl}/api/health`),
  ]);
  return {
    label,
    live: { status: live.status, state: live.body?.status },
    ready: { status: ready.status, state: ready.body?.status },
    api: {
      status: api.status,
      ok: api.body?.ok,
      redisOk: api.body?.redis?.ok,
      redisCode: api.body?.redis?.code,
      degraded: api.body?.redis?.degraded,
    },
  };
}

function assertHealthyPhase(phase) {
  assert(phase.live.status === 200 && phase.live.state === 'live', `${phase.label}: liveness must be 200/live.`);
  assert(phase.ready.status === 200 && phase.ready.state === 'ready', `${phase.label}: readiness must be 200/ready.`);
  assert(phase.api.status === 200, `${phase.label}: /api/health must be 200 when Redis is writable.`);
  assert(phase.api.redisOk === true && phase.api.degraded === false, `${phase.label}: Redis must be healthy.`);
  assert(phase.api.redisCode === 'REDIS_WRITE_READ_OK', `${phase.label}: write/read probe must be successful.`);
}

function assertOutagePhase(phase) {
  const expectedApiStatus = localMode === 'dev' ? 200 : 503;
  assert(phase.live.status === 200 && phase.live.state === 'live', 'outage: liveness must remain 200/live.');
  assert(phase.ready.status === 503 && phase.ready.state === 'not_ready', 'outage: readiness must be 503.');
  assert(
    phase.api.status === expectedApiStatus,
    `outage: /api/health must be ${expectedApiStatus} in ${localMode} mode, got ${phase.api.status}.`
  );
  assert(phase.api.redisOk === false && phase.api.degraded === true, 'outage: Redis must be degraded.');
  assert(phase.api.redisCode === 'REDIS_WRITE_READ_FAILED', 'outage: write/read probe failure must be reported.');
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
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function executeSmoke() {
  ensureProductionBuild();
  await assertSmokeEnvironment();

  let application = null;
  let mockWebhook = null;
  let redisStarted = false;
  let primaryError = null;
  const cleanupErrors = [];
  let summary = null;

  try {
    redisStarted = true;
    const redis = await startDisposableRedis();
    mockWebhook = await startMockWebhookServer();
    application = startApplicationServer(mockWebhook.webhookUrl, mockWebhook.localWebhookUrl, redis.port);
    const startupMs = await waitForServer(application);
    const applicationPid = application.child.pid;

    await waitForReadyStatus(application, 200);
    const before = await readHealthPhase('before');
    assertHealthyPhase(before);

    const replicaResponse = dockerRedisCommand('REPLICAOF', '127.0.0.1', '1');
    assert(replicaResponse.stdout === 'OK', `Unable to make disposable Redis read-only: ${replicaResponse.stdout}`);
    const pingDuringOutage = dockerRedisCommand('PING').stdout;
    assert(
      pingDuringOutage === 'PONG',
      `Redis PING must remain successful during write outage, got ${pingDuringOutage}.`
    );

    const outageDetectedMs = await waitForReadyStatus(application, 503);
    const outage = await readHealthPhase('outage');
    assertOutagePhase(outage);

    let contact = null;
    if (localMode === 'dev') {
      contact = await postLead();
      assert(
        contact.status === 503,
        `POST /api/leads must return 503 during Redis outage, got ${contact.status} (${String(contact.body?.code)}).`
      );
      assert(contact.body?.success === false, 'POST /api/leads must report success=false during Redis outage.');
      assert(
        contact.body?.code === 'LEAD_STORE_UNAVAILABLE',
        `Expected LEAD_STORE_UNAVAILABLE, got ${String(contact.body?.code)}.`
      );
      await delay(300);
      assert(mockWebhook.attempts.length === 0, 'Redis outage must not trigger direct webhook delivery.');
    }

    const recoveryResponse = dockerRedisCommand('REPLICAOF', 'NO', 'ONE');
    assert(recoveryResponse.stdout === 'OK', `Unable to restore writable Redis: ${recoveryResponse.stdout}`);
    const recoveryProbeKey = `mbl:r181:recovery:${process.pid}`;
    assert(
      dockerRedisCommand('SET', recoveryProbeKey, 'ok', 'EX', '5').stdout === 'OK',
      'Redis did not accept writes.'
    );
    dockerRedisCommand('DEL', recoveryProbeKey);

    const recoveryDetectedMs = await waitForReadyStatus(application, 200);
    const recovered = await readHealthPhase('recovered');
    assertHealthyPhase(recovered);
    assert(
      application.child.pid === applicationPid && !application.exitRecord,
      'Web process restarted during recovery.'
    );

    summary = {
      mode: localMode,
      startupMs,
      outageDetectedMs,
      recoveryDetectedMs,
      pingDuringOutage,
      contactStatus: contact?.status || 'not_run_production_captcha_required',
      contactCode: contact?.body?.code || 'not_run_production_captcha_required',
      webhookAttempts: mockWebhook.attempts.length,
      phases: [before, outage, recovered],
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (application) {
      try {
        const exit = await stopApplicationServer(application);
        if (summary) summary.applicationExit = exit;
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
    if (redisStarted) {
      try {
        await stopDisposableRedis();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], 'Redis outage check and cleanup failed.');
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Redis outage cleanup failed.');

  console.log('Redis outage and recovery check passed.');
  console.log(JSON.stringify(summary, null, 2));
}

executeSmoke().catch((error) => {
  console.error('Redis outage fallback check failed.');
  console.error(error);
  if (serverLogs.length > 0) {
    console.error('Recent local server logs:');
    console.error(tailServerLogs());
  }
  process.exit(1);
});
