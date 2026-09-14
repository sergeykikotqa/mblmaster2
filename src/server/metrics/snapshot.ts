import { assertMemoryFallbackAllowed, hasRedisConfig, redisCommand } from '~/server/redis/client';
import { getFunnelRollupFull, type FunnelRollup, type FunnelRollupEntry, type FunnelStoreSource } from './funnel';

export type SnapshotScope = 'city' | 'service' | 'city_service' | 'page_type';

export type DailySnapshotRow = {
  scope: SnapshotScope;
  key: string;
  city: string;
  service: string;
  pageType: string;
  opened: number;
  submitted: number;
  conversionRate: number;
  baselineAvgOpened: number;
  baselineAvgSubmitted: number;
  baselineAvgConversionRate: number;
  deltaConversionPct: number | null;
};

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

export type DailySnapshotResult = {
  targetDay: string;
  baselineDays: number;
  generatedAtMs: number;
  dataSource: FunnelStoreSource | 'mixed';
  storageSource: FunnelStoreSource;
  metricsDegraded: boolean;
  rows: DailySnapshotRow[];
  anomalies: DailySnapshotAnomaly[];
  summary: {
    rows: number;
    anomalies: number;
    critical: number;
    warnings: number;
    byReason: Record<DailySnapshotAnomalyReason, number>;
  };
};

type SnapshotAggregateRow = {
  scope: SnapshotScope;
  key: string;
  city: string;
  service: string;
  pageType: string;
  opened: number;
  submitted: number;
};

type SnapshotStorePayload = DailySnapshotResult;

const DEFAULT_BASELINE_DAYS = 7;
const DEFAULT_CR_DROP_THRESHOLD = 0.3;
const DEFAULT_CR_DROP_MIN_OPENED = 10;
const DEFAULT_ZERO_SUBMITTED_OPENED_MIN = 15;
const DEFAULT_OPENED_SPIKE_MULTIPLIER = 3;
const DEFAULT_SUBMITTED_SPIKE_MULTIPLIER = 3;
const DEFAULT_SPIKE_MIN_OPENED = 20;
const DEFAULT_SPIKE_MIN_SUBMITTED = 10;
const DEFAULT_OPENED_UP_SUBMITTED_DOWN_FACTOR = 0.5;
const DEFAULT_SNAPSHOT_TTL_SEC = 60 * 60 * 24 * 180;

const memorySnapshots = new Map<string, SnapshotStorePayload>();

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function parsePositiveNumber(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function resolveBaselineDays(): number {
  return parsePositiveInt(process.env.METRICS_SNAPSHOT_BASELINE_DAYS, DEFAULT_BASELINE_DAYS, 1);
}

function resolveCrDropThreshold(): number {
  return parsePositiveNumber(process.env.METRICS_SNAPSHOT_CR_DROP_THRESHOLD, DEFAULT_CR_DROP_THRESHOLD, 0.01);
}

function resolveCrDropMinOpened(): number {
  return parsePositiveInt(process.env.METRICS_SNAPSHOT_CR_DROP_MIN_OPENED, DEFAULT_CR_DROP_MIN_OPENED, 1);
}

function resolveZeroSubmittedOpenedMin(): number {
  return parsePositiveInt(process.env.METRICS_SNAPSHOT_ZERO_SUBMITTED_OPENED_MIN, DEFAULT_ZERO_SUBMITTED_OPENED_MIN, 1);
}

function resolveOpenedSpikeMultiplier(): number {
  return parsePositiveNumber(
    process.env.METRICS_SNAPSHOT_OPENED_SPIKE_MULTIPLIER,
    DEFAULT_OPENED_SPIKE_MULTIPLIER,
    1.1
  );
}

function resolveSubmittedSpikeMultiplier(): number {
  return parsePositiveNumber(
    process.env.METRICS_SNAPSHOT_SUBMITTED_SPIKE_MULTIPLIER,
    DEFAULT_SUBMITTED_SPIKE_MULTIPLIER,
    1.1
  );
}

function resolveSpikeMinOpened(): number {
  return parsePositiveInt(process.env.METRICS_SNAPSHOT_SPIKE_MIN_OPENED, DEFAULT_SPIKE_MIN_OPENED, 1);
}

function resolveSpikeMinSubmitted(): number {
  return parsePositiveInt(process.env.METRICS_SNAPSHOT_SPIKE_MIN_SUBMITTED, DEFAULT_SPIKE_MIN_SUBMITTED, 1);
}

function resolveOpenedUpSubmittedDownFactor(): number {
  return parsePositiveNumber(
    process.env.METRICS_SNAPSHOT_OPENED_UP_SUBMITTED_DOWN_FACTOR,
    DEFAULT_OPENED_UP_SUBMITTED_DOWN_FACTOR,
    0.01
  );
}

function resolveSnapshotTtlSec(): number {
  return parsePositiveInt(process.env.METRICS_SNAPSHOT_RETENTION_SEC, DEFAULT_SNAPSHOT_TTL_SEC, 60 * 60);
}

function resolvePrefix(): string {
  const value = (process.env.CONTACT_REDIS_PREFIX || '').trim();
  if (!value) return 'lead';
  return value.replace(/[^a-zA-Z0-9:_-]/g, '-');
}

function keyForSnapshot(day: string): string {
  return `${resolvePrefix()}:metrics:snapshot:day:${day}`;
}

function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolveTargetDay(rawValue?: string): string {
  if (typeof rawValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawValue.trim())) {
    return rawValue.trim();
  }
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - 1);
  return toDayString(now);
}

function shiftDay(day: string, offsetDays: number): string {
  const base = new Date(`${day}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return toDayString(base);
}

function conversionRate(opened: number, submitted: number): number {
  if (opened <= 0) return 0;
  return submitted / opened;
}

function aggregateScopeRow(
  map: Map<string, SnapshotAggregateRow>,
  row: Omit<SnapshotAggregateRow, 'opened' | 'submitted'>,
  opened: number,
  submitted: number
) {
  const current = map.get(row.key);
  if (current) {
    current.opened += opened;
    current.submitted += submitted;
    map.set(row.key, current);
    return;
  }

  map.set(row.key, {
    ...row,
    opened,
    submitted,
  });
}

function aggregateRowsByScope(entries: FunnelRollupEntry[]): Map<string, SnapshotAggregateRow> {
  const map = new Map<string, SnapshotAggregateRow>();

  for (const entry of entries) {
    const city = String(entry.city || '').trim();
    const service = String(entry.service || '').trim();
    const opened = Number.isFinite(entry.formOpened) ? Math.max(0, Math.floor(entry.formOpened)) : 0;
    const submitted = Number.isFinite(entry.formSubmitted) ? Math.max(0, Math.floor(entry.formSubmitted)) : 0;

    if (city && service) {
      aggregateScopeRow(
        map,
        {
          scope: 'city_service',
          key: `city_service:${city}:${service}`,
          city,
          service,
          pageType: '',
        },
        opened,
        submitted
      );
    }
  }

  return map;
}

function zeroRow(
  meta: Pick<SnapshotAggregateRow, 'scope' | 'key' | 'city' | 'service' | 'pageType'>
): SnapshotAggregateRow {
  return {
    ...meta,
    opened: 0,
    submitted: 0,
  };
}

function summarizeAnomalies(anomalies: DailySnapshotAnomaly[]) {
  const byReason: Record<DailySnapshotAnomalyReason, number> = {
    cr_drop: 0,
    zero_submitted: 0,
    opened_spike: 0,
    submitted_spike: 0,
    opened_up_submitted_down: 0,
  };

  for (const anomaly of anomalies) {
    byReason[anomaly.reason] += 1;
  }

  const critical = anomalies.filter((item) => item.severity === 'critical').length;
  const warnings = anomalies.length - critical;

  return {
    anomalies: anomalies.length,
    critical,
    warnings,
    byReason,
  };
}

function sortRows(rows: DailySnapshotRow[]): DailySnapshotRow[] {
  return rows.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    const submittedDiff = b.submitted - a.submitted;
    if (submittedDiff !== 0) return submittedDiff;
    return b.opened - a.opened;
  });
}

function sortAnomalies(anomalies: DailySnapshotAnomaly[]): DailySnapshotAnomaly[] {
  const severityWeight: Record<DailySnapshotAnomaly['severity'], number> = {
    critical: 2,
    warning: 1,
  };
  return anomalies.sort((a, b) => {
    const severityDiff = severityWeight[b.severity] - severityWeight[a.severity];
    if (severityDiff !== 0) return severityDiff;
    const openedDiff = b.opened - a.opened;
    if (openedDiff !== 0) return openedDiff;
    return b.submitted - a.submitted;
  });
}

function detectRowAnomalies(params: {
  row: DailySnapshotRow;
  crDropThreshold: number;
  crDropMinOpened: number;
  zeroSubmittedOpenedMin: number;
  openedSpikeMultiplier: number;
  submittedSpikeMultiplier: number;
  spikeMinOpened: number;
  spikeMinSubmitted: number;
  openedUpSubmittedDownFactor: number;
}): DailySnapshotAnomaly[] {
  const anomalies: DailySnapshotAnomaly[] = [];
  const {
    row,
    crDropThreshold,
    crDropMinOpened,
    zeroSubmittedOpenedMin,
    openedSpikeMultiplier,
    submittedSpikeMultiplier,
    spikeMinOpened,
    spikeMinSubmitted,
    openedUpSubmittedDownFactor,
  } = params;

  const baselineCr = row.baselineAvgConversionRate;
  const deltaCr = row.deltaConversionPct;

  const openedSpike =
    row.baselineAvgOpened > 0 &&
    row.opened >= spikeMinOpened &&
    row.opened >= row.baselineAvgOpened * openedSpikeMultiplier;
  const submittedSpike =
    row.baselineAvgSubmitted > 0 &&
    row.submitted >= spikeMinSubmitted &&
    row.submitted >= row.baselineAvgSubmitted * submittedSpikeMultiplier;

  if (
    baselineCr > 0 &&
    row.opened >= crDropMinOpened &&
    typeof deltaCr === 'number' &&
    deltaCr <= -Math.abs(crDropThreshold)
  ) {
    anomalies.push({
      scope: row.scope,
      key: row.key,
      city: row.city,
      service: row.service,
      pageType: row.pageType,
      reason: 'cr_drop',
      severity: row.opened >= zeroSubmittedOpenedMin ? 'critical' : 'warning',
      opened: row.opened,
      submitted: row.submitted,
      conversionRate: row.conversionRate,
      baselineAvgOpened: row.baselineAvgOpened,
      baselineAvgSubmitted: row.baselineAvgSubmitted,
      baselineAvgConversionRate: row.baselineAvgConversionRate,
      deltaConversionPct: row.deltaConversionPct,
    });
  }

  if (row.opened > zeroSubmittedOpenedMin && row.submitted === 0) {
    anomalies.push({
      scope: row.scope,
      key: row.key,
      city: row.city,
      service: row.service,
      pageType: row.pageType,
      reason: 'zero_submitted',
      severity: 'critical',
      opened: row.opened,
      submitted: row.submitted,
      conversionRate: row.conversionRate,
      baselineAvgOpened: row.baselineAvgOpened,
      baselineAvgSubmitted: row.baselineAvgSubmitted,
      baselineAvgConversionRate: row.baselineAvgConversionRate,
      deltaConversionPct: row.deltaConversionPct,
    });
  }

  if (openedSpike) {
    anomalies.push({
      scope: row.scope,
      key: row.key,
      city: row.city,
      service: row.service,
      pageType: row.pageType,
      reason: 'opened_spike',
      severity: 'warning',
      opened: row.opened,
      submitted: row.submitted,
      conversionRate: row.conversionRate,
      baselineAvgOpened: row.baselineAvgOpened,
      baselineAvgSubmitted: row.baselineAvgSubmitted,
      baselineAvgConversionRate: row.baselineAvgConversionRate,
      deltaConversionPct: row.deltaConversionPct,
    });
  }

  if (submittedSpike) {
    anomalies.push({
      scope: row.scope,
      key: row.key,
      city: row.city,
      service: row.service,
      pageType: row.pageType,
      reason: 'submitted_spike',
      severity: 'warning',
      opened: row.opened,
      submitted: row.submitted,
      conversionRate: row.conversionRate,
      baselineAvgOpened: row.baselineAvgOpened,
      baselineAvgSubmitted: row.baselineAvgSubmitted,
      baselineAvgConversionRate: row.baselineAvgConversionRate,
      deltaConversionPct: row.deltaConversionPct,
    });
  }

  const openedUpSubmittedDown =
    openedSpike &&
    row.baselineAvgSubmitted > 0 &&
    row.submitted <= row.baselineAvgSubmitted * Math.max(0, openedUpSubmittedDownFactor);

  if (openedUpSubmittedDown) {
    anomalies.push({
      scope: row.scope,
      key: row.key,
      city: row.city,
      service: row.service,
      pageType: row.pageType,
      reason: 'opened_up_submitted_down',
      severity: 'critical',
      opened: row.opened,
      submitted: row.submitted,
      conversionRate: row.conversionRate,
      baselineAvgOpened: row.baselineAvgOpened,
      baselineAvgSubmitted: row.baselineAvgSubmitted,
      baselineAvgConversionRate: row.baselineAvgConversionRate,
      deltaConversionPct: row.deltaConversionPct,
    });
  }

  return anomalies;
}

async function persistSnapshot(
  day: string,
  snapshot: SnapshotStorePayload
): Promise<{ storageSource: FunnelStoreSource }> {
  const key = keyForSnapshot(day);
  const ttlSec = resolveSnapshotTtlSec();

  if (hasRedisConfig()) {
    try {
      await redisCommand('SET', key, JSON.stringify(snapshot), 'EX', ttlSec);
      return { storageSource: 'redis' };
    } catch (error) {
      assertMemoryFallbackAllowed(error);
      console.warn('[metrics-snapshot] redis_write_failed_fallback_memory', {
        code: error instanceof Error ? error.message : 'UNKNOWN',
      });
    }
  }

  assertMemoryFallbackAllowed();
  memorySnapshots.set(day, snapshot);
  return { storageSource: 'memory' };
}

export async function getStoredDailyConversionSnapshot(day: string): Promise<SnapshotStorePayload | null> {
  const normalizedDay = resolveTargetDay(day);

  if (hasRedisConfig()) {
    try {
      const raw = await redisCommand<string | null>('GET', keyForSnapshot(normalizedDay));
      if (typeof raw === 'string' && raw.trim()) {
        return JSON.parse(raw) as SnapshotStorePayload;
      }
    } catch (error) {
      assertMemoryFallbackAllowed(error);
      console.warn('[metrics-snapshot] redis_read_failed_fallback_memory', {
        code: error instanceof Error ? error.message : 'UNKNOWN',
      });
    }
  }

  assertMemoryFallbackAllowed();
  return memorySnapshots.get(normalizedDay) || null;
}

export async function generateDailyConversionSnapshot(params?: {
  targetDay?: string;
  baselineDays?: number;
}): Promise<DailySnapshotResult> {
  const targetDay = resolveTargetDay(params?.targetDay);
  const baselineDays = Math.max(1, params?.baselineDays || resolveBaselineDays());
  const baselineDayKeys = Array.from({ length: baselineDays }, (_, index) => shiftDay(targetDay, -(index + 1)));

  const dayRollups = await Promise.all([
    getFunnelRollupFull({ span: 'day', bucket: targetDay }),
    ...baselineDayKeys.map((day) => getFunnelRollupFull({ span: 'day', bucket: day })),
  ]);

  const targetRollup = dayRollups[0] as FunnelRollup;
  const baselineRollups = dayRollups.slice(1) as FunnelRollup[];
  const dataSources = new Set<FunnelStoreSource>(dayRollups.map((item) => item.dataSource));
  const dataSource: FunnelStoreSource | 'mixed' = dataSources.size === 1 ? [...dataSources][0]! : 'mixed';
  const metricsDegraded = dataSource !== 'redis';

  const targetMap = aggregateRowsByScope(targetRollup.entries);
  const baselineMaps = baselineRollups.map((rollup) => aggregateRowsByScope(rollup.entries));
  const keyMeta = new Map<string, Pick<SnapshotAggregateRow, 'scope' | 'key' | 'city' | 'service' | 'pageType'>>();

  for (const row of targetMap.values()) {
    keyMeta.set(row.key, row);
  }
  for (const map of baselineMaps) {
    for (const row of map.values()) {
      if (!keyMeta.has(row.key)) {
        keyMeta.set(row.key, row);
      }
    }
  }

  const rows: DailySnapshotRow[] = [];
  const anomalies: DailySnapshotAnomaly[] = [];

  const crDropThreshold = resolveCrDropThreshold();
  const crDropMinOpened = resolveCrDropMinOpened();
  const zeroSubmittedOpenedMin = resolveZeroSubmittedOpenedMin();
  const openedSpikeMultiplier = resolveOpenedSpikeMultiplier();
  const submittedSpikeMultiplier = resolveSubmittedSpikeMultiplier();
  const spikeMinOpened = resolveSpikeMinOpened();
  const spikeMinSubmitted = resolveSpikeMinSubmitted();
  const openedUpSubmittedDownFactor = resolveOpenedUpSubmittedDownFactor();

  for (const meta of keyMeta.values()) {
    const target = targetMap.get(meta.key) || zeroRow(meta);
    const baselineSeries = baselineMaps.map((map) => map.get(meta.key) || zeroRow(meta));
    const baselineOpenedTotal = baselineSeries.reduce((sum, item) => sum + item.opened, 0);
    const baselineSubmittedTotal = baselineSeries.reduce((sum, item) => sum + item.submitted, 0);
    const baselineAvgOpened = baselineOpenedTotal / baselineDays;
    const baselineAvgSubmitted = baselineSubmittedTotal / baselineDays;
    const baselineAvgConversionRate = conversionRate(baselineOpenedTotal, baselineSubmittedTotal);
    const rowConversionRate = conversionRate(target.opened, target.submitted);
    const deltaConversionPct =
      baselineAvgConversionRate > 0
        ? (rowConversionRate - baselineAvgConversionRate) / baselineAvgConversionRate
        : null;

    const row: DailySnapshotRow = {
      scope: meta.scope,
      key: meta.key,
      city: target.city,
      service: target.service,
      pageType: target.pageType,
      opened: target.opened,
      submitted: target.submitted,
      conversionRate: rowConversionRate,
      baselineAvgOpened,
      baselineAvgSubmitted,
      baselineAvgConversionRate,
      deltaConversionPct,
    };
    rows.push(row);

    anomalies.push(
      ...detectRowAnomalies({
        row,
        crDropThreshold,
        crDropMinOpened,
        zeroSubmittedOpenedMin,
        openedSpikeMultiplier,
        submittedSpikeMultiplier,
        spikeMinOpened,
        spikeMinSubmitted,
        openedUpSubmittedDownFactor,
      })
    );
  }

  const sortedRows = sortRows(rows);
  const sortedAnomalies = sortAnomalies(anomalies);
  const summary = {
    rows: sortedRows.length,
    ...summarizeAnomalies(sortedAnomalies),
  };

  const snapshot: DailySnapshotResult = {
    targetDay,
    baselineDays,
    generatedAtMs: Date.now(),
    dataSource,
    storageSource: 'memory',
    metricsDegraded,
    rows: sortedRows,
    anomalies: sortedAnomalies,
    summary,
  };

  const persisted = await persistSnapshot(targetDay, snapshot);
  return {
    ...snapshot,
    storageSource: persisted.storageSource,
  };
}
