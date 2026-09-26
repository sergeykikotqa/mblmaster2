import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const host = String(process.env.METRICS_HEALTH_FALLBACK_ALERT_SMOKE_HOST || '127.0.0.1').trim();
const port = Number(process.env.METRICS_HEALTH_FALLBACK_ALERT_SMOKE_PORT || 4331);
const baseUrl = `http://${host}:${port}`;
const serverStartTimeoutMs = Number(process.env.METRICS_HEALTH_FALLBACK_ALERT_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.METRICS_HEALTH_FALLBACK_ALERT_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const childExitTimeoutMs = 10000;
const portReleaseTimeoutMs = 5000;
const workerToken = 'metrics_health_fallback_alert_worker_token';
const alertToken = 'metrics_health_fallback_alert_webhook_token';
const cooldownSec = Number(process.env.METRICS_HEALTH_FALLBACK_ALERT_COOLDOWN_SEC || 3600);
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

function assertUnavailableWorkerPayload(payload, label) {
  assert(payload?.success === true, `${label} returned success=false`);
  assert(payload?.evaluation?.conversion?.available === false, `${label} must mark conversion unavailable`);
  assert(payload?.evaluation?.conversion?.reason === 'CONSENT_SCOPE_MISMATCH', `${label} returned unexpected reason`);
  assert(payload?.evaluation?.statisticsSource?.status === 'NOT_CHECKED', `${label} must not claim statistics health`);
  assert(Number(payload?.evaluation?.summary?.slicesEvaluated) === 0, `${label} must evaluate zero slices`);
  assert(Number(payload?.evaluation?.summary?.transitions) === 0, `${label} must create zero transitions`);
  assert(payload?.evaluation?.stateStore?.dataSource === 'memory', `${label} must use memory fallback`);
  assert(payload?.evaluation?.stateStore?.degraded === true, `${label} must expose technical degradation`);
  assert(
    Array.isArray(payload?.businessTransitions) && payload.businessTransitions.length === 0,
    `${label} businessTransitions must be empty`
  );
  assert(payload?.alertSent === false, `${label} must not send conversion transition alerts`);
  assertNoNumericConversionFields(payload, label);
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
    throw new BlockedByEnvironmentError('Metrics health fallback alert smoke HTTP host must be exactly 127.0.0.1.');
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

async function startMockAlertServer() {
  const events = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/alert') {
      response.statusCode = 404;
      response.end('not_found');
      return;
    }
    if ((request.headers.authorization || '') !== `Bearer ${alertToken}`) {
      response.statusCode = 401;
      response.end('unauthorized');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let payload = null;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      payload = null;
    }
    events.push({ payload });
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Local alert receiver failed to start');
  return {
    events,
    alertWebhookUrl: `http://${host}:${address.port}/alert`,
    async stop() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function isolatedChildEnv(alertWebhookUrl) {
  return {
    ...sanitizedParentEnv(),
    ASTRO_TELEMETRY_DISABLED: '1',
    ASTRO_DEV_BACKGROUND: '0',
    NODE_OPTIONS: '',
    ALLOW_DEV_BYPASS: 'false',
    REDIS_URL: 'redis://127.0.0.1:1',
    CONTACT_REDIS_TIMEOUT_MS: '300',
    CONTACT_REDIS_PREFIX: `lead-health-fallback-alert-${process.pid}-${Date.now().toString(36)}`,
    CONTACT_WEBHOOK_URL: '',
    CONTACT_WEBHOOK_SECRET: '',
    CONTACT_ALERT_WEBHOOK_URL: alertWebhookUrl,
    CONTACT_ALERT_WEBHOOK_URL_SECONDARY: '',
    CONTACT_ALERT_WEBHOOK_TOKEN: alertToken,
    CONTACT_ALERT_MAX_RETRIES: '0',
    RUM_ALERT_WEBHOOK_URL: '',
    RUM_ALERT_WEBHOOK_TOKEN: '',
    SMARTCAPTCHA_CLIENT_KEY: '',
    SMARTCAPTCHA_SERVER_KEY: '',
    METRICS_HEALTH_WORKER_TOKEN: workerToken,
    METRICS_WORKER_TOKEN: '',
    CONTACT_WORKER_TOKEN: '',
    METRICS_ADMIN_TOKEN: '',
    MBL_MONITORING_TOKEN: '',
    MBL_OWNER_METRICS_TOKEN: '',
    METRICS_HEALTH_STORE_FALLBACK_ALERT_COOLDOWN_SEC: String(cooldownSec),
  };
}

function startAstroServer(alertWebhookUrl) {
  const child = spawn(process.execPath, [astroCliPath, 'dev', '--host', host, '--port', String(port)], {
    cwd: projectRoot,
    env: isolatedChildEnv(alertWebhookUrl),
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

async function runHealthEvalWorker(label) {
  const response = await fetchWithTimeout(`${baseUrl}/api/workers/metrics-health-eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}`, Origin: baseUrl },
    body: JSON.stringify({ day: new Date().toISOString().slice(0, 10), baselineDays: 1, sendAlert: true }),
  });
  const payload = await response.json().catch(() => null);
  assert(response.ok, `${label} worker failed with status ${response.status}`);
  assertUnavailableWorkerPayload(payload, label);
  return payload;
}

async function main() {
  await assertSmokeEnvironment();
  let receiver;
  let runtime;
  let primaryError;
  let passSummary = '';
  try {
    receiver = await startMockAlertServer();
    runtime = startAstroServer(receiver.alertWebhookUrl);
    await waitForHealth(runtime);
    const firstRun = await runHealthEvalWorker('First evaluation');
    const secondRun = await runHealthEvalWorker('Second evaluation');

    assert(firstRun?.healthStoreFallbackAlertSent === true, 'First evaluation must send one fallback alert');
    assert(secondRun?.healthStoreFallbackAlertSent === false, 'Second evaluation must be blocked by cooldown');
    assert(receiver.events.length === 1, `Expected exactly one alert event, got ${receiver.events.length}`);
    const [event] = receiver.events;
    assert(event?.payload?.event === 'conversion_health_store_fallback_alert', 'Unexpected alert event type');
    assert(event?.payload?.dataSource === 'memory', 'Fallback alert must report memory data source');
    assert(event?.payload?.metricsDegraded === true, 'Fallback alert must report technical degradation');
    assert(Number(event?.payload?.summary?.transitions) === 0, 'Fallback alert must report zero business transitions');
    assert(
      receiver.events.every((entry) => entry?.payload?.event !== 'conversion_health_transition_alert'),
      'Conversion transition alert must not be emitted'
    );
    assert(
      receiver.events.every((entry) => entry?.payload?.event !== 'conversion_snapshot_anomaly_alert'),
      'Legacy conversion snapshot alert must not be emitted'
    );
    passSummary =
      'Metrics health fallback alert smoke PASS: one technical alert, cooldown enforced, conversion alerts=0';
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  let exitRecord;
  if (runtime) {
    try {
      exitRecord = await stopAstroServer(runtime);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (receiver) {
    try {
      await receiver.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError && cleanupErrors.length)
    throw new AggregateError([primaryError, ...cleanupErrors], 'Smoke and cleanup failed');
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Smoke assertions passed but cleanup failed');
  if (primaryError) throw primaryError;
  console.log(passSummary);
  console.log(`Metrics health fallback alert cleanup PASS: Astro ${formatExitRecord(exitRecord)}; port released=true`);
}

main().catch((error) => {
  if (error?.code === 'BLOCKED_BY_ENV') {
    console.error('Metrics health fallback alert smoke BLOCKED_BY_ENV.');
    console.error(error.message);
    process.exit(2);
  }
  console.error('Metrics health fallback alert smoke FAIL.');
  console.error(error);
  if (serverLogs.length > 0) console.error(tailServerLogs());
  process.exit(1);
});
