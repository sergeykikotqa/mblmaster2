import { randomUUID } from 'node:crypto';

import { resolveLeadRedisPrefix } from '~/server/leads/store';
import { hasRedisConfig, redisCommand } from '~/server/redis/client';

export type RedisReadiness = {
  ok: boolean;
};

const REDIS_WRITE_READ_PROBE_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
local value = redis.call('GET', KEYS[1])
redis.call('DEL', KEYS[1])
return value
`;
const DEFAULT_PROBE_KEY_TTL_SEC = 15;
const DEFAULT_SUCCESS_CACHE_MS = 5_000;
const DEFAULT_FAILURE_CACHE_MS = 1_000;

let cachedReadiness: { value: RedisReadiness; expiresAtMs: number } | null = null;
let readinessInFlight: Promise<RedisReadiness> | null = null;

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function readinessConfig() {
  return {
    probeKeyTtlSec: boundedInt(process.env.REDIS_READINESS_PROBE_KEY_TTL_SEC, DEFAULT_PROBE_KEY_TTL_SEC, 5, 60),
    successCacheMs: boundedInt(process.env.REDIS_READINESS_SUCCESS_CACHE_MS, DEFAULT_SUCCESS_CACHE_MS, 250, 60_000),
    failureCacheMs: boundedInt(process.env.REDIS_READINESS_FAILURE_CACHE_MS, DEFAULT_FAILURE_CACHE_MS, 250, 10_000),
  };
}

async function executeRedisWriteReadProbe(): Promise<RedisReadiness> {
  if (!hasRedisConfig()) return { ok: false };

  const config = readinessConfig();
  const probeId = randomUUID();
  const key = `${resolveLeadRedisPrefix()}:health:write-read-probe:${probeId}`;
  const expected = `ready:${probeId}`;

  try {
    const actual = await redisCommand<string>(
      'EVAL',
      REDIS_WRITE_READ_PROBE_SCRIPT,
      1,
      key,
      expected,
      config.probeKeyTtlSec
    );
    return { ok: actual === expected };
  } catch {
    return { ok: false };
  }
}

export async function probeRedisReadiness(): Promise<RedisReadiness> {
  const nowMs = Date.now();
  if (cachedReadiness && cachedReadiness.expiresAtMs > nowMs) return cachedReadiness.value;
  if (readinessInFlight) return readinessInFlight;

  readinessInFlight = executeRedisWriteReadProbe().then((value) => {
    const config = readinessConfig();
    cachedReadiness = {
      value,
      expiresAtMs: Date.now() + (value.ok ? config.successCacheMs : config.failureCacheMs),
    };
    return value;
  });

  try {
    return await readinessInFlight;
  } finally {
    readinessInFlight = null;
  }
}

export function resetRedisReadinessCacheForTests(): void {
  cachedReadiness = null;
  readinessInFlight = null;
}

export function createHealthResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
