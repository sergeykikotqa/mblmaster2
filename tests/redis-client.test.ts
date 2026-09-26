import { afterEach, describe, expect, test } from 'vitest';

import { hasRedisConfig, parseRedisUrl, redisCommand } from '../src/server/redis/client';

const originalRedisUrl = process.env.REDIS_URL;

afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describe('native Redis configuration', () => {
  test('accepts redis/rediss URLs and rejects unsafe shapes', () => {
    expect(parseRedisUrl('redis://127.0.0.1:6379/0')?.protocol).toBe('redis:');
    expect(parseRedisUrl('rediss://user:password@redis.internal:6380/2')?.protocol).toBe('rediss:');
    expect(parseRedisUrl('https://redis.internal')).toBeNull();
    expect(parseRedisUrl('redis://redis.internal/not-a-db')).toBeNull();
    expect(parseRedisUrl('redis://redis.internal/0?token=secret')).toBeNull();
  });

  test('invalid or absent configuration fails without leaking URL credentials', async () => {
    process.env.REDIS_URL = 'redis://user:super-secret@example.invalid/not-a-db';
    expect(hasRedisConfig()).toBe(false);
    await expect(redisCommand('PING')).rejects.toThrow('REDIS_NOT_CONFIGURED');
    await expect(redisCommand('PING')).rejects.not.toThrow(/super-secret|example\.invalid/);
  });
});
