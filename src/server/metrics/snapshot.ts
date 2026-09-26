import { assertMemoryFallbackAllowed, hasRedisConfig, redisCommand } from '~/server/redis/client';
import { getFunnelRollupFull, type FunnelStoreSource } from './funnel';

export type SnapshotScope = 'city' | 'service' | 'city_service' | 'page_type';

export const DAILY_METRICS_SNAPSHOT_SCHEMA_VERSION = 2 as const;

export type DailyMetricsSnapshotCounters = {
  opened: number;
  submitted: number;
};

export type DailyMetricsSnapshotV2 = {
  schemaVersion: typeof DAILY_METRICS_SNAPSHOT_SCHEMA_VERSION;
  targetDay: string;
  generatedAtMs: number;
  dataSource: FunnelStoreSource;
  metricsDegraded: boolean;
  counters: DailyMetricsSnapshotCounters;
};

export type DailyMetricsSnapshotResultV2 = {
  snapshot: DailyMetricsSnapshotV2;
  storageSource: FunnelStoreSource;
};

/**
 * Compatibility-only types for the dormant legacy alert formatter.
 * Snapshot V2 never creates or persists these diagnostics.
 */
export type DailySnapshotAnomalyReason =
  'cr_drop' | 'zero_submitted' | 'opened_spike' | 'submitted_spike' | 'opened_up_submitted_down';

export type DailySnapshotAnomaly = {
  scope: SnapshotScope;
  key: string;
  city: string;
  service: string;
  pageType: string;
  reason: DailySnapshotAnomalyReason;
  severity: 'warning' | 'critical';
  opened: number;
  submitted: number;
  conversionRate: number;
  baselineAvgOpened: number;
  baselineAvgSubmitted: number;
  baselineAvgConversionRate: number;
  deltaConversionPct: number | null;
};

const DEFAULT_SNAPSHOT_TTL_SEC = 60 * 60 * 24 * 180;
const memorySnapshots = new Map<string, DailyMetricsSnapshotV2>();

type UnknownRecord = Record<string, unknown>;

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveSnapshotTtlSec(): number {
  return parsePositiveInt(process.env.METRICS_SNAPSHOT_RETENTION_SEC, DEFAULT_SNAPSHOT_TTL_SEC, 60 * 60);
}

function resolvePrefix(): string {
  const value = (process.env.CONTACT_REDIS_PREFIX || '').trim();
  if (!value) return 'lead';
  return value.replace(/[^a-zA-Z0-9:_-]/g, '-');
}

function keyForSnapshotV2(day: string): string {
  return `${resolvePrefix()}:metrics:snapshot:v2:day:${day}`;
}

function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isValidMetricsSnapshotDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && toDayString(parsed) === value;
}

function resolveTargetDay(rawValue?: string): string {
  if (rawValue === undefined) {
    const now = new Date();
    now.setUTCDate(now.getUTCDate() - 1);
    return toDayString(now);
  }

  const normalized = rawValue.trim();
  if (!isValidMetricsSnapshotDay(normalized)) {
    throw new Error('INVALID_METRICS_SNAPSHOT_DAY');
  }
  return normalized;
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDataSource(value: unknown): value is FunnelStoreSource {
  return value === 'redis' || value === 'memory';
}

function isSnapshotCounters(value: unknown): value is DailyMetricsSnapshotCounters {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['opened', 'submitted']) &&
    isNonNegativeSafeInteger(value.opened) &&
    isNonNegativeSafeInteger(value.submitted)
  );
}

export function parseDailyMetricsSnapshotV2(rawValue: string): DailyMetricsSnapshotV2 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return null;
  }

  if (
    !isPlainRecord(parsed) ||
    !hasExactKeys(parsed, [
      'schemaVersion',
      'targetDay',
      'generatedAtMs',
      'dataSource',
      'metricsDegraded',
      'counters',
    ]) ||
    parsed.schemaVersion !== DAILY_METRICS_SNAPSHOT_SCHEMA_VERSION ||
    !isValidMetricsSnapshotDay(parsed.targetDay) ||
    !isPositiveSafeInteger(parsed.generatedAtMs) ||
    !isDataSource(parsed.dataSource) ||
    parsed.metricsDegraded !== (parsed.dataSource !== 'redis') ||
    !isSnapshotCounters(parsed.counters)
  ) {
    return null;
  }

  return parsed as DailyMetricsSnapshotV2;
}

function toCurrentCounter(value: number, name: 'opened' | 'submitted'): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new Error(`INVALID_METRICS_SNAPSHOT_${name.toUpperCase()}`);
  }
  return value;
}

async function persistSnapshotV2(day: string, snapshot: DailyMetricsSnapshotV2): Promise<FunnelStoreSource> {
  const key = keyForSnapshotV2(day);
  const ttlSec = resolveSnapshotTtlSec();

  if (hasRedisConfig()) {
    try {
      await redisCommand('SET', key, JSON.stringify(snapshot), 'EX', ttlSec);
      return 'redis';
    } catch (error) {
      assertMemoryFallbackAllowed(error);
      console.warn('[metrics-snapshot-v2] redis_write_failed_fallback_memory', {
        code: error instanceof Error ? error.message : 'UNKNOWN',
      });
    }
  }

  assertMemoryFallbackAllowed();
  memorySnapshots.set(day, snapshot);
  return 'memory';
}

export async function getStoredDailyMetricsSnapshotV2(day: string): Promise<DailyMetricsSnapshotResultV2 | null> {
  const normalizedDay = resolveTargetDay(day);

  if (hasRedisConfig()) {
    try {
      const raw = await redisCommand<string | null>('GET', keyForSnapshotV2(normalizedDay));
      if (raw === null) return null;
      if (typeof raw !== 'string' || !raw.trim()) return null;
      const snapshot = parseDailyMetricsSnapshotV2(raw);
      if (!snapshot || snapshot.targetDay !== normalizedDay) {
        console.warn('[metrics-snapshot-v2] redis_payload_rejected', { targetDay: normalizedDay });
        return null;
      }
      return { snapshot, storageSource: 'redis' };
    } catch (error) {
      assertMemoryFallbackAllowed(error);
      console.warn('[metrics-snapshot-v2] redis_read_failed_fallback_memory', {
        code: error instanceof Error ? error.message : 'UNKNOWN',
      });
    }
  }

  assertMemoryFallbackAllowed();
  const snapshot = memorySnapshots.get(normalizedDay);
  return snapshot ? { snapshot, storageSource: 'memory' } : null;
}

export async function generateDailyMetricsSnapshotV2(params?: {
  targetDay?: string;
}): Promise<DailyMetricsSnapshotResultV2> {
  const targetDay = resolveTargetDay(params?.targetDay);
  const rollup = await getFunnelRollupFull({ span: 'day', bucket: targetDay });
  const dataSource = rollup.dataSource;

  const snapshot: DailyMetricsSnapshotV2 = {
    schemaVersion: DAILY_METRICS_SNAPSHOT_SCHEMA_VERSION,
    targetDay,
    generatedAtMs: Date.now(),
    dataSource,
    metricsDegraded: dataSource !== 'redis',
    counters: {
      opened: toCurrentCounter(rollup.totalOpened, 'opened'),
      submitted: toCurrentCounter(rollup.totalSubmitted, 'submitted'),
    },
  };

  const storageSource = await persistSnapshotV2(targetDay, snapshot);
  return { snapshot, storageSource };
}
