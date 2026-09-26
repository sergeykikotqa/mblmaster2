import { probeHealthStateStoreAvailability, type HealthStateStoreSource } from './state-store';
import type { HealthScope, HealthState } from './health-types';

export const CONVERSION_HEALTH_UNAVAILABLE_REASON = 'CONSENT_SCOPE_MISMATCH' as const;

export type ConversionHealthEvaluationResult = {
  targetDay: string;
  baselineDays: number;
  generatedAtMs: number;
  conversion: {
    available: false;
    reason: typeof CONVERSION_HEALTH_UNAVAILABLE_REASON;
  };
  statisticsSource: {
    status: 'NOT_CHECKED';
    reason: 'CONVERSION_ASSESSMENT_UNAVAILABLE';
  };
  stateStore: {
    available: true;
    dataSource: HealthStateStoreSource;
    degraded: boolean;
    legacyPayloadRead: false;
  };
  states: [];
  summary: {
    slicesEvaluated: 0;
    transitions: 0;
    blockedByHysteresis: 0;
    byState: Record<HealthState, number>;
    byScope: Record<HealthScope, number>;
  };
};

const DEFAULT_BASELINE_DAYS = 7;

function resolveTargetDay(rawValue?: string): string {
  if (typeof rawValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawValue.trim())) {
    return rawValue.trim();
  }

  const now = new Date();
  now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

function resolveBaselineDays(value?: number): number {
  const configured = Number(process.env.METRICS_SNAPSHOT_BASELINE_DAYS);
  const fallback = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : DEFAULT_BASELINE_DAYS;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value as number));
}

function emptySummary(): ConversionHealthEvaluationResult['summary'] {
  return {
    slicesEvaluated: 0,
    transitions: 0,
    blockedByHysteresis: 0,
    byState: {
      HEALTHY: 0,
      DEGRADED: 0,
      CRITICAL: 0,
      RECOVERING: 0,
    },
    byScope: {
      global: 0,
      city: 0,
      service: 0,
      city_service: 0,
      page_type: 0,
    },
  };
}

export async function evaluateConversionHealth(params?: {
  targetDay?: string;
  baselineDays?: number;
  includePageType?: boolean;
}): Promise<ConversionHealthEvaluationResult> {
  // Kept in the public call contract for existing callers. No slices are evaluated
  // while the numerator and denominator come from incomparable consent scopes.
  void params?.includePageType;

  const stateStoreProbe = await probeHealthStateStoreAvailability();

  return {
    targetDay: resolveTargetDay(params?.targetDay),
    baselineDays: resolveBaselineDays(params?.baselineDays),
    generatedAtMs: Date.now(),
    conversion: {
      available: false,
      reason: CONVERSION_HEALTH_UNAVAILABLE_REASON,
    },
    statisticsSource: {
      status: 'NOT_CHECKED',
      reason: 'CONVERSION_ASSESSMENT_UNAVAILABLE',
    },
    stateStore: {
      available: stateStoreProbe.value.available,
      dataSource: stateStoreProbe.dataSource,
      degraded: stateStoreProbe.degraded,
      legacyPayloadRead: stateStoreProbe.value.legacyPayloadRead,
    },
    states: [],
    summary: emptySummary(),
  };
}
