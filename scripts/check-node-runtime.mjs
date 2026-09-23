import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const entryPath = path.join(projectRoot, '.output', 'server', 'entry.mjs');
const publicRoot = path.join(projectRoot, 'dist');
const runtimeSite = new URL(process.env.PUBLIC_SITE_URL || 'https://example.com');

function countHtml(directory) {
  let count = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) count += countHtml(fullPath);
    if (entry.isFile() && entry.name.endsWith('.html')) count += 1;
  }
  return count;
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Node server exited before startup (${child.exitCode}).\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return response;
    } catch {
      // Startup is asynchronous; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Node server did not start within 30 seconds.\n${output()}`);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}, received: ${text.slice(0, 300)}`);
  }
}

function runtimeFetch(baseUrl, pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Forwarded-Host', runtimeSite.host);
  headers.set('X-Forwarded-Proto', runtimeSite.protocol.slice(0, -1));
  return fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    ...init,
    headers,
    signal: AbortSignal.timeout(5_000),
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exitPromise = new Promise((resolve) => child.once('exit', resolve));
  if (child.connected) child.send('shutdown');
  let timeoutId;
  await Promise.race([
    exitPromise,
    new Promise((resolve) => {
      timeoutId = setTimeout(resolve, 5_000);
    }),
  ]);
  clearTimeout(timeoutId);
  if (child.exitCode === null) child.kill('SIGKILL');
}

assert.ok(fs.existsSync(entryPath), `Missing production Node entry: ${entryPath}`);
assert.ok(fs.existsSync(path.join(publicRoot, 'index.html')), 'Homepage was not prerendered');
assert.ok(fs.existsSync(path.join(publicRoot, 'projects', 'index.html')), 'Projects listing was not prerendered');
assert.ok(fs.existsSync(path.join(publicRoot, 'articles', 'index.html')), 'Articles listing was not prerendered');
assert.ok(
  fs.existsSync(path.join(publicRoot, 'projects', 'biruzovaya-uglovaya-kuhnya-irkutsk', 'index.html')),
  'Project detail was not prerendered'
);
const htmlCount = countHtml(publicRoot);
assert.ok(htmlCount >= 74, `Expected public routes to remain prerendered; found only ${htmlCount} HTML files`);

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
let stdout = '';
let stderr = '';
const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'start-node.mjs')], {
  cwd: projectRoot,
  windowsHide: true,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'production',
    METRICS_ADMIN_TOKEN: 'node-runtime-smoke-admin',
    CONTACT_WORKER_TOKEN: 'node-runtime-smoke-worker',
    CONTACT_WEBHOOK_URL: 'https://127.0.0.1:9/never-called',
    CONTACT_WEBHOOK_SECRET: 'node-runtime-smoke-secret',
    CONTACT_SMARTCAPTCHA_REQUIRED: 'true',
    CONTACT_ALERT_WEBHOOK_URL: '',
    CONTACT_ALERT_WEBHOOK_URL_SECONDARY: '',
    REDIS_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => (stdout += chunk));
child.stderr.on('data', (chunk) => (stderr += chunk));
const output = () => `${stdout}\n${stderr}`.trim();

try {
  const home = await waitForServer(baseUrl, child, output);
  assert.match(home.headers.get('content-type') || '', /text\/html/i);
  assert.match(await home.text(), /<!doctype html/i);

  for (const route of [
    '/kuhni',
    '/projects',
    '/projects/biruzovaya-uglovaya-kuhnya-irkutsk',
    '/articles/kak-vybrat-kuhnyu',
    '/contacts',
  ]) {
    const response = await runtimeFetch(baseUrl, route);
    assert.equal(response.status, 200, `Expected prerendered ${route} to respond with 200`);
    assert.match(response.headers.get('content-type') || '', /text\/html/i);
  }

  const gone = await runtimeFetch(baseUrl, '/410');
  assert.equal(gone.status, 410, 'The dynamic Gone page must preserve its HTTP status');

  const health = await runtimeFetch(baseUrl, '/api/health');
  assert.equal(health.status, 503);
  const healthBody = await readJson(health);
  assert.equal(healthBody.ok, false);
  assert.equal(healthBody.redis?.configured, false);
  assert.equal(healthBody.redis?.required, true);
  assert.equal(healthBody.redis?.code, 'REDIS_NOT_CONFIGURED');

  const captchaConfig = await runtimeFetch(baseUrl, '/api/captcha/config');
  assert.equal(captchaConfig.status, 503, 'CAPTCHA configuration must fail closed without runtime keys');
  const captchaConfigBody = await readJson(captchaConfig);
  assert.equal(captchaConfigBody.provider, 'smartcaptcha');
  assert.equal(captchaConfigBody.required, true);
  assert.equal(captchaConfigBody.ready, false);
  assert.equal(captchaConfigBody.clientKey, '');

  const contactAlias = await runtimeFetch(baseUrl, '/api/contact', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'text/plain', Origin: runtimeSite.origin },
    body: '{}',
  });
  assert.equal(contactAlias.status, 307);
  assert.equal(new URL(contactAlias.headers.get('location'), baseUrl).pathname, '/api/leads');

  // The alias emits an absolute canonical redirect behind a proxy. Exercise its local
  // target directly so this gate can never follow a request outside the test process.
  const invalidContact = await runtimeFetch(baseUrl, '/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: runtimeSite.origin },
    body: '{',
  });
  assert.equal(invalidContact.status, 400);
  assert.equal((await readJson(invalidContact)).code, 'INVALID_PAYLOAD');

  const validShapeContact = await runtimeFetch(baseUrl, '/api/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: runtimeSite.origin,
      'X-Idempotency-Key': `node-runtime-smoke-${Date.now()}`,
    },
    body: JSON.stringify({
      name: 'Node Runtime Smoke',
      phone: '+7 (912) 345-67-89',
      message: 'Node runtime route smoke',
      consent: true,
    }),
  });
  assert.equal(validShapeContact.status, 500);
  assert.equal((await readJson(validShapeContact)).code, 'LEAD_STORE_NOT_CONFIGURED');

  const admin = await runtimeFetch(baseUrl, '/api/admin/health');
  assert.equal(admin.status, 503);
  assert.equal((await readJson(admin)).code, 'ADMIN_AUTH_STORE_UNAVAILABLE');

  const worker = await runtimeFetch(baseUrl, '/api/workers/lead-delivery?limit=1', {
    method: 'POST',
    headers: { Origin: runtimeSite.origin },
  });
  assert.equal(worker.status, 401);
  assert.equal((await readJson(worker)).code, 'UNAUTHORIZED');

  const invalidTokenWorker = await runtimeFetch(baseUrl, '/api/workers/lead-delivery?limit=1', {
    method: 'POST',
    headers: { Origin: runtimeSite.origin, Authorization: 'Bearer invalid-local-test-token' },
  });
  assert.equal(invalidTokenWorker.status, 401);
  assert.equal((await readJson(invalidTokenWorker)).code, 'UNAUTHORIZED');

  console.log(`[node-runtime] PASS: ${htmlCount} prerendered HTML files, standalone API routes responded safely`);
  console.log(
    '[node-runtime] 6 public routes 200; Gone 410; health 503 fail-closed; contact 307/400/500; admin store 503 fail-closed; worker 401 (missing and invalid token)'
  );
} finally {
  await stopServer(child);
}
