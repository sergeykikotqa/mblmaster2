import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = process.cwd();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 30_000,
  });
  if (result.status !== 0) throw new Error(`${command} failed`);
  return String(result.stdout || '').trim();
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // bounded retry below
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('runtime readiness timeout');
}

async function main() {
  assert(fs.existsSync(path.join(ROOT, '.output', 'server', 'entry.mjs')), 'Run npm run build before runtime smoke');
  run('docker', ['version', '--format', '{{.Server.Version}}']);
  const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
  const container = `mbl-owner-metrics-${suffix}`;
  assert(/^mbl-owner-metrics-[a-zA-Z0-9-]+$/.test(container));
  let app;

  try {
    run('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      '--publish',
      '127.0.0.1::6379',
      'redis:7.4.7-alpine3.21',
      'redis-server',
      '--appendonly',
      'no',
      '--save',
      '',
    ]);
    await waitFor(() => run('docker', ['exec', container, 'redis-cli', 'ping']) === 'PONG', 30_000);
    const mapped = run('docker', ['port', container, '6379/tcp']);
    const portMatch = /:(\d+)\s*$/.exec(mapped);
    assert(portMatch, 'Redis mapped port unavailable');
    const redisPort = Number(portMatch[1]);

    const prefix = `owner-smoke-${suffix}`;
    const bucket = new Date().toISOString().slice(0, 13);
    const key = `${prefix}:metrics:funnel:hour:${bucket}`;
    run('docker', [
      'exec',
      container,
      'redis-cli',
      'HSET',
      key,
      'page_view|%2Firkutsk|irkutsk||kuhni|geo|',
      '5',
      'form_opened|%2Firkutsk|irkutsk||kuhni|geo|',
      '2',
      'form_submitted|%2Firkutsk|irkutsk||kuhni|geo|',
      '1',
    ]);
    run('docker', ['exec', container, 'redis-cli', 'EXPIRE', key, String(14 * 24 * 60 * 60)]);

    const appPort = await freePort();
    const token = `owner-${randomBytes(24).toString('hex')}`;
    app = spawn(process.execPath, ['scripts/start-node.mjs'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(appPort),
        PUBLIC_SITE_URL: 'https://mebel-irkutsk.ru',
        REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
        CONTACT_REDIS_PREFIX: prefix,
        MBL_OWNER_METRICS_TOKEN: token,
        METRICS_ADMIN_TOKEN: `admin-${randomBytes(24).toString('hex')}`,
        MBL_MONITORING_TOKEN: `monitor-${randomBytes(24).toString('hex')}`,
      },
    });
    const appOrigin = `http://127.0.0.1:${appPort}`;
    await waitFor(async () => (await fetch(`${appOrigin}/health/live`)).status === 200, 30_000);

    const denied = await fetch(`${appOrigin}/api/monitoring/owner-metrics?period=today`);
    assert([401, 403].includes(denied.status), `unauthorized status ${denied.status}`);
    const accepted = await fetch(`${appOrigin}/api/monitoring/owner-metrics?period=today`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    assert.equal(body.period?.timeZone, 'Asia/Irkutsk');
    assert.deepEqual(body.counts, { pageViews: 5, opened: 2, submitted: 1 });
    assert(!/name|phone|message|leadId/i.test(JSON.stringify(body)), 'aggregate API exposed lead fields');

    console.log('Owner metrics runtime smoke passed: production Node artifact + disposable Docker Redis.');
  } finally {
    if (app && app.exitCode === null) {
      app.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => app.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (app.exitCode === null) app.kill('SIGKILL');
    }
    spawnSync('docker', ['rm', '--force', container], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 30_000,
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'OWNER_METRICS_RUNTIME_FAILED');
  process.exitCode = 1;
});
