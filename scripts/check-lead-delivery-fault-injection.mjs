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
const composeFile = path.join(repoRoot, 'tests', 'fixtures', 'lead-delivery-fault-injection.compose.yml');
const testFile = path.join(repoRoot, 'tests', 'lead-delivery-fault-injection.integration.test.ts');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const syntheticWebhookUrl = 'https://mbl-test-webhook.invalid/webhook';
const projectPrefix = 'mbl-r03-';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object', 'Unable to reserve a loopback port');
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe',
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
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: options.env || process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} was terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function formatErrorDetails(error, indent = '') {
  if (!(error instanceof Error)) return `${indent}Unknown non-Error failure`;

  const lines = [`${indent}${error.name}: ${error.message}`];
  if (error instanceof AggregateError) {
    error.errors.forEach((nestedError, index) => {
      lines.push(`${indent}  Error ${index + 1}:`);
      lines.push(formatErrorDetails(nestedError, `${indent}    `));
    });
  }
  if (error.cause !== undefined) {
    lines.push(`${indent}  Caused by:`);
    lines.push(formatErrorDetails(error.cause, `${indent}    `));
  }
  return lines.join('\n');
}

function safeEqual(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readRequestBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    total += value.byteLength;
    if (total > maxBytes) throw new Error('R03 receiver body exceeded the test limit');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

async function startReceiver({ port, secret }) {
  const attempts = [];
  const acceptedIds = new Set();
  const recoveredIds = new Set();
  const releaseBarriers = new Map();
  const sockets = new Set();

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && requestUrl.pathname === '/stats') {
        const leadId = requestUrl.searchParams.get('leadId') || '';
        const matching = attempts.filter((attempt) => !leadId || attempt.leadId === leadId);
        writeJson(response, 200, {
          attempts: matching,
          actualAcceptances: matching.filter((attempt) => attempt.businessAccepted).length,
        });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/control/release') {
        const body = JSON.parse(await readRequestBody(request));
        const webhookId = String(body?.webhookId || '');
        const release = releaseBarriers.get(webhookId);
        if (!release) {
          writeJson(response, 409, { ok: false, code: 'BARRIER_NOT_WAITING' });
          return;
        }
        releaseBarriers.delete(webhookId);
        release();
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/control/recover') {
        const body = JSON.parse(await readRequestBody(request));
        const webhookId = String(body?.webhookId || '');
        recoveredIds.add(webhookId);
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method !== 'POST' || requestUrl.pathname !== '/webhook') {
        writeJson(response, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }

      const rawBody = await readRequestBody(request);
      const payload = JSON.parse(rawBody);
      const webhookId = String(request.headers['x-webhook-id'] || '');
      const timestamp = String(request.headers['x-webhook-timestamp'] || '');
      const signature = String(request.headers['x-hub-signature-256'] || '');
      const leadId = String(payload?.lead?.leadId || '');
      const message = String(payload?.lead?.message || '');
      const timestampSeconds = Number(timestamp);
      const timestampFresh = Number.isFinite(timestampSeconds) && Math.abs(Date.now() / 1000 - timestampSeconds) <= 300;
      const expectedSignature = `sha256=${createHmac('sha256', secret)
        .update(`${timestamp}.${webhookId}.${rawBody}`)
        .digest('hex')}`;
      const signatureValid = Boolean(webhookId && timestampFresh && safeEqual(signature, expectedSignature));
      const attemptNumber = attempts.filter((attempt) => attempt.webhookId === webhookId).length + 1;

      let status = 200;
      if (message.includes('[r03-dlq]') && !recoveredIds.has(webhookId)) status = 503;
      const duplicate = acceptedIds.has(webhookId);
      const businessAccepted = status >= 200 && status < 300 && signatureValid && !duplicate;
      if (businessAccepted) acceptedIds.add(webhookId);
      attempts.push({
        webhookId,
        leadId,
        attemptNumber,
        duplicate,
        businessAccepted,
        status,
        signatureValid,
        timestampFresh,
      });

      if (!signatureValid) {
        writeJson(response, 401, { ok: false, code: 'INVALID_SIGNATURE' });
        return;
      }

      if (message.includes('[r03-lost-ack]') && attemptNumber === 1) {
        await new Promise((resolve) => setTimeout(resolve, 1800));
      }

      if ((message.includes('[r03-claim-barrier]') || message.includes('[r03-lock-renewal]')) && attemptNumber === 1) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            releaseBarriers.delete(webhookId);
            reject(new Error('R03 claim barrier timed out'));
          }, 10_000);
          releaseBarriers.set(webhookId, () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }

      writeJson(response, status, { ok: status >= 200 && status < 300, duplicate });
    } catch (error) {
      writeJson(response, 500, { ok: false, code: error instanceof Error ? error.message : 'R03_RECEIVER_ERROR' });
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
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function removeTempDirectory(tempRoot) {
  const resolved = path.resolve(tempRoot);
  assert(path.dirname(resolved) === path.resolve(os.tmpdir()), `Refusing to clean non-temp path: ${resolved}`);
  assert(path.basename(resolved).startsWith('mbl-r03-'), `Refusing to clean unexpected temp path: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function main() {
  assert(fs.existsSync(composeFile), 'R03 Compose fixture is missing');
  assert(fs.existsSync(testFile), 'R03 integration test is missing');
  assert(fs.existsSync(vitestCli), 'Vitest CLI is unavailable; run npm ci first');
  run('docker', ['version']);

  const suffix = randomBytes(4).toString('hex');
  const projectName = `${projectPrefix}${suffix}`;
  const redisVolumeName = `${projectName}_redis-data`;
  const redisPrefix = `${projectName}:lead`;
  const webhookSecret = `r03-synthetic-${randomBytes(16).toString('hex')}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-r03-'));
  const redisPort = await reservePort();
  const receiverPort = await reservePort();
  const receiver = await startReceiver({ port: receiverPort, secret: webhookSecret });
  const composeEnv = {
    ...process.env,
    R03_REDIS_PORT: String(redisPort),
    R03_REDIS_VOLUME_NAME: redisVolumeName,
  };
  const composeArgs = ['compose', '--project-name', projectName, '-f', composeFile];
  let composeAttempted = false;
  let testStatus = 1;
  let operationError = null;
  let projectCleaned = false;
  let redisVolumeCleaned = false;

  try {
    assert(projectName.startsWith(projectPrefix), 'Unsafe R03 project name');
    assert(redisVolumeName.startsWith(`${projectName}_`), 'Unsafe R03 volume name');
    composeAttempted = true;
    run('docker', [...composeArgs, 'up', '-d', '--wait'], { env: composeEnv });

    const testEnv = {
      ...process.env,
      REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
      CONTACT_REDIS_PREFIX: redisPrefix,
      CONTACT_WEBHOOK_URL: syntheticWebhookUrl,
      CONTACT_WEBHOOK_SECRET: webhookSecret,
      CONTACT_WEBHOOK_TIMEOUT_MS: '1000',
      CONTACT_DELIVERY_MAX_RETRIES: '2',
      CONTACT_RETRY_BASE_DELAY_SEC: '1',
      CONTACT_WORKER_PROCESSING_LOCK_TTL_SEC: '5',
      CONTACT_WORKER_DELIVERY_CLAIM_TTL_SEC: '5',
      CONTACT_ALERT_WEBHOOK_URL: '',
      CONTACT_ALERT_WEBHOOK_URL_SECONDARY: '',
      MBL_TEST_WEBHOOK_HTTPS_URL: syntheticWebhookUrl,
      MBL_TEST_WEBHOOK_HTTP_TARGET: `http://127.0.0.1:${receiverPort}/webhook`,
      R03_RECEIVER_BASE_URL: `http://127.0.0.1:${receiverPort}`,
      R03_AUDIT_LOG_PATH: path.join(tempRoot, 'dlq-replay-audit.log'),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require=./scripts/test-webhook-fetch-proxy.cjs']
        .filter(Boolean)
        .join(' '),
    };
    testStatus = await runStreaming(process.execPath, [vitestCli, 'run', testFile, '--reporter=verbose'], {
      env: testEnv,
    });
    if (testStatus !== 0) throw new Error(`R03 integration suite failed with exit ${testStatus}`);
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = [];
  try {
    await receiver.stop();
  } catch (error) {
    cleanupErrors.push(new Error('R03 receiver cleanup failed', { cause: error }));
  }

  if (composeAttempted) {
    try {
      run('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], { env: composeEnv });
      const remainingVolumes = run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
      const remainingVolumeNames = remainingVolumes.stdout
        .split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean);
      assert(
        !remainingVolumeNames.includes(redisVolumeName),
        `R03 Redis volume remains after cleanup: ${redisVolumeName}`
      );
      projectCleaned = true;
      redisVolumeCleaned = true;
    } catch (error) {
      cleanupErrors.push(new Error(`R03 Compose cleanup failed for ${projectName}`, { cause: error }));
    }
  }

  try {
    removeTempDirectory(tempRoot);
  } catch (error) {
    cleanupErrors.push(new Error('R03 temporary directory cleanup failed', { cause: error }));
  }

  const failures = [operationError, ...cleanupErrors].filter((error) => error !== null);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'R03 execution failed and one or more cleanup operations also failed');
  }

  console.log(
    JSON.stringify(
      {
        status: testStatus === 0 ? 'PASS' : 'FAIL',
        scenarios: ['R02-2A', 'R02-2B', 'R02-6', 'R03-3-live-lock-renewal'],
        projectCleaned,
        redisVolumeCleaned,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(formatErrorDetails(error));
  process.exitCode = 1;
});
