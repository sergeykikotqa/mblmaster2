import { resolveConversionHealthConfig } from './health-config';
import { generateDailyConversionSnapshot, type DailySnapshotRow } from './snapshot';
import { buildSignals } from './signals';
import { decideNextHealthState } from './state-machine';
import { appendHealthTransition, getHealthState, upsertHealthState, type HealthStateStoreSource } from './state-store';
import { applyStateTransition } from './state-transitions';
import type { AggregatedSlice, HealthScope, HealthState, HealthTransitionEvent } from './health-types';

export type EvaluatedSlice = {
  scope: HealthScope;
  key: string;
  state: HealthState;
  previousState: HealthState | null;
  opened: number;
  submitted: number;
  conversionRate: number;
  baselineConversionRate: number;
  deltaPct: number;
  signals: ReturnType<typeof buildSignals>;
  transition: HealthTransitionEvent | null;
  blockedByHysteresis: boolean;
};

export type ConversionHealthEvaluationResult = {
  targetDay: string;
  baselineDays: number;
  generatedAtMs: number;
  dataSource: HealthStateStoreSource | 'mixed';
  metricsDegraded: boolean;
  states: EvaluatedSlice[];
  summary: {
    slicesEvaluated: number;
    transitions: number;
    blockedByHysteresis: number;
    byState: Record<HealthState, number>;
    byScope: Record<HealthScope, number>;
  };
};

function normalizeCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeRate(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function normalizeDeltaPct(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function rowToSlice(row: DailySnapshotRow): AggregatedSlice {
  return {
    scope: row.scope,
    key: row.key,
    opened: normalizeCount(row.opened),
    submitted: normalizeCount(row.submitted),
    conversionRate: normalizeRate(row.conversionRate),
    baselineConversionRate: normalizeRate(row.baselineAvgConversionRate),
    deltaPct: normalizeDeltaPct(row.deltaConversionPct),
    baselineOpened: normalizeCount(row.baselineAvgOpened),
    baselineSubmitted: normalizeCount(row.baselineAvgSubmitted),
  };
}

function resolveGlobalSourceRows(rows: DailySnapshotRow[]): DailySnapshotRow[] {
  const preferedScopes: Array<DailySnapshotRow['scope']> = ['city_service', 'page_type', 'city', 'service'];
  for (const scope of preferedScopes) {
    const scoped = rows.filter((row) => row.scope === scope);
    if (scoped.length > 0) return scoped;
  }
  return [];
}

function buildGlobalSlice(rows: DailySnapshotRow[]): AggregatedSlice | null {
  const sourceRows = resolveGlobalSourceRows(rows);
  if (sourceRows.length === 0) return null;

  const opened = sourceRows.reduce((sum, row) => sum + normalizeCount(row.opened), 0);
  const submitted = sourceRows.reduce((sum, row) => sum + normalizeCount(row.submitted), 0);
  const baselineOpened = sourceRows.reduce((sum, row) => sum + normalizeCount(row.baselineAvgOpened), 0);
  const baselineSubmitted = sourceRows.reduce((sum, row) => sum + normalizeCount(row.baselineAvgSubmitted), 0);
  const conversionRate = opened > 0 ? submitted / opened : 0;
  const baselineConversionRate = baselineOpened > 0 ? baselineSubmitted / baselineOpened : 0;
  const deltaPct = baselineConversionRate > 0 ? (conversionRate - baselineConversionRate) / baselineConversionRate : 0;

  return {
    scope: 'global',
    key: 'global',
    opened,
    submitted,
    conversionRate,
    baselineConversionRate,
    deltaPct,
    baselineOpened,
    baselineSubmitted,
  };
}

function mergeStoreSources(
  left: HealthStateStoreSource | 'mixed',
  right: HealthStateStoreSource
): HealthStateStoreSource | 'mixed' {
  if (left === right) return left;
  return 'mixed';
}

function summarize(evaluated: EvaluatedSlice[]): ConversionHealthEvaluationResult['summary'] {
  const byState: Record<HealthState, number> = {
    HEALTHY: 0,
    DEGRADED: 0,
    CRITICAL: 0,
    RECOVERING: 0,
  };

  const byScope: Record<HealthScope, number> = {
    global: 0,
    city: 0,
    service: 0,
    city_service: 0,
    page_type: 0,
  };

  let transitions = 0;
  let blockedByHysteresis = 0;

  for (const item of evaluated) {
    byState[item.state] += 1;
    byScope[item.scope] += 1;
    if (item.transition) transitions += 1;
    if (item.blockedByHysteresis) blockedByHysteresis += 1;
  }

  return {
    slicesEvaluated: evaluated.length,
    transitions,
    blockedByHysteresis,
    byState,
    byScope,
  };
}

export async function evaluateConversionHealth(params?: {
  targetDay?: string;
  baselineDays?: number;
  includePageType?: boolean;
}): Promise<ConversionHealthEvaluationResult> {
  const nowMs = Date.now();
  const config = resolveConversionHealthConfig();
  const includePageType = params?.includePageType !== false;
  const snapshot = await generateDailyConversionSnapshot({
    targetDay: params?.targetDay,
    baselineDays: params?.baselineDays,
  });

  const scopedRows = includePageType ? snapshot.rows : snapshot.rows.filter((row) => row.scope !== 'page_type');
  const slices = scopedRows.map(rowToSlice);
  const globalSlice = buildGlobalSlice(scopedRows);
  if (globalSlice) {
    slices.unshift(globalSlice);
  }

  let storeSource: HealthStateStoreSource | 'mixed' = 'redis';
  const evaluated: EvaluatedSlice[] = [];

  for (const slice of slices) {
    const current = await getHealthState(slice.scope, slice.key);
    storeSource = mergeStoreSources(storeSource, current.dataSource);

    const signals = buildSignals(slice, config);
    const decision = decideNextHealthState(
      {
        currentState: current.value?.state || 'HEALTHY',
        slice,
        signals,
        stableDays: current.value?.stableDays || 0,
      },
      config
    );

    const applied = applyStateTransition(
      {
        scope: slice.scope,
        key: slice.key,
        current: current.value,
        decision,
        nowMs,
      },
      config
    );

    const upserted = await upsertHealthState(applied.record);
    storeSource = mergeStoreSources(storeSource, upserted.dataSource);

    let transition: HealthTransitionEvent | null = null;
    if (applied.transition) {
      const appended = await appendHealthTransition(applied.transition);
      storeSource = mergeStoreSources(storeSource, appended.dataSource);
      transition = appended.value;
    }

    evaluated.push({
      scope: slice.scope,
      key: slice.key,
      state: applied.record.state,
      previousState: applied.record.previousState,
      opened: slice.opened,
      submitted: slice.submitted,
      conversionRate: slice.conversionRate,
      baselineConversionRate: slice.baselineConversionRate,
      deltaPct: slice.deltaPct,
      signals,
      transition,
      blockedByHysteresis: applied.blockedByHysteresis,
    });
  }

  return {
    targetDay: snapshot.targetDay,
    baselineDays: snapshot.baselineDays,
    generatedAtMs: nowMs,
    dataSource: storeSource,
    metricsDegraded: snapshot.metricsDegraded || storeSource !== 'redis',
    states: evaluated,
    summary: summarize(evaluated),
  };
}
