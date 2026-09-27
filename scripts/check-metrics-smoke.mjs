import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const host = process.env.METRICS_SMOKE_HOST || '127.0.0.1';
const port = Number(process.env.METRICS_SMOKE_PORT || 4322);
const baseUrl = `http://${host}:${port}`;
const serverStartTimeoutMs = Number(process.env.METRICS_SMOKE_TIMEOUT_MS || 45000);
const requestTimeoutMs = Number(process.env.METRICS_SMOKE_REQUEST_TIMEOUT_MS || 10000);
const pollIntervalMs = 500;
const childExitTimeoutMs = 10000;
const portReleaseTimeoutMs = 5000;
const smokePageSlug = '/kuhni';
const configuredServerAdminToken = String(process.env.METRICS_ADMIN_TOKEN || '').trim();
const serverAdminToken = configuredServerAdminToken || `metrics-smoke-admin-${process.pid}`;
const adminToken = String(process.env.METRICS_SMOKE_ADMIN_TOKEN || serverAdminToken).trim();
const isCi =
  String(process.env.CI || '')
    .trim()
    .toLowerCase() === 'true';
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
  if (serverLogs.length > 200) serverLogs.splice(0, serverLogs.length - 200);
}

function tailServerLogs() {
  return serverLogs.slice(-40).join('\n') || '(no server logs)';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fetchWithTimeout(url, init = {}, timeoutMs = requestTimeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function sanitizedParentEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|REDIS_URL|WEBHOOK_URL)/i.test(key)) delete env[key];
  }
  return env;
}

function isolatedChildEnv() {
  return {
    ...sanitizedParentEnv(),
    ASTRO_TELEMETRY_DISABLED: '1',
    ASTRO_DEV_BACKGROUND: '0',
    NODE_OPTIONS: '',
    ALLOW_DEV_BYPASS: 'false',
    REDIS_URL: '',
    CONTACT_REDIS_PREFIX: `lead-metrics-smoke-${process.pid}-${Date.now().toString(36)}`,
    CONTACT_RATE_LIMIT_MAX: '100',
    CONTACT_RATE_LIMIT_WINDOW_SEC: '60',
    CONTACT_SMARTCAPTCHA_REQUIRED: 'false',
    SMARTCAPTCHA_CLIENT_KEY: '',
    SMARTCAPTCHA_SERVER_KEY: '',
    CONTACT_WEBHOOK_URL: '',
    CONTACT_WEBHOOK_SECRET: '',
    CONTACT_WORKER_TOKEN: '',
    CONTACT_WORKER_URL: 'http://127.0.0.1:1/__mbl_metrics_smoke_no_worker__',
    CONTACT_WORKER_TRIGGER_TIMEOUT_MS: '100',
    METRICS_ADMIN_TOKEN: serverAdminToken,
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
  return await new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (error) => {
      if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') return resolvePromise(false);
      reject(error);
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolvePromise(true)));
    });
  });
}

async function assertSmokeEnvironment() {
  if (host !== '127.0.0.1') {
    throw new BlockedByEnvironmentError('Metrics smoke HTTP host must be exactly 127.0.0.1.');
  }
  const existingAstro = await findExistingProjectAstro();
  if (existingAstro) {
    throw new BlockedByEnvironmentError(
      `Astro for this project is already running at ${existingAstro.url} (pid ${existingAstro.pid}). ` +
        'Stop it from its owning terminal and rerun; it was not stopped by this smoke.'
    );
  }
  if (!(await canBindPort())) {
    throw new BlockedByEnvironmentError(
      `Test port ${host}:${port} is unavailable. No existing server response was accepted and no process was stopped.`
    );
  }
}

function startServer() {
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
    if (/(?:astro\s+v[^\r\n]*ready in|\[vite\]\s+connected)/i.test(runtime.startupText)) runtime.readyObserved = true;
  };
  child.stdout?.on('data', (chunk) => observe('stdout', chunk));
  child.stderr?.on('data', (chunk) => observe('stderr', chunk));
  runtime.exitPromise = new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => {
      runtime.exitRecord = { code, signal };
      resolvePromise(runtime.exitRecord);
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

async function waitForServerExit(runtime, timeoutMs = childExitTimeoutMs) {
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

async function stopServer(runtime) {
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
    const killerResult = await new Promise((resolvePromise, reject) => {
      killer.once('error', reject);
      killer.once('exit', (code, signal) => resolvePromise({ code, signal }));
    }).catch((error) => ({ error }));
    try {
      const exitRecord = await waitForServerExit(runtime);
      await waitForPortRelease();
      return exitRecord;
    } catch (error) {
      if (killerResult.error)
        throw new AggregateError([error, killerResult.error], 'Astro cleanup and taskkill both failed');
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
    const exitRecord = await waitForServerExit(runtime, 5000);
    await waitForPortRelease();
    return exitRecord;
  } catch (gracefulError) {
    try {
      process.kill(-runtime.child.pid, 'SIGKILL');
    } catch (error) {
      if (!runtime.exitRecord) throw new AggregateError([gracefulError, error], 'Astro cleanup failed');
    }
    const exitRecord = await waitForServerExit(runtime);
    await waitForPortRelease();
    return exitRecord;
  }
}

async function waitForHealth(runtime) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < serverStartTimeoutMs) {
    if (runtime.spawnError) throw new Error('Dev server failed to start', { cause: runtime.spawnError });
    if (runtime.exitRecord) {
      throw new Error(
        `Dev server exited before readiness (${formatExitRecord(runtime.exitRecord)}).\n${tailServerLogs()}`
      );
    }
    if (runtime.readyObserved) {
      try {
        const response = await fetchWithTimeout(`${baseUrl}/api/health`, { method: 'GET' });
        const payload = await response.json().catch(() => null);
        if (response.ok && payload?.ok === true && payload?.service === 'seo-lead-pipeline') return;
      } catch {
        // Own Astro announced readiness; continue polling its endpoint.
      }
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for own Astro /api/health.\n${tailServerLogs()}`);
}

async function readJsonResponse(response, label) {
  const rawBody = await response.text();
  try {
    return rawBody ? JSON.parse(rawBody) : null;
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON (status=${response.status}, url=${response.url}): ${error.message}`
    );
  }
}

function responseFailure(label, response, payload) {
  const code = typeof payload?.code === 'string' ? payload.code : 'UNKNOWN';
  const message = typeof payload?.message === 'string' ? payload.message : 'No response message';
  return `${label} failed: status=${response.status}, url=${response.url}, code=${code}, message=${message}`;
}

function leadRequestBody() {
  return JSON.stringify({
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
    attribution: { currentPath: smokePageSlug, utm_source: 'ci' },
  });
}

export async function checkContactRedirectContract({ targetBaseUrl, idempotencyKey, fetchImpl = fetch }) {
  const body = leadRequestBody();
  const headers = { 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey };
  const request = (redirect) =>
    fetchWithTimeout(
      `${targetBaseUrl}/api/contact`,
      { method: 'POST', headers, body, redirect },
      requestTimeoutMs,
      fetchImpl
    );

  const redirectResponse = await request('manual');
  const location = redirectResponse.headers.get('location') || '';
  assert(
    redirectResponse.status === 307,
    `POST /api/contact redirect contract failed: status=${redirectResponse.status}, url=${redirectResponse.url}`
  );
  const redirectUrl = new URL(location, targetBaseUrl);
  assert(
    redirectUrl.origin === targetBaseUrl && redirectUrl.pathname === '/api/leads',
    `POST /api/contact redirect target is unsafe or unexpected: ${redirectUrl.toString()}`
  );

  const firstResponse = await request('follow');
  const firstPayload = await readJsonResponse(firstResponse, 'POST /api/contact');
  assert(firstResponse.ok, responseFailure('POST /api/contact', firstResponse, firstPayload));
  assert(new URL(firstResponse.url).pathname === '/api/leads', `POST /api/contact ended at ${firstResponse.url}`);
  assert(firstPayload?.success === true, 'POST /api/contact returned non-success payload');
  assert(typeof firstPayload?.leadId === 'string' && firstPayload.leadId, 'POST /api/contact did not return leadId');

  const duplicateResponse = await request('follow');
  const duplicatePayload = await readJsonResponse(duplicateResponse, 'Repeated POST /api/contact');
  assert(duplicateResponse.ok, responseFailure('Repeated POST /api/contact', duplicateResponse, duplicatePayload));
  assert(duplicatePayload?.success === true, 'Repeated POST /api/contact returned non-success payload');
  assert(duplicatePayload?.duplicate === true, 'Repeated POST /api/contact did not preserve idempotency header');
  assert(duplicatePayload?.leadId === firstPayload.leadId, 'Repeated POST /api/contact returned a different leadId');

  return { leadId: firstPayload.leadId, location: redirectUrl.toString(), finalUrl: firstResponse.url };
}

async function getFunnelCounters() {
  const response = await fetchWithTimeout(
    `${baseUrl}/api/admin/metrics?span=day&pageSlug=${encodeURIComponent(smokePageSlug)}&city=irkutsk&service=kuhni-na-zakaz&limit=5`,
    { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const payload = await readJsonResponse(response, 'Metrics rollup endpoint');
  assert(response.ok, responseFailure('Metrics rollup endpoint', response, payload));
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

async function postTrackEvent(event, reason = '') {
  const response = await fetchWithTimeout(`${baseUrl}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const payload = await readJsonResponse(response, `POST /api/track (${event})`);
  assert(response.ok, responseFailure(`POST /api/track (${event})`, response, payload));
  assert(payload?.success === true, `POST /api/track (${event}) returned non-success payload`);
  if (event !== 'form_opened') {
    assert(payload?.funnelMetricRecorded === true, `POST /api/track (${event}) did not record funnel metric`);
  }
}

async function main() {
  if (isCi && !configuredServerAdminToken) {
    throw new Error('METRICS_ADMIN_TOKEN is required when CI=true for the metrics smoke check.');
  }
  await assertSmokeEnvironment();
  let runtime;
  let primaryError;
  let passSummary = '';
  try {
    runtime = startServer();
    await waitForHealth(runtime);
    const before = await getFunnelCounters();
    await postTrackEvent('form_opened');
    await postTrackEvent('form_phone_valid');
    await postTrackEvent('form_submit_attempt');
    const contact = await checkContactRedirectContract({
      targetBaseUrl: baseUrl,
      idempotencyKey: `metrics-smoke-${Date.now()}`,
    });
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
    passSummary =
      `Metrics smoke PASS: opened ${before.opened} -> ${after.opened}, phoneValid ${before.phoneValid} -> ${after.phoneValid}, ` +
      `submitAttempt ${before.submitAttempt} -> ${after.submitAttempt}, submitted ${before.submitted} -> ${after.submitted}, ` +
      `contactRedirect=307, finalPath=${new URL(contact.finalUrl).pathname}, idempotency=preserved`;
  } catch (error) {
    primaryError = error;
  }

  let exitRecord;
  let cleanupError;
  if (runtime) {
    try {
      exitRecord = await stopServer(runtime);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'Smoke and cleanup failed');
  if (cleanupError) throw cleanupError;
  if (primaryError) {
    console.log(`Metrics smoke cleanup PASS after failure: Astro ${formatExitRecord(exitRecord)}; port released=true`);
    throw primaryError;
  }
  console.log(passSummary);
  console.log(`Metrics smoke cleanup PASS: Astro ${formatExitRecord(exitRecord)}; port released=true`);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((error) => {
    if (error?.code === 'BLOCKED_BY_ENV') {
      console.error('Metrics smoke BLOCKED_BY_ENV.');
      console.error(error.message);
      process.exit(2);
    }
    console.error('Metrics smoke FAIL.');
    console.error(error);
    if (serverLogs.length > 0) console.error(tailServerLogs());
    process.exit(1);
  });
}
