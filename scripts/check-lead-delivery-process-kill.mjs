import assert from 'node:assert/strict';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(repoRoot, 'tests', 'fixtures', 'lead-delivery-process-kill.compose.yml');
const testFile = path.join(repoRoot, 'tests', 'lead-delivery-process-kill.integration.test.ts');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const projectPrefix = 'mbl-r04-';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object', 'Unable to reserve a loopback port');
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}${output ? `\n${output}` : ''}`);
  }
  return result;
}

function runStreaming(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env: options.env || process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} was terminated by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function safeEqual(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    assert(total <= 64 * 1024, 'R04 receiver body exceeded the test limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

async function startReceiver({ port, secret }) {
  const attempts = [];
  const accepted = new Set();
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && url.pathname === '/stats') {
        const leadId = url.searchParams.get('leadId') || '';
        const matching = attempts.filter((attempt) => !leadId || attempt.leadId === leadId);
        json(response, 200, {
          attempts: matching,
          actualAcceptances: matching.filter((attempt) => attempt.businessAccepted).length,
        });
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/webhook') {
        json(response, 404, { ok: false });
        return;
      }
      const rawBody = await readBody(request);
      const payload = JSON.parse(rawBody);
      const webhookId = String(request.headers['x-webhook-id'] || '');
      const timestamp = String(request.headers['x-webhook-timestamp'] || '');
      const signature = String(request.headers['x-hub-signature-256'] || '');
      const leadId = String(payload?.lead?.leadId || '');
      const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${webhookId}.${rawBody}`).digest('hex')}`;
      const timestampSeconds = Number(timestamp);
      const signatureValid =
        Boolean(webhookId) &&
        Number.isFinite(timestampSeconds) &&
        Math.abs(Date.now() / 1000 - timestampSeconds) <= 300 &&
        safeEqual(signature, expected);
      if (!signatureValid) {
        json(response, 401, { ok: false });
        return;
      }
      const duplicate = accepted.has(webhookId);
      const businessAccepted = !duplicate;
      if (businessAccepted) accepted.add(webhookId);
      attempts.push({ webhookId, leadId, duplicate, businessAccepted });
      json(response, 200, { ok: true, duplicate });
    } catch {
      json(response, 500, { ok: false });
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function removeTempDirectory(directory) {
  const resolved = path.resolve(directory);
  assert(path.dirname(resolved) === path.resolve(os.tmpdir()), `Refusing to clean non-temp path: ${resolved}`);
  assert(path.basename(resolved).startsWith('mbl-r04-'), `Refusing to clean unexpected temp path: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function main() {
  assert(fs.existsSync(composeFile), 'R04 Compose fixture is missing');
  assert(fs.existsSync(testFile), 'R04 integration test is missing');
  run('docker', ['version']);

  const suffix = randomBytes(4).toString('hex');
  const projectName = `${projectPrefix}${suffix}`;
  const redisVolumeName = `${projectName}_redis-data`;
  const redisPrefix = `${projectName}:lead`;
  const secret = `r04-synthetic-${randomBytes(16).toString('hex')}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-r04-'));
  const redisPort = await reservePort();
  const receiverPort = await reservePort();
  const receiver = await startReceiver({ port: receiverPort, secret });
  const composeEnv = { ...process.env, R04_REDIS_PORT: String(redisPort), R04_REDIS_VOLUME_NAME: redisVolumeName };
  const composeArgs = ['compose', '--project-name', projectName, '-f', composeFile];
  let operationError = null;
  const cleanupErrors = [];
  let composeAttempted = false;

  try {
    assert(projectName.startsWith(projectPrefix), 'Unsafe R04 project name');
    assert(redisVolumeName.startsWith(`${projectName}_`), 'Unsafe R04 volume name');
    composeAttempted = true;
    run('docker', [...composeArgs, 'up', '-d', '--wait'], { env: composeEnv });
    const status = await runStreaming(process.execPath, [vitestCli, 'run', testFile, '--reporter=verbose'], {
      env: {
        ...process.env,
        REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
        CONTACT_REDIS_PREFIX: redisPrefix,
        CONTACT_WEBHOOK_SECRET: secret,
        R04_RECEIVER_BASE_URL: `http://127.0.0.1:${receiverPort}`,
        R04_RECEIVER_TARGET: `http://127.0.0.1:${receiverPort}/webhook`,
      },
    });
    if (status !== 0) throw new Error(`R04 integration suite failed with exit ${status}`);
  } catch (error) {
    operationError = error;
  }

  try {
    await receiver.stop();
  } catch (error) {
    cleanupErrors.push(new Error('R04 receiver cleanup failed', { cause: error }));
  }
  if (composeAttempted) {
    try {
      run('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], { env: composeEnv });
      const volumes = run('docker', ['volume', 'ls', '--format', '{{.Name}}'])
        .stdout.split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean);
      assert(!volumes.includes(redisVolumeName), `R04 Redis volume remains after cleanup: ${redisVolumeName}`);
    } catch (error) {
      cleanupErrors.push(new Error(`R04 Compose cleanup failed for ${projectName}`, { cause: error }));
    }
  }
  try {
    removeTempDirectory(tempRoot);
  } catch (error) {
    cleanupErrors.push(new Error('R04 temporary directory cleanup failed', { cause: error }));
  }

  const failures = [operationError, ...cleanupErrors].filter(Boolean);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'R04 execution and cleanup failures');
  console.log(JSON.stringify({ status: 'PASS', scenarios: ['R04-1', 'R04-2'], projectName, projectCleaned: true }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
