import { resolveConversionHealthConfig, type ConversionHealthConfig } from './health-config';
import type { HealthScope, HealthState, HealthStateRecord, HealthTransitionEvent } from './health-types';
import type { StateMachineDecision } from './state-machine';

export type ApplyStateTransitionInput = {
  scope: HealthScope;
  key: string;
  current: HealthStateRecord | null;
  decision: StateMachineDecision;
  nowMs?: number;
};

export type ApplyStateTransitionResult = {
  record: HealthStateRecord;
  transition: HealthTransitionEvent | null;
  changed: boolean;
  blockedByHysteresis: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const STATE_SEVERITY: Record<HealthState, number> = {
  HEALTHY: 0,
  RECOVERING: 1,
  DEGRADED: 2,
  CRITICAL: 3,
};

function toIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function normalizeSince(isoValue: string | undefined, fallbackMs: number): string {
  if (typeof isoValue === 'string' && Number.isFinite(Date.parse(isoValue))) {
    return new Date(isoValue).toISOString();
  }
  return toIso(fallbackMs);
}

function stateAgeDays(record: HealthStateRecord, nowMs: number): number {
  const sinceMs = Date.parse(record.since);
  if (!Number.isFinite(sinceMs)) return Number.POSITIVE_INFINITY;
  if (sinceMs >= nowMs) return 0;
  return Math.floor((nowMs - sinceMs) / DAY_MS);
}

function isDeEscalation(from: HealthState, to: HealthState): boolean {
  return STATE_SEVERITY[to] < STATE_SEVERITY[from];
}

function shouldBlockTransitionByHysteresis(params: {
  from: HealthState;
  to: HealthState;
  currentAgeDays: number;
  config: ConversionHealthConfig;
}): boolean {
  if (params.from === params.to) return false;
  if (!isDeEscalation(params.from, params.to)) return false;
  return params.currentAgeDays < params.config.hysteresis.minStateDurationDays;
}

function createInitialRecord(scope: HealthScope, key: string, state: HealthState, nowMs: number): HealthStateRecord {
  return {
    scope,
    key,
    state,
    since: toIso(nowMs),
    previousState: null,
    stableDays: 0,
    updatedAtMs: nowMs,
  };
}

function computeStableDays(params: {
  previous: HealthStateRecord;
  nextState: HealthState;
  isStableDay: boolean;
}): number {
  if (params.nextState !== 'RECOVERING') return 0;

  if (params.previous.state !== 'RECOVERING') {
    return params.isStableDay ? 1 : 0;
  }

  return params.isStableDay ? params.previous.stableDays + 1 : 0;
}

export function applyStateTransition(
  input: ApplyStateTransitionInput,
  config: ConversionHealthConfig = resolveConversionHealthConfig()
): ApplyStateTransitionResult {
  const nowMs = Number.isFinite(input.nowMs) ? Math.floor(input.nowMs as number) : Date.now();
  const base = input.current
    ? {
        ...input.current,
        scope: input.scope,
        key: input.key,
        since: normalizeSince(input.current.since, nowMs),
      }
    : createInitialRecord(input.scope, input.key, input.decision.from, nowMs);

  const candidateState = input.decision.changed ? input.decision.to : base.state;
  const ageDays = stateAgeDays(base, nowMs);
  const blockedByHysteresis = shouldBlockTransitionByHysteresis({
    from: base.state,
    to: candidateState,
    currentAgeDays: ageDays,
    config,
  });

  const nextState = blockedByHysteresis ? base.state : candidateState;
  const changed = nextState !== base.state;
  const stableDays = computeStableDays({
    previous: base,
    nextState,
    isStableDay: input.decision.isStableDay,
  });

  const nextRecord: HealthStateRecord = {
    scope: base.scope,
    key: base.key,
    state: nextState,
    since: changed ? toIso(nowMs) : base.since,
    previousState: changed ? base.state : base.previousState,
    stableDays,
    updatedAtMs: nowMs,
  };

  if (!changed) {
    return {
      record: nextRecord,
      transition: null,
      changed: false,
      blockedByHysteresis,
    };
  }

  const transition: HealthTransitionEvent = {
    scope: base.scope,
    key: base.key,
    from: base.state,
    to: nextState,
    at: toIso(nowMs),
    reason: input.decision.reason,
    stableDays,
  };

  return {
    record: nextRecord,
    transition,
    changed: true,
    blockedByHysteresis,
  };
}
