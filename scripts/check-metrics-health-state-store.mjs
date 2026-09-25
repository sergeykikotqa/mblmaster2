import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from 'redis';

const host = String(process.env.METRICS_HEALTH_STATE_SMOKE_HOST || '127.0.0.1').trim();
const port = Number(process.env.METRICS_HEALTH_STATE_SMOKE_PORT || 4328);
const baseUrl = `http://${host}:${port}`;
const serverStartTimeoutMs = Number(process.env.METRICS_HEALTH_STATE_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.METRICS_HEALTH_STATE_SMOKE_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const childExitTimeoutMs = 10000;
const portReleaseTimeoutMs = 5000;
const redisConnectTimeoutMs = 3000;
const workerToken = 'metrics_health_state_worker_smoke_token';
const adminToken = 'metrics_health_state_admin_smoke_token';
const isolatedRedisUrl = String(process.env.METRICS_HEALTH_STATE_SMOKE_REDIS_URL || '').trim();
const redisOptIn = String(process.env.METRICS_HEALTH_STATE_SMOKE_ALLOW_REDIS || '').trim() === 'true';
const redisPrefix = `lead-health-state-smoke-${process.pid}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const statesKey = `${redisPrefix}:metrics:health:states`;
const transitionsKey = `${redisPrefix}:metrics:health:transitions`;
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const astroCliPath = join(projectRoot, 'node_modules', 'astro', 'bin', 'astro.mjs');
const astroDevMetadataPath = join(projectRoot, '.astro', 'dev.json');
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
  for (const line of lines) serverLogs.push(`[${source}] ${line}`);
  if (serverLogs.length > 250) serverLogs.splice(0, serverLogs.length - 250);
}

function tailServerLogs() {
  return serverLogs.slice(-50).join('\n') || '(no server logs)';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizedParentEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|REDIS_URL|WEBHOOK_URL)/i.test(key)) delete env[key];
  }
  return env;
}

function assertNoNumericConversionFields(payload, label) {
  assert(
    !/"(?:conversionRate|baselineConversionRate|baselineAvgConversionRate|deltaPct|deltaConversionPct)"/.test(
      JSON.stringify(payload)
    ),
    `${label} contains a legacy numeric conversion field`
  );
}

function assertUnavailableWorkerPayload(payload, label, expectedSource) {
  assert(payload?.success === true, `${label} returned success=false`);
  assert(payload?.evaluation?.conversion?.available === false, `${label} must mark conversion unavailable`);
  assert(payload?.evaluation?.conversion?.reason === 'CONSENT_SCOPE_MISMATCH', `${label} returned unexpected reason`);
  assert(payload?.evaluation?.statisticsSource?.status === 'NOT_CHECKED', `${label} must not claim statistics health`);
  assert(Number(payload?.evaluation?.summary?.slicesEvaluated) === 0, `${label} must evaluate zero slices`);
  assert(Number(payload?.evaluation?.summary?.transitions) === 0, `${label} must create zero transitions`);
  assert(payload?.evaluation?.stateStore?.dataSource === expectedSource, `${label} state-store source mismatch`);
  assert(
    Array.isArray(payload?.evaluation?.problematic) && payload.evaluation.problematic.length === 0,
    `${label} problematic must be empty`
  );
  assert(
    Array.isArray(payload?.evaluation?.transitionsTop) && payload.evaluation.transitionsTop.length === 0,
    `${label} transitionsTop must be empty`
  );
  assert(
    Array.isArray(payload?.businessTransitions) && payload.businessTransitions.length === 0,
    `${label} businessTransitions must be empty`
  );
  assert(payload?.alertSent === false, `${label} must not send a conversion alert`);
  assertNoNumericConversionFields(payload, label);
}

function assertUnavailableAdminPayload(payload, view, expectedSource) {
  assert(payload?.ok === true, `Admin ${view} returned ok=false`);
  assert(payload?.conversion?.available === false, `Admin ${view} must mark conversion unavailable`);
  assert(payload?.conversion?.reason === 'CONSENT_SCOPE_MISMATCH', `Admin ${view} returned unexpected reason`);
  assert(payload?.statisticsSource?.status === 'NOT_CHECKED', `Admin ${view} must not claim statistics health`);
  assert(payload?.legacyStateDataSuppressed === true, `Admin ${view} must suppress legacy data`);
  assert(payload?.stateStore?.dataSource === expectedSource, `Admin ${view} state-store source mismatch`);
  assert(Number(payload?.summary?.statesTracked) === 0, `Admin ${view} must report zero current states`);
  assert(Number(payload?.summary?.transitionsSampled) === 0, `Admin ${view} must report zero transitions`);
  assert(Array.isArray(payload?.[view]) && payload[view].length === 0, `Admin ${view} must return an empty array`);
  assertNoNumericConversionFields(payload, `Admin ${view}`);
}

function fetchWithTimeout(url, init = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
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
  try {
    const metadata = JSON.parse(await readFile(astroDevMetadataPath, 'utf8'));
    const pid = Number(metadata?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !isProcessRunning(pid)) return null;
    return { pid, url: typeof metadata?.url === 'string' ? metadata.url : '(address unavailable)' };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new BlockedByEnvironmentError(`Unable to inspect ${astroDevMetadataPath}: ${error.message}`);
  }
}

async function canBindPort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (error) => {
      if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') return resolve(false);
      reject(error);
    });
    probe.listen({ host, port, exclusive: true }, () =>
      probe.close((error) => (error ? reject(error) : resolve(true)))
    );
  });
}

async function assertSmokeEnvironment() {
  if (host !== '127.0.0.1') {
    throw new BlockedByEnvironmentError('Metrics health state-store smoke HTTP host must be exactly 127.0.0.1.');
  }
  const existingAstro = await findExistingProjectAstro();
  if (existingAstro) {
    throw new BlockedByEnvironmentError(
      `Astro for this project is already running at ${existingAstro.url} (pid ${existingAstro.pid}); it was not stopped.`
    );
  }
  if (!(await canBindPort())) {
    throw new BlockedByEnvironmentError(`Test port ${host}:${port} is unavailable; no existing server was used.`);
  }
}

function resolveRedisConfig() {
  if (!isolatedRedisUrl) return null;
  if (!redisOptIn) {
    throw new BlockedByEnvironmentError(
      'METRICS_HEALTH_STATE_SMOKE_REDIS_URL was provided without METRICS_HEALTH_STATE_SMOKE_ALLOW_REDIS=true.'
    );
  }
  let parsed;
  try {
    parsed = new URL(isolatedRedisUrl);
  } catch {
    throw new BlockedByEnvironmentError('The dedicated state-store smoke Redis URL is invalid.');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) {
    throw new BlockedByEnvironmentError('The dedicated state-store smoke Redis URL must use redis:// or rediss://.');
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)) {
    throw new BlockedByEnvironmentError('Only an explicitly opted-in loopback Redis is allowed for this smoke.');
  }
  return { url: isolatedRedisUrl };
}

function isolatedChildEnv(redisConfig) {
  return {
    ...sanitizedParentEnv(),
    ASTRO_TELEMETRY_DISABLED: '1',
    ASTRO_DEV_BACKGROUND: '0',
    NODE_OPTIONS: '',
    ALLOW_DEV_BYPASS: 'false',
    REDIS_URL: redisConfig?.url || '',
    CONTACT_REDIS_PREFIX: redisPrefix,
    CONTACT_WEBHOOK_URL: '',
    CONTACT_WEBHOOK_SECRET: '',
    CONTACT_ALERT_WEBHOOK_URL: '',
    CONTACT_ALERT_WEBHOOK_URL_SECONDARY: '',
    CONTACT_ALERT_WEBHOOK_TOKEN: '',
    RUM_ALERT_WEBHOOK_URL: '',
    RUM_ALERT_WEBHOOK_TOKEN: '',
    SMARTCAPTCHA_CLIENT_KEY: '',
    SMARTCAPTCHA_SERVER_KEY: '',
    METRICS_HEALTH_WORKER_TOKEN: workerToken,
    METRICS_WORKER_TOKEN: '',
    CONTACT_WORKER_TOKEN: '',
    METRICS_ADMIN_TOKEN: adminToken,
    MBL_MONITORING_TOKEN: '',
    MBL_OWNER_METRICS_TOKEN: '',
  };
}

function startAstroServer(redisConfig) {
  const child = spawn(process.execPath, [astroCliPath, 'dev', '--host', host, '--port', String(port)], {
    cwd: projectRoot,
    env: isolatedChildEnv(redisConfig),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: false,
  });
  const runtime = { child, readyObserved: false, startupText: '', exitRecord: null, spawnError: null };
  const observe = (source, chunk) => {
    const text = String(chunk);
    addServerLogs(source, text);
    runtime.startupText = `${runtime.startupText}${text.replace(ansiColorPattern, '')}`.slice(-12000);
    if (/(?:astro\s+v[^\r\n]*ready in|\[vite\]\s+connected)/i.test(runtime.startupText)) {
      runtime.readyObserved = true;
    }
  };
  child.stdout?.on('data', (chunk) => observe('stdout', chunk));
  child.stderr?.on('data', (chunk) => observe('stderr', chunk));
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
  return record ? `code=${String(record.code)}, signal=${String(record.signal)}` : 'exit not observed';
}

async function waitForAstroExit(runtime, timeoutMs = childExitTimeoutMs) {
  if (runtime.exitRecord) return runtime.exitRecord;
  if (runtime.spawnError && !runtime.child.pid) throw new Error('Astro failed to spawn', { cause: runtime.spawnError });
  const timeoutMarker = Symbol('child-exit-timeout');
  const result = await Promise.race([runtime.exitPromise, delay(timeoutMs, timeoutMarker)]);
  if (result === timeoutMarker) throw new Error(`Astro pid ${String(runtime.child.pid)} did not confirm exit`);
  return result;
}

async function waitForPortRelease() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < portReleaseTimeoutMs) {
    if (await canBindPort()) return;
    await delay(100);
  }
  throw new Error(`Test port ${host}:${port} was not released`);
}

async function stopAstroServer(runtime) {
  if (!runtime) return null;
  if (runtime.exitRecord) {
    await waitForPortRelease();
    return runtime.exitRecord;
  }
  if (runtime.spawnError && !runtime.child.pid) throw new Error('Astro failed to spawn', { cause: runtime.spawnError });
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
      if (killerResult.error) {
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
    if (!runtime.exitRecord) throw error;
  }
  try {
    const exitRecord = await waitForAstroExit(runtime, 5000);
    await waitForPortRelease();
    return exitRecord;
  } catch (gracefulError) {
    try {
      process.kill(-runtime.child.pid, 'SIGKILL');
    } catch (error) {
      if (!runtime.exitRecord) throw new AggregateError([gracefulError, error], 'Astro cleanup failed');
    }
    const exitRecord = await waitForAstroExit(runtime);
    await waitForPortRelease();
    return exitRecord;
  }
}

async function waitForHealth(runtime) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < serverStartTimeoutMs) {
    if (runtime.spawnError) throw new Error('Dev server failed to start', { cause: runtime.spawnError });
    if (runtime.exitRecord)
      throw new Error(`Dev server exited (${formatExitRecord(runtime.exitRecord)}).\n${tailServerLogs()}`);
    if (runtime.readyObserved) {
      try {
        const response = await fetchWithTimeout(`${baseUrl}/api/health`);
        const payload = await response.json().catch(() => null);
        if (response.ok && payload?.ok === true && payload?.service === 'seo-lead-pipeline') return;
      } catch {
        // Continue polling only the server started by this script.
      }
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for own Astro /api/health.\n${tailServerLogs()}`);
}

async function runUnauthorizedWorkerCall() {
  const response = await fetchWithTimeout(`${baseUrl}/api/workers/metrics-health-eval`, {
    method: 'POST',
    headers: { Origin: baseUrl },
  });
  assert(response.status === 401, `Expected worker 401, got ${response.status}`);
}

async function runHealthEvalWorker(label, expectedSource) {
  const response = await fetchWithTimeout(`${baseUrl}/api/workers/metrics-health-eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}`, Origin: baseUrl },
    body: JSON.stringify({ day: new Date().toISOString().slice(0, 10), baselineDays: 1, sendAlert: true }),
  });
  const payload = await response.json().catch(() => null);
  assert(response.ok, `${label} worker failed with status ${response.status}`);
  assertUnavailableWorkerPayload(payload, label, expectedSource);
  return payload;
}

async function assertAdminUnauthorized() {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/metrics-health?view=summary`);
  assert(response.status === 401, `Expected admin 401, got ${response.status}`);
}

async function getAdminView(view, expectedSource) {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/metrics-health?view=${view}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const payload = await response.json().catch(() => null);
  assert(response.ok, `Admin ${view} failed with status ${response.status}`);
  assertUnavailableAdminPayload(payload, view, expectedSource);
  return payload;
}

function snapshotRedisKeys(client) {
  return Promise.all(
    [statesKey, transitionsKey].map(async (key) => {
      const [type, dump, ttl] = await Promise.all([
        client.sendCommand(['TYPE', key]),
        client.sendCommand(['DUMP', key]),
        client.sendCommand(['PTTL', key]),
      ]);
      return {
        key,
        type: String(type),
        dump: dump ? Buffer.from(dump).toString('base64') : null,
        ttl: Number(ttl),
      };
    })
  );
}

function destroyRedisClient(client) {
  try {
    client.destroy();
  } catch (error) {
    if (client.isOpen) throw error;
  }
}

async function deleteOwnedRedisKeys(client) {
  if (!client.isOpen) throw new Error('Redis client closed before owned test keys could be removed');
  await client.sendCommand(['DEL', statesKey, transitionsKey]);
}

async function prepareIsolatedRedis(redisConfig) {
  if (!redisConfig) return null;
  const client = createClient({
    url: redisConfig.url,
    RESP: 2,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: redisConnectTimeoutMs,
      reconnectStrategy: false,
    },
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    const cleanupErrors = [];
    try {
      destroyRedisClient(client);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], 'Redis connection and client cleanup both failed');
    }
    throw new BlockedByEnvironmentError(
      `Unable to connect to the explicitly opted-in loopback Redis: ${error.message}`
    );
  }

  try {
    await deleteOwnedRedisKeys(client);
    const now = new Date().toISOString();
    await client.sendCommand([
      'HSET',
      statesKey,
      'global|legacy-smoke',
      JSON.stringify({
        scope: 'global',
        key: 'legacy-smoke',
        state: 'CRITICAL',
        since: now,
        previousState: 'HEALTHY',
        stableDays: 1,
        updatedAtMs: Date.now(),
      }),
    ]);
    await client.sendCommand([
      'XADD',
      transitionsKey,
      '*',
      'payload',
      JSON.stringify({
        scope: 'global',
        key: 'legacy-smoke',
        from: 'HEALTHY',
        to: 'CRITICAL',
        at: now,
        reason: 'legacy_test_fixture',
        stableDays: 1,
      }),
    ]);
    return { client, before: await snapshotRedisKeys(client) };
  } catch (error) {
    const cleanupErrors = [];
    try {
      await deleteOwnedRedisKeys(client);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      destroyRedisClient(client);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], 'Redis fixture preparation and cleanup both failed');
    }
    throw error;
  }
}

async function cleanupIsolatedRedis(redisRuntime) {
  if (!redisRuntime) return;
  const cleanupErrors = [];
  try {
    await deleteOwnedRedisKeys(redisRuntime.client);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    destroyRedisClient(redisRuntime.client);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Owned Redis test cleanup failed');
}

async function main() {
  await assertSmokeEnvironment();
  const redisConfig = resolveRedisConfig();
  const expectedSource = redisConfig ? 'redis' : 'memory';
  let redisRuntime;
  let astroRuntime;
  let primaryError;
  let passSummary = '';
  try {
    redisRuntime = await prepareIsolatedRedis(redisConfig);
    astroRuntime = startAstroServer(redisConfig);
    await waitForHealth(astroRuntime);
    await runUnauthorizedWorkerCall();
    await assertAdminUnauthorized();
    await runHealthEvalWorker('First evaluation', expectedSource);
    await runHealthEvalWorker('Second evaluation', expectedSource);
    await getAdminView('states', expectedSource);
    await getAdminView('transitions', expectedSource);

    if (redisRuntime) {
      const after = await snapshotRedisKeys(redisRuntime.client);
      assert(
        JSON.stringify(after) === JSON.stringify(redisRuntime.before),
        'Owned legacy Redis keys changed during evaluation'
      );
      passSummary =
        'Metrics health state-store smoke PASS: two evaluations, no business writes, legacy payload unchanged';
    } else {
      passSummary = 'Metrics health state-store HTTP checks completed; Redis write absence NOT VERIFIED';
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  let exitRecord;
  if (astroRuntime) {
    try {
      exitRecord = await stopAstroServer(astroRuntime);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (redisRuntime) {
    try {
      await cleanupIsolatedRedis(redisRuntime);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError && cleanupErrors.length)
    throw new AggregateError([primaryError, ...cleanupErrors], 'Smoke and cleanup failed');
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Smoke assertions passed but cleanup failed');
  if (primaryError) throw primaryError;

  console.log(passSummary);
  console.log(`Metrics health state-store cleanup PASS: Astro ${formatExitRecord(exitRecord)}; port released=true`);
  if (!redisConfig) {
    throw new BlockedByEnvironmentError(
      'Safe HTTP checks passed, but no explicitly opted-in isolated loopback Redis was provided; Redis write absence is BLOCKED_BY_ENV.'
    );
  }
}

main().catch((error) => {
  if (error?.code === 'BLOCKED_BY_ENV') {
    console.error('Metrics health state-store smoke BLOCKED_BY_ENV.');
    console.error(error.message);
    process.exit(2);
  }
  console.error('Metrics health state-store smoke FAIL.');
  console.error(error);
  if (serverLogs.length > 0) console.error(tailServerLogs());
  process.exit(1);
});
