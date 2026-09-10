import { resolveConversionHealthConfig, type ConversionHealthConfig } from './health-config';
import type { AggregatedSlice, HealthState, Signals } from './health-types';

export type StateMachineInput = {
  currentState: HealthState;
  slice: AggregatedSlice;
  signals: Signals;
  stableDays?: number;
};

export type StateMachineDecision = {
  from: HealthState;
  to: HealthState;
  changed: boolean;
  reason:
    | 'healthy_no_signal'
    | 'degraded_signal'
    | 'critical_signal'
    | 'critical_persisted'
    | 'recovery_started'
    | 'recovery_in_progress'
    | 'recovery_completed'
    | 'recovery_relapsed'
    | 'state_unchanged';
  isStableDay: boolean;
};

function normalizeCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeDelta(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function hasCriticalCondition(input: StateMachineInput, config: ConversionHealthConfig): boolean {
  const opened = normalizeCount(input.slice.opened);
  const submitted = normalizeCount(input.slice.submitted);
  const deltaPct = normalizeDelta(input.slice.deltaPct);

  const hardZeroSubmitted = submitted === 0 && opened >= config.signal.zeroSubmittedOpenedMin;
  const hardCrDrop = deltaPct <= -Math.abs(config.signal.crDropCriticalPct);
  const suspiciousSpikeWithCrDrop = input.signals.openedSpike && input.signals.crDrop;

  return hardZeroSubmitted || hardCrDrop || suspiciousSpikeWithCrDrop;
}

function hasDegradedCondition(input: StateMachineInput): boolean {
  return input.signals.crDrop || input.signals.zeroSubmitted || input.signals.volatility;
}

function isStableDay(input: StateMachineInput): boolean {
  const submitted = normalizeCount(input.slice.submitted);
  return (
    submitted > 0 &&
    !input.signals.crDrop &&
    !input.signals.zeroSubmitted &&
    !input.signals.volatility &&
    !input.signals.openedDrop
  );
}

export function decideNextHealthState(
  input: StateMachineInput,
  config: ConversionHealthConfig = resolveConversionHealthConfig()
): StateMachineDecision {
  const from = input.currentState;
  const stableDays = Math.max(0, Math.floor(Number(input.stableDays || 0)));
  const stableToday = isStableDay(input);
  const critical = hasCriticalCondition(input, config);
  const degraded = hasDegradedCondition(input);

  if (from === 'HEALTHY') {
    if (critical) {
      return {
        from,
        to: 'CRITICAL',
        changed: true,
        reason: 'critical_signal',
        isStableDay: stableToday,
      };
    }
    if (degraded) {
      return {
        from,
        to: 'DEGRADED',
        changed: true,
        reason: 'degraded_signal',
        isStableDay: stableToday,
      };
    }
    return {
      from,
      to: 'HEALTHY',
      changed: false,
      reason: 'healthy_no_signal',
      isStableDay: stableToday,
    };
  }

  if (from === 'DEGRADED') {
    if (critical) {
      return {
        from,
        to: 'CRITICAL',
        changed: true,
        reason: 'critical_signal',
        isStableDay: stableToday,
      };
    }
    if (stableToday) {
      return {
        from,
        to: 'RECOVERING',
        changed: true,
        reason: 'recovery_started',
        isStableDay: true,
      };
    }
    return {
      from,
      to: 'DEGRADED',
      changed: false,
      reason: 'state_unchanged',
      isStableDay: false,
    };
  }

  if (from === 'CRITICAL') {
    if (critical) {
      return {
        from,
        to: 'CRITICAL',
        changed: false,
        reason: 'critical_persisted',
        isStableDay: stableToday,
      };
    }
    if (stableToday) {
      return {
        from,
        to: 'RECOVERING',
        changed: true,
        reason: 'recovery_started',
        isStableDay: true,
      };
    }
    return {
      from,
      to: 'CRITICAL',
      changed: false,
      reason: 'state_unchanged',
      isStableDay: false,
    };
  }

  if (critical) {
    return {
      from,
      to: 'CRITICAL',
      changed: true,
      reason: 'recovery_relapsed',
      isStableDay: stableToday,
    };
  }

  if (degraded && !stableToday) {
    return {
      from,
      to: 'DEGRADED',
      changed: true,
      reason: 'recovery_relapsed',
      isStableDay: false,
    };
  }

  if (stableToday && stableDays + 1 >= config.hysteresis.requireStableDays) {
    return {
      from,
      to: 'HEALTHY',
      changed: true,
      reason: 'recovery_completed',
      isStableDay: true,
    };
  }

  return {
    from,
    to: 'RECOVERING',
    changed: false,
    reason: 'recovery_in_progress',
    isStableDay: stableToday,
  };
}
