import type { DeliveryAttemptMetric, LeadPipelineHealth } from './types';

const METRICS_RETENTION_MS = 60 * 60 * 24 * 7 * 1000;

const fallbackState = {
  counters: {
    delivery_success_total: 0,
    delivery_retry_total: 0,
    delivery_failed_total: 0,
    delivery_dlq_total: 0,
  },
  attemptEventTimestamps: [] as number[],
  retryEventTimestamps: [] as number[],
  dlqEventTimestamps: [] as number[],
  latencyEvents: [] as Array<{ ts: number; latencyMs: number }>,
};

function computePercentile(values: number[], percentile: number): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((Math.max(0, Math.min(100, percentile)) / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index] ?? null;
}

function countValuesSince(timestamps: number[], thresholdMs: number): number {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return 0;
  let index = timestamps.length - 1;
  while (index >= 0 && timestamps[index] >= thresholdMs) {
    index -= 1;
  }
  return timestamps.length - (index + 1);
}

function pruneSortedTimestamps(timestamps: number[], cutoffMs: number): void {
  while (timestamps.length > 0 && timestamps[0] < cutoffMs) {
    timestamps.shift();
  }
}

function prune(cutoffMs: number): void {
  pruneSortedTimestamps(fallbackState.attemptEventTimestamps, cutoffMs);
  pruneSortedTimestamps(fallbackState.retryEventTimestamps, cutoffMs);
  pruneSortedTimestamps(fallbackState.dlqEventTimestamps, cutoffMs);
  while (fallbackState.latencyEvents.length > 0 && fallbackState.latencyEvents[0]?.ts < cutoffMs) {
    fallbackState.latencyEvents.shift();
  }
}

export function recordFallbackDeliveryMetric(metric: DeliveryAttemptMetric): void {
  const nowMs = Number.isFinite(metric.timestampMs) ? Math.floor(metric.timestampMs) : Date.now();
  const cutoffMs = nowMs - METRICS_RETENTION_MS;

  if (metric.status === 'dlq') {
    fallbackState.counters.delivery_dlq_total += 1;
    fallbackState.dlqEventTimestamps.push(nowMs);
    prune(cutoffMs);
    return;
  }

  if (metric.status === 'success') {
    fallbackState.counters.delivery_success_total += 1;
  } else if (metric.status === 'retry') {
    fallbackState.counters.delivery_retry_total += 1;
    fallbackState.retryEventTimestamps.push(nowMs);
  } else if (metric.status === 'failed') {
    fallbackState.counters.delivery_failed_total += 1;
  }

  fallbackState.attemptEventTimestamps.push(nowMs);

  if (typeof metric.latencyMs === 'number' && Number.isFinite(metric.latencyMs) && metric.latencyMs >= 0) {
    fallbackState.latencyEvents.push({
      ts: nowMs,
      latencyMs: Math.floor(metric.latencyMs),
    });
  }

  prune(cutoffMs);
}

export function getFallbackLeadPipelineHealth(nowMs = Date.now()): LeadPipelineHealth {
  const hourAgoMs = nowMs - 60 * 60 * 1000;
  const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - METRICS_RETENTION_MS;
  prune(cutoffMs);

  const attemptsLastHour = countValuesSince(fallbackState.attemptEventTimestamps, hourAgoMs);
  const retriesLastHour = countValuesSince(fallbackState.retryEventTimestamps, hourAgoMs);
  const dlqLastHour = countValuesSince(fallbackState.dlqEventTimestamps, hourAgoMs);
  const dlqLast24Hours = countValuesSince(fallbackState.dlqEventTimestamps, dayAgoMs);
  const latencies = fallbackState.latencyEvents
    .filter((entry) => entry.ts >= hourAgoMs)
    .map((entry) => entry.latencyMs)
    .filter((value) => Number.isFinite(value) && value >= 0);

  return {
    retryRateLastHour: attemptsLastHour > 0 ? retriesLastHour / attemptsLastHour : 0,
    dlqLastHour,
    dlqLast24Hours,
    p95LatencyMs: computePercentile(latencies, 95),
    queueDepth: null,
    counters: {
      ...fallbackState.counters,
    },
    generatedAtMs: nowMs,
  };
}
