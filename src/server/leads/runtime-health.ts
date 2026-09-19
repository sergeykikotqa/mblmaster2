import { probeRedisReadiness } from '~/server/health/runtime';
import { hasRedisConfig, redisCommand } from '~/server/redis/client';

import { resolveLeadRedisPrefix } from './store';

const DEFAULT_WORKER_HEARTBEAT_STALE_SEC = 60;
const DEFAULT_QUEUE_OLDEST_NORMAL_SEC = 60;
const DEFAULT_QUEUE_OLDEST_WARNING_SEC = 120;
const DEFAULT_QUEUE_OLDEST_CRITICAL_SEC = 600;
const MAX_HEARTBEAT_ERROR_LENGTH = 80;

export type WorkerCycleStatus = 'ok' | 'paused' | 'error';
export type WorkerHeartbeatState = 'cycling' | 'stale' | 'missing' | 'unavailable';
export type OldestPendingState = 'empty' | 'normal' | 'elevated' | 'warning' | 'critical';

export type WorkerHeartbeat = {
  lastCycleAt: string;
  status: WorkerCycleStatus;
  processed: number;
  delivered: number;
  error: string;
};

export type WorkerRuntimeHealthConfig = {
  heartbeatStaleMs: number;
  oldestPendingNormalMs: number;
  oldestPendingWarningMs: number;
  oldestPendingCriticalMs: number;
};

export type WorkerRuntimeHealth = {
  ok: boolean;
  redisLive: boolean;
  heartbeat: {
    state: WorkerHeartbeatState;
    ageMs: number | null;
    staleAfterMs: number;
    value: WorkerHeartbeat | null;
  };
  oldestPending: {
    ageMs: number | null;
    state: OldestPendingState;
    thresholdsMs: {
      normal: number;
      warning: number;
      critical: number;
    };
  };
};

export type RecordWorkerCycleHeartbeatInput = {
  status: WorkerCycleStatus;
  processed: number;
  delivered: number;
  error?: unknown;
  lastCycleAtMs?: number;
};

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function secondsToMs(seconds: number): number {
  return seconds * 1000;
}

export function resolveWorkerRuntimeHealthConfig(): WorkerRuntimeHealthConfig {
  const heartbeatStaleSec = parsePositiveInt(
    process.env.CONTACT_WORKER_HEARTBEAT_STALE_SEC,
    DEFAULT_WORKER_HEARTBEAT_STALE_SEC,
    1
  );
  const oldestPendingNormalSec = parsePositiveInt(
    process.env.CONTACT_QUEUE_OLDEST_NORMAL_SEC,
    DEFAULT_QUEUE_OLDEST_NORMAL_SEC,
    1
  );
  const oldestPendingWarningSec = Math.max(
    oldestPendingNormalSec + 1,
    parsePositiveInt(
      process.env.CONTACT_QUEUE_OLDEST_WARNING_SEC,
      DEFAULT_QUEUE_OLDEST_WARNING_SEC,
      oldestPendingNormalSec + 1
    )
  );
  const oldestPendingCriticalSec = Math.max(
    oldestPendingWarningSec + 1,
    parsePositiveInt(
      process.env.CONTACT_QUEUE_OLDEST_CRITICAL_SEC,
      DEFAULT_QUEUE_OLDEST_CRITICAL_SEC,
      oldestPendingWarningSec + 1
    )
  );

  return {
    heartbeatStaleMs: secondsToMs(heartbeatStaleSec),
    oldestPendingNormalMs: secondsToMs(oldestPendingNormalSec),
    oldestPendingWarningMs: secondsToMs(oldestPendingWarningSec),
    oldestPendingCriticalMs: secondsToMs(oldestPendingCriticalSec),
  };
}

function workerHeartbeatKey(): string {
  return `${resolveLeadRedisPrefix()}:worker:heartbeat`;
}

function leadPendingSinceKey(): string {
  return `${resolveLeadRedisPrefix()}:delivery:pending-since`;
}

function clampCounter(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function toWorkerHeartbeatErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  const normalized = raw.trim().toUpperCase();
  if (/^[A-Z][A-Z0-9_:-]{0,79}$/.test(normalized)) return normalized;
  return 'WORKER_CYCLE_ERROR';
}

export function classifyWorkerHeartbeat(
  heartbeat: WorkerHeartbeat | null,
  nowMs: number,
  staleAfterMs: number,
  redisLive = true
): { state: WorkerHeartbeatState; ageMs: number | null } {
  if (!redisLive) return { state: 'unavailable', ageMs: null };
  if (!heartbeat) return { state: 'missing', ageMs: null };

  const lastCycleAtMs = Date.parse(heartbeat.lastCycleAt);
  if (!Number.isFinite(lastCycleAtMs)) return { state: 'missing', ageMs: null };
  const ageMs = Math.max(0, nowMs - lastCycleAtMs);
  return {
    state: ageMs > staleAfterMs ? 'stale' : 'cycling',
    ageMs,
  };
}

export function classifyOldestPendingAge(ageMs: number | null, config: WorkerRuntimeHealthConfig): OldestPendingState {
  if (ageMs === null) return 'empty';
  if (ageMs < config.oldestPendingNormalMs) return 'normal';
  if (ageMs < config.oldestPendingWarningMs) return 'elevated';
  if (ageMs < config.oldestPendingCriticalMs) return 'warning';
  return 'critical';
}

function parseHeartbeat(raw: unknown): WorkerHeartbeat | null {
  const fields = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      fields.set(String(raw[index]), String(raw[index + 1]));
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      fields.set(key, String(value));
    }
  }

  const lastCycleAt = String(fields.get('lastCycleAt') || '').trim();
  const rawStatus = String(fields.get('status') || '').trim();
  if (!lastCycleAt || !['ok', 'paused', 'error'].includes(rawStatus)) return null;
  const rawError = String(fields.get('error') || '').trim();

  return {
    lastCycleAt,
    status: rawStatus as WorkerCycleStatus,
    processed: clampCounter(fields.get('processed')),
    delivered: clampCounter(fields.get('delivered')),
    error: rawError ? toWorkerHeartbeatErrorCode(rawError).slice(0, MAX_HEARTBEAT_ERROR_LENGTH) : '',
  };
}

function parseOldestPendingAtMs(raw: unknown): number | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const value = Number(raw[1]);
  return Number.isFinite(value) ? Math.floor(value) : null;
}

export async function recordWorkerCycleHeartbeat(input: RecordWorkerCycleHeartbeatInput): Promise<boolean> {
  if (!hasRedisConfig()) return false;

  const lastCycleAtMs = Number.isFinite(input.lastCycleAtMs) ? Number(input.lastCycleAtMs) : Date.now();
  const error = input.status === 'error' ? toWorkerHeartbeatErrorCode(input.error) : '';
  await redisCommand(
    'HSET',
    workerHeartbeatKey(),
    'lastCycleAt',
    new Date(lastCycleAtMs).toISOString(),
    'status',
    input.status,
    'processed',
    clampCounter(input.processed),
    'delivered',
    clampCounter(input.delivered),
    'error',
    error
  );
  return true;
}

export async function getWorkerRuntimeHealth(nowMs = Date.now()): Promise<WorkerRuntimeHealth> {
  const config = resolveWorkerRuntimeHealthConfig();
  const emptyOldestPending = {
    ageMs: null,
    state: 'empty' as const,
    thresholdsMs: {
      normal: config.oldestPendingNormalMs,
      warning: config.oldestPendingWarningMs,
      critical: config.oldestPendingCriticalMs,
    },
  };
  const unavailable: WorkerRuntimeHealth = {
    ok: false,
    redisLive: false,
    heartbeat: {
      state: 'unavailable',
      ageMs: null,
      staleAfterMs: config.heartbeatStaleMs,
      value: null,
    },
    oldestPending: emptyOldestPending,
  };

  const readiness = await probeRedisReadiness();
  if (!readiness.ok) return unavailable;

  try {
    const [heartbeatRaw, oldestPendingRaw] = await Promise.all([
      redisCommand<unknown>('HGETALL', workerHeartbeatKey()),
      redisCommand<unknown[]>('ZRANGE', leadPendingSinceKey(), 0, 0, 'WITHSCORES'),
    ]);
    const heartbeat = parseHeartbeat(heartbeatRaw);
    const heartbeatState = classifyWorkerHeartbeat(heartbeat, nowMs, config.heartbeatStaleMs);
    const oldestPendingAtMs = parseOldestPendingAtMs(oldestPendingRaw);
    const oldestPendingAgeMs = oldestPendingAtMs === null ? null : Math.max(0, nowMs - oldestPendingAtMs);
    const oldestPendingState = classifyOldestPendingAge(oldestPendingAgeMs, config);
    const heartbeatHealthy = heartbeatState.state === 'cycling' && heartbeat?.status === 'ok';
    const queueHealthy = oldestPendingState !== 'warning' && oldestPendingState !== 'critical';

    return {
      ok: heartbeatHealthy && queueHealthy,
      redisLive: true,
      heartbeat: {
        ...heartbeatState,
        staleAfterMs: config.heartbeatStaleMs,
        value: heartbeat,
      },
      oldestPending: {
        ageMs: oldestPendingAgeMs,
        state: oldestPendingState,
        thresholdsMs: emptyOldestPending.thresholdsMs,
      },
    };
  } catch {
    return unavailable;
  }
}
