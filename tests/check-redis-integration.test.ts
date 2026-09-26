import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { runRedisIntegrationGate } from '../scripts/check-redis-integration.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const integrationTestPath = 'tests/redis-lead-store.integration.test.ts';
const vitestCliPath = path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs');

type GateSpawnSync = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' }
) => { status: number | null; signal: NodeJS.Signals | null; error?: Error };

function captureStderr() {
  let value = '';
  return {
    stream: { write: (chunk: string) => ((value += chunk), true) },
    read: () => value,
  };
}

describe('Redis integration gate wrapper', () => {
  test('fails before spawning when REDIS_URL is missing', () => {
    const spawnSyncImpl = vi.fn<GateSpawnSync>();
    const stderr = captureStderr();

    expect(runRedisIntegrationGate({ env: {}, spawnSyncImpl, stderr: stderr.stream })).toBe(1);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(stderr.read()).toContain('REDIS_URL is required');
    expect(stderr.read()).toContain('PowerShell:');
    expect(stderr.read()).toContain('Linux/macOS:');
  });

  test('rejects non-loopback and non-dedicated Redis URLs before spawning', () => {
    for (const redisUrl of ['redis://redis.example.test:6379/14', 'redis://127.0.0.1:6379/0']) {
      const spawnSyncImpl = vi.fn<GateSpawnSync>();
      const stderr = captureStderr();

      expect(runRedisIntegrationGate({ env: { REDIS_URL: redisUrl }, spawnSyncImpl, stderr: stderr.stream })).toBe(1);
      expect(spawnSyncImpl).not.toHaveBeenCalled();
    }
  });

  test('runs the exact integration file with enforced child environment', () => {
    const spawnSyncImpl = vi.fn<GateSpawnSync>(() => ({ status: 0, signal: null }));
    const redisUrl = 'redis://127.0.0.1:6379/14';

    expect(
      runRedisIntegrationGate({
        env: { REDIS_URL: redisUrl, REDIS_INTEGRATION: '0', PRESERVED_VALUE: 'yes' },
        spawnSyncImpl,
      })
    ).toBe(0);

    expect(spawnSyncImpl).toHaveBeenCalledOnce();
    const [command, args, options] = spawnSyncImpl.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([vitestCliPath, 'run', integrationTestPath, '--reporter=verbose']);
    expect(options).toMatchObject({ cwd: projectRoot, stdio: 'inherit' });
    expect(options.env).toMatchObject({
      REDIS_INTEGRATION: '1',
      REDIS_URL: redisUrl,
      PRESERVED_VALUE: 'yes',
    });
  });

  test('propagates a nonzero child exit code', () => {
    const spawnSyncImpl = vi.fn<GateSpawnSync>(() => ({ status: 7, signal: null }));

    expect(
      runRedisIntegrationGate({
        env: { REDIS_URL: 'redis://localhost:6379/14' },
        spawnSyncImpl,
      })
    ).toBe(7);
  });

  test('explicit integration mode without REDIS_URL cannot silently skip', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, REDIS_INTEGRATION: '1' };
    delete env.REDIS_URL;

    const result = spawnSync(process.execPath, [vitestCliPath, 'run', integrationTestPath, '--reporter=verbose'], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('REDIS_INTEGRATION=1 requires a non-empty REDIS_URL');
    expect(output).not.toContain('Tests  10 skipped');
  });
});
