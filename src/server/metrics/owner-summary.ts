import { getFunnelRollupFull, resolveFunnelHourRetentionSec, type FunnelRollup } from '~/server/metrics/funnel';

export type OwnerMetricsPeriod = 'today' | 'week';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const IRKUTSK_OFFSET_MS = 8 * HOUR_MS;
const MAX_HOURS = 7 * 24;

type HourCounts = Pick<FunnelRollup, 'totalPageViews' | 'totalOpened' | 'totalSubmitted' | 'dataSource'>;

export function getIrkutskPeriod(nowMs: number, kind: OwnerMetricsPeriod) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('INVALID_METRICS_TIME');
  const local = new Date(nowMs + IRKUTSK_OFFSET_MS);
  const localMidnightUtcMs =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - IRKUTSK_OFFSET_MS;
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const startUtcMs = kind === 'week' ? localMidnightUtcMs - daysSinceMonday * DAY_MS : localMidnightUtcMs;
  return {
    kind,
    timeZone: 'Asia/Irkutsk' as const,
    startUtcMs,
    endUtcMs: nowMs,
    startUtc: new Date(startUtcMs).toISOString(),
    endUtc: new Date(nowMs).toISOString(),
    startLocal: `${new Date(startUtcMs + IRKUTSK_OFFSET_MS).toISOString().slice(0, 19)}+08:00`,
    endLocal: `${new Date(nowMs + IRKUTSK_OFFSET_MS).toISOString().slice(0, 19)}+08:00`,
  };
}

function incompatibleConversion(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    compatible: false as const,
    rate: null,
    reason: 'CONSENT_SCOPE_MISMATCH' as const,
  };
}

function assertCount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('METRICS_COUNT_INVALID');
  return value;
}

export async function getOwnerMetricsSummary(
  kind: OwnerMetricsPeriod,
  options: {
    nowMs?: number;
    retentionSec?: number;
    loadHour?: (bucket: string) => Promise<HourCounts>;
  } = {}
) {
  const nowMs = options.nowMs ?? Date.now();
  const period = getIrkutskPeriod(nowMs, kind);
  const retentionSec = options.retentionSec ?? resolveFunnelHourRetentionSec();
  const hourCount = Math.floor((nowMs - period.startUtcMs) / HOUR_MS) + 1;
  if (hourCount < 1 || hourCount > MAX_HOURS) throw new Error('METRICS_PERIOD_INVALID');

  // A Redis hour expires after its retention window. An expired hour
  // cannot be distinguished from a genuine zero; never present that as exact.
  if (!Number.isFinite(retentionSec) || period.startUtcMs <= nowMs - retentionSec * 1000) {
    return {
      ok: true as const,
      complete: false as const,
      reason: 'HOURLY_RETENTION_INSUFFICIENT' as const,
      period,
      counts: null,
      conversions: null,
      source: 'local_funnel' as const,
      scope: 'trusted_public_routes' as const,
    };
  }

  const loadHour = options.loadHour ?? ((bucket: string) => getFunnelRollupFull({ span: 'hour', bucket }));
  const buckets: string[] = [];
  for (let at = period.startUtcMs; at <= nowMs; at += HOUR_MS) {
    buckets.push(new Date(at).toISOString().slice(0, 13));
  }

  const counts = { consentedPageViews: 0, consentedFormOpens: 0, acceptedLeads: 0 };
  // Bound concurrent Redis reads; the longest supported period is 168 hours.
  for (let index = 0; index < buckets.length; index += 8) {
    const rows = await Promise.all(buckets.slice(index, index + 8).map(loadHour));
    for (const row of rows) {
      if (row.dataSource !== 'redis') throw new Error('METRICS_SOURCE_UNAVAILABLE');
      counts.consentedPageViews += assertCount(row.totalPageViews);
      counts.consentedFormOpens += assertCount(row.totalOpened);
      counts.acceptedLeads += assertCount(row.totalSubmitted);
    }
  }

  return {
    ok: true as const,
    complete: true as const,
    period,
    counts,
    conversions: {
      openedPerPageView: incompatibleConversion(counts.consentedFormOpens, counts.consentedPageViews),
      submittedPerOpened: incompatibleConversion(counts.acceptedLeads, counts.consentedFormOpens),
      submittedPerPageView: incompatibleConversion(counts.acceptedLeads, counts.consentedPageViews),
    },
    source: 'local_funnel' as const,
    scope: 'trusted_public_routes' as const,
    // Historical tracking/consent coverage is not recorded by the existing
    // store. These are exact sums of retained events, not unique visitors or
    // a claim that every site visit and accepted lead was captured.
    historicalCaptureVerified: false as const,
  };
}
