import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const host = String(process.env.METRICS_HEALTH_FALLBACK_SMOKE_HOST || '127.0.0.1').trim();
const port = Number(process.env.METRICS_HEALTH_FALLBACK_SMOKE_PORT || 4329);
const baseUrl = `http://${host}:${port}`;
const serverStartTimeoutMs = Number(process.env.METRICS_HEALTH_FALLBACK_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.METRICS_HEALTH_FALLBACK_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const childExitTimeoutMs = 10000;
const portReleaseTimeoutMs = 5000;
const workerToken = 'metrics_health_fallback_worker_smoke_token';
const adminToken = 'metrics_health_fallback_admin_smoke_token';
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

function assertUnavailableWorkerPayload(payload) {
  assert(payload?.success === true, 'Worker returned success=false');
  assert(payload?.evaluation?.conversion?.available === false, 'Worker must mark conversion unavailable');
  assert(payload?.evaluation?.conversion?.reason === 'CONSENT_SCOPE_MISMATCH', 'Worker returned unexpected reason');
  assert(payload?.evaluation?.statisticsSource?.status === 'NOT_CHECKED', 'Worker must not claim statistics health');
  assert(Number(payload?.evaluation?.summary?.slicesEvaluated) === 0, 'Worker must evaluate zero business slices');
  assert(Number(payload?.evaluation?.summary?.transitions) === 0, 'Worker must create zero business transitions');
  assert(payload?.evaluation?.stateStore?.dataSource === 'memory', 'Fallback must use memory state-store');
  assert(payload?.evaluation?.stateStore?.degraded === true, 'Fallback must expose state-store degradation');
  assert(
    Array.isArray(payload?.businessTransitions) && payload.businessTransitions.length === 0,
    'Worker businessTransitions must be empty'
  );
  assert(payload?.alertSent === false, 'Worker must not send conversion transition alerts');
  assertNoNumericConversionFields(payload, 'Worker');
}

function assertUnavailableAdminPayload(payload) {
  assert(payload?.ok === true, 'Admin summary returned ok=false');
  assert(payload?.conversion?.available === false, 'Admin must mark conversion unavailable');
  assert(payload?.conversion?.reason === 'CONSENT_SCOPE_MISMATCH', 'Admin returned unexpected reason');
  assert(payload?.statisticsSource?.status === 'NOT_CHECKED', 'Admin must not claim statistics health');
  assert(payload?.legacyStateDataSuppressed === true, 'Admin must suppress legacy health data');
  assert(payload?.stateStore?.dataSource === 'memory', 'Admin fallback must use memory state-store');
  assert(payload?.stateStore?.degraded === true, 'Admin must expose state-store degradation');
  assert(Number(payload?.summary?.statesTracked) === 0, 'Admin must report zero current states');
  assert(Number(payload?.summary?.transitionsSampled) === 0, 'Admin must report zero current transitions');
  assert(Number(payload?.runtime?.redisFallbackToMemoryCount) > 0, 'Admin must expose a positive fallback counter');
  assertNoNumericConversionFields(payload, 'Admin');
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
    throw new BlockedByEnvironmentError('Metrics health fallback smoke HTTP host must be exactly 127.0.0.1.');
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

function isolatedChildEnv() {
  return {
    ...sanitizedParentEnv(),
    ASTRO_TELEMETRY_DISABLED: '1',
    ASTRO_DEV_BACKGROUND: '0',
    NODE_OPTIONS: '',
    ALLOW_DEV_BYPASS: 'false',
    REDIS_URL: 'redis://127.0.0.1:1',
    CONTACT_REDIS_TIMEOUT_MS: '300',
    CONTACT_REDIS_PREFIX: `lead-health-fallback-smoke-${process.pid}-${Date.now().toString(36)}`,
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

function startAstroServer() {
  const child = spawn(process.execPath, [astroCliPath, 'dev', '--host', host, '--port', String(port)], {
    cwd: projectRoot,
    env: isolatedChildEnv(),
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
        // Continue polling own server.
      }
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for own Astro /api/health.\n${tailServerLogs()}`);
}

async function assertWorkerUnauthorized() {
  const response = await fetchWithTimeout(`${baseUrl}/api/workers/metrics-health-eval`, {
    method: 'POST',
    headers: { Origin: baseUrl },
  });
  assert(response.status === 401, `Expected worker 401, got ${response.status}`);
}

async function assertAdminUnauthorized() {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/metrics-health?view=summary`);
  assert(response.status === 401, `Expected admin 401, got ${response.status}`);
}

async function runHealthEvalWorker() {
  const response = await fetchWithTimeout(`${baseUrl}/api/workers/metrics-health-eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}`, Origin: baseUrl },
    body: JSON.stringify({ day: new Date().toISOString().slice(0, 10), baselineDays: 1, sendAlert: false }),
  });
  const payload = await response.json().catch(() => null);
  assert(response.ok, `Worker failed with status ${response.status}`);
  assertUnavailableWorkerPayload(payload);
  return payload;
}

async function getAdminSummary() {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/metrics-health?view=summary`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const payload = await response.json().catch(() => null);
  assert(response.ok, `Admin summary failed with status ${response.status}`);
  assertUnavailableAdminPayload(payload);
  return payload;
}

async function getSystemHealth() {
  const response = await fetchWithTimeout(`${baseUrl}/api/health`);
  const payload = await response.json().catch(() => null);
  assert(response.ok && payload?.ok === true, 'Development /api/health must remain live during Redis outage');
  return payload;
}

async function main() {
  await assertSmokeEnvironment();
  let runtime;
  let primaryError;
  let passSummary = '';
  try {
    runtime = startAstroServer();
    await waitForHealth(runtime);
    await assertWorkerUnauthorized();
    await assertAdminUnauthorized();
    const workerPayload = await runHealthEvalWorker();
    const adminPayload = await getAdminSummary();
    const systemHealth = await getSystemHealth();
    passSummary = `Metrics health fallback smoke PASS: source=${workerPayload.evaluation.stateStore.dataSource}, fallbackCount=${adminPayload.runtime.redisFallbackToMemoryCount}, systemOk=${String(systemHealth.ok)}`;
  } catch (error) {
    primaryError = error;
  }

  let exitRecord;
  let cleanupError;
  if (runtime) {
    try {
      exitRecord = await stopAstroServer(runtime);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'Smoke and cleanup failed');
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  console.log(passSummary);
  console.log(`Metrics health fallback cleanup PASS: Astro ${formatExitRecord(exitRecord)}; port released=true`);
}

main().catch((error) => {
  if (error?.code === 'BLOCKED_BY_ENV') {
    console.error('Metrics health fallback smoke BLOCKED_BY_ENV.');
    console.error(error.message);
    process.exit(2);
  }
  console.error('Metrics health fallback smoke FAIL.');
  console.error(error);
  if (serverLogs.length > 0) console.error(tailServerLogs());
  process.exit(1);
});
