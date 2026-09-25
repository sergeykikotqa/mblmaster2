import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const vitestCliPath = path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs');
const integrationTestPath = 'tests/redis-lead-store.integration.test.ts';
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * @typedef {{ status: number | null, signal: NodeJS.Signals | null, error?: Error }} GateChildResult
 * @typedef {(command: string, args: string[], options: {
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   stdio: 'inherit'
 * }) => GateChildResult} GateSpawnSync
 * @typedef {{ write: (chunk: string) => unknown }} GateErrorWriter
 */

function usage() {
  return [
    'REDIS_URL is required for the Redis lead integration gate.',
    "PowerShell: $env:REDIS_URL='redis://127.0.0.1:6379/14'; npm run check:redis-integration",
    "Linux/macOS: REDIS_URL='redis://127.0.0.1:6379/14' npm run check:redis-integration",
    'Use a dedicated loopback Redis database; production or shared Redis endpoints are not allowed.',
  ].join('\n');
}

export function resolveRedisIntegrationUrl(env = process.env) {
  const rawUrl = String(env.REDIS_URL || '').trim();
  if (!rawUrl) throw new Error(usage());

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`REDIS_URL must be a valid Redis URL.\n${usage()}`);
  }

  if (!['redis:', 'rediss:'].includes(parsed.protocol)) {
    throw new Error(`REDIS_URL must use redis:// or rediss://.\n${usage()}`);
  }
  if (!loopbackHosts.has(parsed.hostname)) {
    throw new Error(`REDIS_URL must target loopback only.\n${usage()}`);
  }
  if (!/^\/(?:[1-9]|1[0-5])$/.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error(`REDIS_URL must select a dedicated database from /1 through /15.\n${usage()}`);
  }

  return rawUrl;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   spawnSyncImpl?: GateSpawnSync,
 *   stderr?: GateErrorWriter
 * }} [options]
 */
export function runRedisIntegrationGate({
  env = process.env,
  spawnSyncImpl = spawnSync,
  stderr = process.stderr,
} = {}) {
  let redisUrl;
  try {
    redisUrl = resolveRedisIntegrationUrl(env);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const result = spawnSyncImpl(process.execPath, [vitestCliPath, 'run', integrationTestPath, '--reporter=verbose'], {
    cwd: projectRoot,
    env: {
      ...env,
      REDIS_INTEGRATION: '1',
      REDIS_URL: redisUrl,
    },
    stdio: 'inherit',
  });

  if (result.error) {
    stderr.write(`Unable to launch Redis integration suite: ${result.error.message}\n`);
    return 1;
  }
  if (typeof result.status === 'number') return result.status;

  stderr.write(`Redis integration suite ended without an exit code${result.signal ? ` (${result.signal})` : ''}.\n`);
  return 1;
}

const isDirectRun = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) process.exitCode = runRedisIntegrationGate();
