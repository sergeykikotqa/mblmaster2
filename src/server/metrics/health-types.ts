export type HealthScope = 'global' | 'city' | 'service' | 'city_service' | 'page_type';

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'RECOVERING';

export type AggregatedSlice = {
  scope: HealthScope;
  key: string;
  opened: number;
  submitted: number;
  conversionRate: number;
  baselineConversionRate: number;
  deltaPct: number;
  // Optional baseline volumes for signal rules like spike/drop.
  baselineOpened?: number;
  baselineSubmitted?: number;
};

export type Signals = {
  crDrop: boolean;
  zeroSubmitted: boolean;
  openedSpike: boolean;
  openedDrop: boolean;
  volatility: boolean;
};

export type HealthStateRecord = {
  scope: HealthScope;
  key: string;
  state: HealthState;
  since: string;
  previousState: HealthState | null;
  stableDays: number;
  updatedAtMs: number;
};

export type HealthTransitionEvent = {
  scope: HealthScope;
  key: string;
  from: HealthState;
  to: HealthState;
  at: string;
  reason: string;
  stableDays: number;
};
