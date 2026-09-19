import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hasRedisConfigMock = vi.hoisted(() => vi.fn());
const redisCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../src/server/redis/client', () => ({
  hasRedisConfig: () => hasRedisConfigMock(),
  redisCommand: (...args: unknown[]) => redisCommandMock(...args),
}));

import { GET as getLive } from '../src/pages/health/live';
import { GET as getReady } from '../src/pages/health/ready';
import {
  classifyOldestPendingAge,
  classifyWorkerHeartbeat,
  getWorkerRuntimeHealth,
  recordWorkerCycleHeartbeat,
  resolveWorkerRuntimeHealthConfig,
  toWorkerHeartbeatErrorCode,
} from '../src/server/leads/runtime-health';

const CONFIG_ENV_KEYS = [
  'CONTACT_REDIS_PREFIX',
  'CONTACT_WORKER_HEARTBEAT_STALE_SEC',
  'CONTACT_QUEUE_OLDEST_NORMAL_SEC',
  'CONTACT_QUEUE_OLDEST_WARNING_SEC',
  'CONTACT_QUEUE_OLDEST_CRITICAL_SEC',
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  hasRedisConfigMock.mockReset();
  redisCommandMock.mockReset();
  for (const key of CONFIG_ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('public process health endpoints', () => {
  it('keeps liveness cheap and independent of Redis', async () => {
    const response = getLive();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, status: 'live' });
    expect(redisCommandMock).not.toHaveBeenCalled();
  });

  it('reports readiness only when Redis answers PONG', async () => {
    hasRedisConfigMock.mockReturnValue(true);
    redisCommandMock.mockResolvedValue('PONG');

    const response = await getReady();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, status: 'ready' });
    expect(redisCommandMock).toHaveBeenCalledWith('PING');
  });

  it('fails readiness closed without exposing Redis errors or configuration', async () => {
    hasRedisConfigMock.mockReturnValue(true);
    redisCommandMock.mockRejectedValue(new Error('redis://user:secret@internal:6379'));

    const response = await getReady();
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ ok: false, status: 'not_ready' });
    expect(text).not.toContain('secret');
    expect(text).not.toContain('internal');
  });
});

describe('worker runtime health', () => {
  it('uses ordered configurable heartbeat and queue-age thresholds', () => {
    process.env.CONTACT_WORKER_HEARTBEAT_STALE_SEC = '45';
    process.env.CONTACT_QUEUE_OLDEST_NORMAL_SEC = '60';
    process.env.CONTACT_QUEUE_OLDEST_WARNING_SEC = '120';
    process.env.CONTACT_QUEUE_OLDEST_CRITICAL_SEC = '600';
    const config = resolveWorkerRuntimeHealthConfig();

    expect(config).toEqual({
      heartbeatStaleMs: 45_000,
      oldestPendingNormalMs: 60_000,
      oldestPendingWarningMs: 120_000,
      oldestPendingCriticalMs: 600_000,
    });
    expect(classifyOldestPendingAge(null, config)).toBe('empty');
    expect(classifyOldestPendingAge(59_999, config)).toBe('normal');
    expect(classifyOldestPendingAge(60_000, config)).toBe('elevated');
    expect(classifyOldestPendingAge(120_000, config)).toBe('warning');
    expect(classifyOldestPendingAge(600_000, config)).toBe('critical');
  });

  it('classifies fresh, stale, missing and unavailable worker cycles', () => {
    const nowMs = Date.parse('2026-09-15T00:01:00.000Z');
    const heartbeat = {
      lastCycleAt: '2026-09-15T00:00:30.000Z',
      status: 'ok' as const,
      processed: 0,
      delivered: 0,
      error: '',
    };

    expect(classifyWorkerHeartbeat(heartbeat, nowMs, 60_000)).toEqual({ state: 'cycling', ageMs: 30_000 });
    expect(classifyWorkerHeartbeat(heartbeat, nowMs + 31_000, 60_000)).toEqual({
      state: 'stale',
      ageMs: 61_000,
    });
    expect(classifyWorkerHeartbeat(null, nowMs, 60_000)).toEqual({ state: 'missing', ageMs: null });
    expect(classifyWorkerHeartbeat(heartbeat, nowMs, 60_000, false)).toEqual({
      state: 'unavailable',
      ageMs: null,
    });
  });

  it('writes the required heartbeat fields under the lead Redis namespace', async () => {
    hasRedisConfigMock.mockReturnValue(true);
    redisCommandMock.mockResolvedValue(5);
    process.env.CONTACT_REDIS_PREFIX = 'health-test';

    await expect(
      recordWorkerCycleHeartbeat({
        status: 'ok',
        processed: 3,
        delivered: 2,
        lastCycleAtMs: Date.parse('2026-09-15T00:00:00.000Z'),
      })
    ).resolves.toBe(true);

    expect(redisCommandMock).toHaveBeenCalledWith(
      'HSET',
      'health-test:worker:heartbeat',
      'lastCycleAt',
      '2026-09-15T00:00:00.000Z',
      'status',
      'ok',
      'processed',
      3,
      'delivered',
      2,
      'error',
      ''
    );
  });

  it('returns fresh heartbeat data and warning age for the oldest pending lead', async () => {
    const nowMs = Date.parse('2026-09-15T00:10:00.000Z');
    hasRedisConfigMock.mockReturnValue(true);
    redisCommandMock.mockImplementation(async (command: string) => {
      if (command === 'PING') return 'PONG';
      if (command === 'HGETALL') {
        return [
          'lastCycleAt',
          '2026-09-15T00:09:50.000Z',
          'status',
          'ok',
          'processed',
          '4',
          'delivered',
          '3',
          'error',
          '',
        ];
      }
      if (command === 'ZRANGE') return ['lead-1', String(nowMs - 180_000)];
      throw new Error('unexpected command');
    });

    const runtime = await getWorkerRuntimeHealth(nowMs);

    expect(runtime.redisLive).toBe(true);
    expect(runtime.heartbeat).toMatchObject({ state: 'cycling', ageMs: 10_000 });
    expect(runtime.heartbeat.value).toMatchObject({ status: 'ok', processed: 4, delivered: 3, error: '' });
    expect(runtime.oldestPending).toMatchObject({ ageMs: 180_000, state: 'warning' });
    expect(runtime.ok).toBe(false);
  });

  it('reports Redis and heartbeat unavailable when Redis is not configured', async () => {
    hasRedisConfigMock.mockReturnValue(false);

    const runtime = await getWorkerRuntimeHealth();

    expect(runtime).toMatchObject({
      ok: false,
      redisLive: false,
      heartbeat: { state: 'unavailable', value: null },
      oldestPending: { state: 'empty', ageMs: null },
    });
    expect(redisCommandMock).not.toHaveBeenCalled();
  });

  it('keeps arbitrary exception text out of the persisted heartbeat', () => {
    expect(toWorkerHeartbeatErrorCode(new Error('request failed for https://secret.example/token'))).toBe(
      'WORKER_CYCLE_ERROR'
    );
    expect(toWorkerHeartbeatErrorCode(new Error('REDIS_NETWORK_ERROR'))).toBe('REDIS_NETWORK_ERROR');
  });
});
