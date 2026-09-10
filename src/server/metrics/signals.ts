import { resolveConversionHealthConfig, type ConversionHealthConfig } from './health-config';
import type { AggregatedSlice, Signals } from './health-types';

function normalizeCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeRatio(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function resolveSliceBaselineOpened(slice: AggregatedSlice): number {
  const explicitBaselineOpened = normalizeCount(slice.baselineOpened);
  if (explicitBaselineOpened > 0) return explicitBaselineOpened;
  return 0;
}

function shouldUseBaseline(slice: AggregatedSlice, config: ConversionHealthConfig): boolean {
  const baselineOpened = resolveSliceBaselineOpened(slice);
  return baselineOpened >= config.signal.baselineMinVolume && normalizeRatio(slice.baselineConversionRate) > 0;
}

export function buildSignals(
  slice: AggregatedSlice,
  config: ConversionHealthConfig = resolveConversionHealthConfig()
): Signals {
  const opened = normalizeCount(slice.opened);
  const submitted = normalizeCount(slice.submitted);
  const deltaPct = Number.isFinite(slice.deltaPct) ? Number(slice.deltaPct) : 0;
  const baselineOpened = resolveSliceBaselineOpened(slice);
  const canUseBaseline = shouldUseBaseline(slice, config);
  const hasMinVolume = opened >= config.signal.minVolume;

  return {
    crDrop: hasMinVolume && canUseBaseline && deltaPct <= -Math.abs(config.signal.crDropWarnPct),
    zeroSubmitted: submitted === 0 && opened >= config.signal.zeroSubmittedOpenedMin,
    openedSpike: canUseBaseline && opened > baselineOpened * config.signal.openedSpikeMultiplier,
    openedDrop: canUseBaseline && opened < baselineOpened * config.signal.openedDropMultiplier,
    volatility: hasMinVolume && canUseBaseline && Math.abs(deltaPct) >= Math.abs(config.signal.highVolatilityPct),
  };
}
