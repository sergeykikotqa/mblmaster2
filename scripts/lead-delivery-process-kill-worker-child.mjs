import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syntheticWebhookUrl = 'https://mbl-test-webhook.invalid/webhook';
const mode = String(process.env.R04_BARRIER_MODE || 'proxy');
const targetUrl = new URL(String(process.env.R04_RECEIVER_TARGET || ''));

assert(['before_post', 'after_accept', 'proxy'].includes(mode), 'Invalid R04 barrier mode');
assert(targetUrl.protocol === 'http:', 'R04 receiver target must use HTTP loopback');
assert(['127.0.0.1', '::1', 'localhost'].includes(targetUrl.hostname), 'R04 receiver target must be loopback');
assert(!targetUrl.username && !targetUrl.password, 'R04 receiver target must not contain credentials');
assert(typeof process.send === 'function', 'R04 worker child requires an IPC channel');

const originalFetch = globalThis.fetch;

function send(message) {
  process.send?.({ ...message, pid: process.pid });
}

async function waitAtBarrier(phase) {
  send({ type: 'barrier', phase });
  await new Promise(() => {});
}

globalThis.fetch = async (input, init) => {
  const requestedUrl = input instanceof Request ? input.url : String(input);
  if (requestedUrl !== syntheticWebhookUrl) return originalFetch(input, init);

  if (mode === 'before_post') await waitAtBarrier('claim_acquired_before_post');

  const response = await originalFetch(targetUrl, { ...init, redirect: 'manual' });
  if (mode === 'after_accept') {
    assert(response.ok, `R04 receiver rejected the synthetic webhook with status ${response.status}`);
    await waitAtBarrier('receiver_accepted_before_redis_commit');
  }
  return response;
};

let viteServer;
try {
  viteServer = await createServer({
    root: repoRoot,
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: {
        '~': path.join(repoRoot, 'src'),
        '@': path.join(repoRoot, 'src'),
      },
    },
    server: { middlewareMode: true },
  });
  const worker = await viteServer.ssrLoadModule('/src/server/leads/worker.ts');
  const result = await worker.processLeadQueue(1);
  send({ type: 'complete', result });
} catch (error) {
  send({ type: 'error', message: error instanceof Error ? error.message : 'unknown worker child error' });
  process.exitCode = 1;
} finally {
  const closeRedis = globalThis[Symbol.for('mbl.redis.close')];
  if (typeof closeRedis === 'function') await closeRedis();
  if (viteServer) await viteServer.close();
}
