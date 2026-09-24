import { describe, expect, test } from 'vitest';

import { getIrkutskPeriod, getOwnerMetricsSummary } from '../src/server/metrics/owner-summary';

const HOUR = 60 * 60 * 1000;

describe('owner metrics periods in Asia/Irkutsk', () => {
  test('starts today at Irkutsk midnight across the UTC date boundary', () => {
    const now = Date.parse('2026-09-30T18:30:00.000Z'); // 01 October, 02:30 in Irkutsk
    const period = getIrkutskPeriod(now, 'today');
    expect(period.startUtc).toBe('2026-09-30T16:00:00.000Z');
    expect(period.startLocal).toBe('2026-10-01T00:00:00+08:00');
    expect(period.endLocal).toBe('2026-10-01T02:30:00+08:00');
  });

  test('starts the week on Monday at 00:00 Irkutsk time', () => {
    const sunday = Date.parse('2026-09-20T15:59:59.000Z'); // Sunday, 23:59:59 in Irkutsk
    const period = getIrkutskPeriod(sunday, 'week');
    expect(period.startUtc).toBe('2026-09-13T16:00:00.000Z');
    expect(period.startLocal).toBe('2026-09-14T00:00:00+08:00');

    const monday = getIrkutskPeriod(Date.parse('2026-09-20T16:00:00.000Z'), 'week');
    expect(monday.startUtc).toBe('2026-09-20T16:00:00.000Z');
    expect(monday.startLocal).toBe('2026-09-21T00:00:00+08:00');
  });

  test('sums exact UTC hour buckets aligned to an Irkutsk day', async () => {
    const now = Date.parse('2026-10-01T18:30:00.000Z');
    const buckets: string[] = [];
    const report = await getOwnerMetricsSummary('today', {
      nowMs: now,
      retentionSec: 14 * 24 * 60 * 60,
      loadHour: async (bucket) => {
        buckets.push(bucket);
        return { totalPageViews: 2, totalOpened: 1, totalSubmitted: 1, dataSource: 'redis' };
      },
    });

    expect(buckets).toEqual(['2026-10-01T16', '2026-10-01T17', '2026-10-01T18']);
    expect(report.complete).toBe(true);
    if (!report.complete) throw new Error('expected complete report');
    expect(report.counts).toEqual({ consentedPageViews: 6, consentedFormOpens: 3, acceptedLeads: 3 });
    expect(report.conversions.submittedPerOpened).toEqual({
      numerator: 3,
      denominator: 3,
      compatible: false,
      rate: null,
      reason: 'CONSENT_SCOPE_MISMATCH',
    });
    expect(report.conversions.openedPerPageView).toEqual({
      numerator: 3,
      denominator: 6,
      compatible: false,
      rate: null,
      reason: 'CONSENT_SCOPE_MISMATCH',
    });
  });

  test('does not calculate conversion when a lead is accepted without consent-gated openings', async () => {
    const report = await getOwnerMetricsSummary('today', {
      nowMs: Date.parse('2026-09-20T16:00:00.000Z'),
      retentionSec: 14 * 24 * 60 * 60,
      loadHour: async () => ({ totalPageViews: 0, totalOpened: 0, totalSubmitted: 1, dataSource: 'redis' }),
    });
    if (!report.complete) throw new Error('expected complete report');
    expect(report.counts).toEqual({ consentedPageViews: 0, consentedFormOpens: 0, acceptedLeads: 1 });
    expect(report.conversions.submittedPerOpened).toEqual({
      numerator: 1,
      denominator: 0,
      compatible: false,
      rate: null,
      reason: 'CONSENT_SCOPE_MISMATCH',
    });
  });

  test('does not invent percentages for a zero denominator', async () => {
    const now = Date.parse('2026-09-20T16:00:00.000Z');
    const report = await getOwnerMetricsSummary('today', {
      nowMs: now,
      retentionSec: 14 * 24 * 60 * 60,
      loadHour: async () => ({ totalPageViews: 0, totalOpened: 0, totalSubmitted: 0, dataSource: 'redis' }),
    });
    if (!report.complete) throw new Error('expected complete report');
    expect(report.conversions.openedPerPageView).toMatchObject({ compatible: false, rate: null });
    expect(report.conversions.submittedPerOpened.rate).toBeNull();
    expect(report.conversions.submittedPerPageView).toMatchObject({ compatible: false, rate: null });
  });

  test('reports insufficient retention instead of treating expired hours as zero', async () => {
    const now = Date.parse('2026-09-20T10:00:00.000Z');
    let reads = 0;
    const report = await getOwnerMetricsSummary('week', {
      nowMs: now,
      retentionSec: HOUR / 1000,
      loadHour: async () => {
        reads += 1;
        return { totalPageViews: 0, totalOpened: 0, totalSubmitted: 0, dataSource: 'redis' };
      },
    });
    expect(report).toMatchObject({ complete: false, reason: 'HOURLY_RETENTION_INSUFFICIENT', counts: null });
    expect(reads).toBe(0);
  });

  test('fails closed when a bucket is not backed by Redis', async () => {
    await expect(
      getOwnerMetricsSummary('today', {
        nowMs: Date.parse('2026-09-20T16:00:00.000Z'),
        retentionSec: 14 * 24 * 60 * 60,
        loadHour: async () => ({ totalPageViews: 1, totalOpened: 1, totalSubmitted: 1, dataSource: 'memory' }),
      })
    ).rejects.toThrow('METRICS_SOURCE_UNAVAILABLE');
  });
});
