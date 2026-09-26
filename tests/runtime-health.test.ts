import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hasRedisConfigMock = vi.hoisted(() => vi.fn());
const redisCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../src/server/redis/client', () => ({
  hasRedisConfig: () => hasRedisConfigMock(),
  redisCommand: (...args: unknown[]) => redisCommandMock(...args),
}));

import { GET as getLive } from '../src/pages/health/live';
import { GET as getReady } from '../src/pages/health/ready';
import { GET as getApiHealth } from '../src/pages/api/health';
import {
  classifyOldestPendingAge,
  classifyWorkerHeartbeat,
  getWorkerRuntimeHealth,
  recordWorkerCycleHeartbeat,
  resolveWorkerRuntimeHealthConfig,
  toWorkerHeartbeatErrorCode,
} from '../src/server/leads/runtime-health';
import { resetRedisReadinessCacheForTests } from '../src/server/health/runtime';

const CONFIG_ENV_KEYS = [
  'CONTACT_REDIS_PREFIX',
  'CONTACT_WORKER_HEARTBEAT_STALE_SEC',
  'CONTACT_QUEUE_OLDEST_NORMAL_SEC',
  'CONTACT_QUEUE_OLDEST_WARNING_SEC',
  'CONTACT_QUEUE_OLDEST_CRITICAL_SEC',
  'REDIS_READINESS_PROBE_KEY_TTL_SEC',
  'REDIS_READINESS_SUCCESS_CACHE_MS',
  'REDIS_READINESS_FAILURE_CACHE_MS',
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  hasRedisConfigMock.mockReset();
  redisCommandMock.mockReset();
  resetRedisReadinessCacheForTests();
  for (const key of CONFIG_ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRedisReadinessCacheForTests();
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

  it('reports readiness only after an exact write/read/delete probe', async () => {
    hasRedisConfigMock.mockReturnValue(true);
    redisCommandMock.mockImplementation(async (...args: unknown[]) => args[4]);

    const response = await getReady();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, status: 'ready' });
    expect(redisCommandMock).toHaveBeenCalledWith(
      'EVAL',
      expect.stringContaining("redis.call('SET'"),
      1,
      expect.stringMatching(/^lead:health:write-read-probe:/),
      expect.stringMatching(/^ready:/),
      15
    );
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

  it('does not accept PING capability as readiness when writes are rejected', async () => {
    hasRedisConfigMock.mockReturnValue(true);
    redisCommandMock.mockImplementation(async (command: string) => {
      if (command === 'PING') return 'PONG';
      throw new Error('REDIS_COMMAND_ERROR');
    });

    const response = await getReady();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, status: 'not_ready' });
    expect(redisCommandMock).toHaveBeenCalledWith(
      'EVAL',
      expect.any(String),
      1,
      expect.stringMatching(/:health:write-read-probe:/),
      expect.any(String),
      15
    );
    expect(redisCommandMock).not.toHaveBeenCalledWith('PING');
  });

  it('marks diagnostic API health as Redis-degraded when the write probe fails', async () => {
    hasRedisConfigMock.mockReturnValue(true);
    redisCommandMock.mockRejectedValue(new Error('REDIS_COMMAND_ERROR'));

    const response = await getApiHealth({ request: new Request('http://local.test/api/health') });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.redis).toMatchObject({
      configured: true,
      ok: false,
      code: 'REDIS_WRITE_READ_FAILED',
      degraded: true,
    });
  });

  it('fails readiness when Redis accepts the command but read-back does not match', async () => {
    hasRedisConfigMock.mockReturnValue(true);
    redisCommandMock.mockResolvedValue('unexpected-value');

    const response = await getReady();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, status: 'not_ready' });
  });

  it('caches failures briefly and observes recovery without restarting the process', async () => {
    hasRedisConfigMock.mockReturnValue(true);
    let nowMs = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    redisCommandMock
      .mockRejectedValueOnce(new Error('REDIS_TIMEOUT'))
      .mockImplementation(async (...args: unknown[]) => args[4]);

    expect((await getReady()).status).toBe(503);
    expect((await getReady()).status).toBe(503);
    expect(redisCommandMock).toHaveBeenCalledTimes(1);

    nowMs += 1_001;
    expect((await getReady()).status).toBe(200);
    expect(redisCommandMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces parallel readiness calls into one Redis probe', async () => {
    hasRedisConfigMock.mockReturnValue(true);
    let complete: ((value: string) => void) | undefined;
    let expected = '';
    redisCommandMock.mockImplementation(
      (...args: unknown[]) =>
        new Promise<string>((resolve) => {
          expected = String(args[4]);
          complete = resolve;
        })
    );

    const requests = [getReady(), getReady(), getReady()];
    await vi.waitFor(() => expect(redisCommandMock).toHaveBeenCalledTimes(1));
    complete?.(expected);
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(redisCommandMock).toHaveBeenCalledTimes(1);
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
    redisCommandMock.mockImplementation(async (command: string, ...args: unknown[]) => {
      if (command === 'EVAL') return args[3];
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
