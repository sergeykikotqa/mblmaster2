import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasRedisConfig: vi.fn(),
  redisCommand: vi.fn(),
  assertMemoryFallbackAllowed: vi.fn(),
}));

vi.mock('~/server/redis/client', () => ({
  hasRedisConfig: mocks.hasRedisConfig,
  redisCommand: mocks.redisCommand,
  assertMemoryFallbackAllowed: mocks.assertMemoryFallbackAllowed,
}));

import { getHealthStateStoreRuntimeStats, probeHealthStateStoreAvailability } from '../src/server/metrics/state-store';

describe('health state-store read-only availability probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasRedisConfig.mockReturnValue(true);
    mocks.redisCommand.mockResolvedValueOnce('hash').mockResolvedValueOnce('stream');
    mocks.assertMemoryFallbackAllowed.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('checks only Redis key types without reading or changing legacy payloads', async () => {
    const result = await probeHealthStateStoreAvailability();

    expect(result).toEqual({
      value: { available: true, legacyPayloadRead: false },
      dataSource: 'redis',
      degraded: false,
    });
    expect(mocks.redisCommand).toHaveBeenCalledTimes(2);
    expect(mocks.redisCommand.mock.calls.map(([command]) => command)).toEqual(['TYPE', 'TYPE']);
    expect(mocks.redisCommand.mock.calls.flat()).not.toEqual(
      expect.arrayContaining(['GET', 'HGET', 'HGETALL', 'SET', 'HSET', 'DEL', 'XADD', 'XREVRANGE'])
    );
  });

  test('accepts absent state keys without creating them', async () => {
    mocks.redisCommand.mockReset();
    mocks.redisCommand.mockResolvedValueOnce('none').mockResolvedValueOnce('none');

    await expect(probeHealthStateStoreAvailability()).resolves.toMatchObject({
      dataSource: 'redis',
      degraded: false,
      value: { available: true, legacyPayloadRead: false },
    });
    expect(mocks.redisCommand.mock.calls.map(([command]) => command)).toEqual(['TYPE', 'TYPE']);
  });

  test('reports an allowed memory fallback and increments technical diagnostics', async () => {
    const before = getHealthStateStoreRuntimeStats().redisFallbackToMemoryCount;
    mocks.redisCommand.mockReset();
    mocks.redisCommand.mockRejectedValueOnce(new Error('REDIS_NETWORK_ERROR')).mockResolvedValueOnce('stream');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await probeHealthStateStoreAvailability();
    const after = getHealthStateStoreRuntimeStats().redisFallbackToMemoryCount;

    expect(result).toEqual({
      value: { available: true, legacyPayloadRead: false },
      dataSource: 'memory',
      degraded: true,
    });
    expect(after).toBe(before + 1);
  });

  test('keeps a Redis failure fail-closed when memory fallback is forbidden', async () => {
    mocks.redisCommand.mockReset();
    mocks.redisCommand.mockRejectedValueOnce(new Error('REDIS_NETWORK_ERROR')).mockResolvedValueOnce('stream');
    mocks.assertMemoryFallbackAllowed.mockImplementation((error?: unknown) => {
      throw error instanceof Error ? error : new Error('REDIS_FALLBACK_FORBIDDEN');
    });

    await expect(probeHealthStateStoreAvailability()).rejects.toThrow('REDIS_NETWORK_ERROR');
  });
});
