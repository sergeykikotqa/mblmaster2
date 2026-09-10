export type ConversionHealthSignalConfig = {
  minVolume: number;
  baselineMinVolume: number;
  zeroSubmittedOpenedMin: number;
  crDropWarnPct: number;
  crDropCriticalPct: number;
  openedSpikeMultiplier: number;
  openedDropMultiplier: number;
  highVolatilityPct: number;
};

export type ConversionHealthHysteresisConfig = {
  requireStableDays: number;
  minStateDurationDays: number;
};

export type ConversionHealthConfig = {
  signal: ConversionHealthSignalConfig;
  hysteresis: ConversionHealthHysteresisConfig;
};

const DEFAULT_SIGNAL_CONFIG: ConversionHealthSignalConfig = {
  minVolume: 12,
  baselineMinVolume: 10,
  zeroSubmittedOpenedMin: 15,
  crDropWarnPct: 0.2,
  crDropCriticalPct: 0.35,
  openedSpikeMultiplier: 1.8,
  openedDropMultiplier: 0.6,
  highVolatilityPct: 0.35,
};

const DEFAULT_HYSTERESIS_CONFIG: ConversionHealthHysteresisConfig = {
  requireStableDays: 2,
  minStateDurationDays: 1,
};

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

function parseFraction(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

export function resolveConversionHealthConfig(): ConversionHealthConfig {
  return {
    signal: {
      minVolume: parsePositiveInt(process.env.METRICS_HEALTH_MIN_VOLUME, DEFAULT_SIGNAL_CONFIG.minVolume, 1),
      baselineMinVolume: parsePositiveInt(
        process.env.METRICS_HEALTH_BASELINE_MIN_VOLUME,
        DEFAULT_SIGNAL_CONFIG.baselineMinVolume,
        1
      ),
      zeroSubmittedOpenedMin: parsePositiveInt(
        process.env.METRICS_HEALTH_ZERO_SUBMITTED_OPENED_MIN,
        DEFAULT_SIGNAL_CONFIG.zeroSubmittedOpenedMin,
        1
      ),
      crDropWarnPct: parseFraction(process.env.METRICS_HEALTH_CR_DROP_WARN_PCT, DEFAULT_SIGNAL_CONFIG.crDropWarnPct),
      crDropCriticalPct: parseFraction(
        process.env.METRICS_HEALTH_CR_DROP_CRITICAL_PCT,
        DEFAULT_SIGNAL_CONFIG.crDropCriticalPct
      ),
      openedSpikeMultiplier: parsePositiveNumber(
        process.env.METRICS_HEALTH_OPENED_SPIKE_MULTIPLIER,
        DEFAULT_SIGNAL_CONFIG.openedSpikeMultiplier,
        1
      ),
      openedDropMultiplier: parsePositiveNumber(
        process.env.METRICS_HEALTH_OPENED_DROP_MULTIPLIER,
        DEFAULT_SIGNAL_CONFIG.openedDropMultiplier,
        0.01
      ),
      highVolatilityPct: parseFraction(
        process.env.METRICS_HEALTH_HIGH_VOLATILITY_PCT,
        DEFAULT_SIGNAL_CONFIG.highVolatilityPct
      ),
    },
    hysteresis: {
      requireStableDays: parsePositiveInt(
        process.env.METRICS_HEALTH_REQUIRE_STABLE_DAYS,
        DEFAULT_HYSTERESIS_CONFIG.requireStableDays,
        1
      ),
      minStateDurationDays: parsePositiveInt(
        process.env.METRICS_HEALTH_MIN_STATE_DURATION_DAYS,
        DEFAULT_HYSTERESIS_CONFIG.minStateDurationDays,
        1
      ),
    },
  };
}
