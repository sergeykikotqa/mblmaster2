import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { post as postTrack } from '../src/pages/api/track';
import funnelPublicPages from '../data/funnel-public-pages.json';
import services from '../data/services.json';
import { getMetricsServiceFilterOptions } from '../src/lib/admin-metrics-filters';
import { getFunnelRollupFull, recordFunnelMetric, resolveFunnelDimensions } from '../src/server/metrics/funnel';

const ORIGINAL_ENV = {
  REDIS_URL: process.env.REDIS_URL,
};

beforeEach(() => {
  delete process.env.REDIS_URL;
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_ENV.REDIS_URL) {
    process.env.REDIS_URL = ORIGINAL_ENV.REDIS_URL;
  } else {
    delete process.env.REDIS_URL;
  }
});

test('records ops funnel counters and reason buckets without breaking conversion totals', async () => {
  const timestampMs = Date.UTC(2035, 0, 3, 9, 30, 0);
  const bucket = '2035-01-03';

  await recordFunnelMetric({ eventName: 'page_view', pageSlug: '/kuhni', timestampMs });
  await recordFunnelMetric({ eventName: 'form_opened', pageSlug: '/kuhni', timestampMs });
  await recordFunnelMetric({ eventName: 'form_phone_valid', pageSlug: '/kuhni', timestampMs });
  await recordFunnelMetric({ eventName: 'form_submit_attempt', pageSlug: '/kuhni', timestampMs });
  await recordFunnelMetric({
    eventName: 'form_validation_error',
    pageSlug: '/kuhni',
    timestampMs,
    reason: 'phone',
  });
  await recordFunnelMetric({
    eventName: 'form_submit_blocked',
    pageSlug: '/kuhni',
    timestampMs,
    reason: 'smartcaptcha_required',
  });
  await recordFunnelMetric({ eventName: 'form_submitted', pageSlug: '/kuhni', timestampMs });

  const rollup = await getFunnelRollupFull({
    span: 'day',
    bucket,
    pageSlug: '/kuhni',
  });

  expect(rollup.totalPageViews).toBeGreaterThanOrEqual(1);
  expect(rollup.totalOpened).toBeGreaterThanOrEqual(1);
  expect(rollup.totalSubmitted).toBeGreaterThanOrEqual(1);
  expect(rollup.totalOps.formPhoneValid).toBeGreaterThanOrEqual(1);
  expect(rollup.totalOps.formSubmitAttempt).toBeGreaterThanOrEqual(1);
  expect(rollup.totalOps.formValidationError).toBeGreaterThanOrEqual(1);
  expect(rollup.totalOps.formSubmitBlocked).toBeGreaterThanOrEqual(1);
  expect(rollup.totalOpsReasons.validationErrors.phone).toBeGreaterThanOrEqual(1);
  expect(rollup.totalOpsReasons.submitBlocked.smartcaptcha_required).toBeGreaterThanOrEqual(1);

  const kuhniEntry = rollup.entries.find((entry) => entry.pageSlug === '/kuhni');
  expect(kuhniEntry).toBeTruthy();
  expect(kuhniEntry?.ops.formPhoneValid).toBeGreaterThanOrEqual(1);
  expect(kuhniEntry?.opsReasons.validationErrors.phone).toBeGreaterThanOrEqual(1);
});

test('api/track persists ops funnel events with reasons into storage', async () => {
  const sentAt = new Date(Date.UTC(2035, 0, 4, 12, 0, 0)).toISOString();
  vi.useFakeTimers();
  vi.setSystemTime(sentAt);
  const request = new Request('https://example.com/api/track', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'vitest',
    },
    body: JSON.stringify({
      event: 'form_submit_blocked',
      page: '/kuhni',
      sentAt,
      payload: {
        city: 'irkutsk',
        service: 'kuhni-na-zakaz',
        page_slug: '/kuhni',
        lead_page_type: 'service-money',
        reason: 'smartcaptcha_unavailable',
      },
    }),
  });

  const response = await postTrack({ request });
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.success).toBe(true);
  expect(body.funnelMetricRecorded).toBe(true);

  const rollup = await getFunnelRollupFull({
    span: 'day',
    bucket: '2035-01-04',
    pageSlug: '/kuhni',
  });

  expect(rollup.totalOps.formSubmitBlocked).toBeGreaterThanOrEqual(1);
  expect(rollup.totalOpsReasons.submitBlocked.smartcaptcha_unavailable).toBeGreaterThanOrEqual(1);
});

test('api/track assigns funnel buckets from server receive time instead of arbitrary client sentAt', async () => {
  const receivedAt = new Date(Date.UTC(2042, 5, 15, 1, 30, 0));
  vi.useFakeTimers();
  vi.setSystemTime(receivedAt);

  const clientDates = [
    receivedAt.toISOString(),
    new Date(Date.UTC(2042, 5, 14, 17, 30, 0)).toISOString(),
    new Date(Date.UTC(2001, 0, 1, 0, 0, 0)).toISOString(),
    new Date(Date.UTC(2099, 11, 31, 23, 59, 59)).toISOString(),
  ];

  for (const sentAt of clientDates) {
    const response = await postTrack({
      request: new Request('https://example.com/api/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
        body: JSON.stringify({
          event: 'page_view',
          page: '/contacts',
          sentAt,
          payload: { page_slug: '/contacts' },
        }),
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, funnelMetricRecorded: true });
  }

  const serverBucket = await getFunnelRollupFull({ span: 'day', bucket: '2042-06-15', pageSlug: '/contacts' });
  expect(serverBucket.totalPageViews).toBe(4);

  for (const clientBucket of ['2042-06-14', '2001-01-01', '2099-12-31']) {
    const rollup = await getFunnelRollupFull({ span: 'day', bucket: clientBucket, pageSlug: '/contacts' });
    expect(rollup.totalPageViews).toBe(0);
  }
});

test.each([
  ['/', 'homepage', '', 'irkutsk'],
  ['/contacts', 'site', '', 'irkutsk'],
] as const)('records conversion events for trusted public route %s', async (pageSlug, pageType, service, city) => {
  const timestampMs = Date.UTC(2035, 0, 5, 10, 0, 0);
  const bucket = '2035-01-05';
  const sentAt = new Date(timestampMs).toISOString();
  vi.useFakeTimers();
  vi.setSystemTime(sentAt);

  for (const event of ['page_view', 'form_opened']) {
    const response = await postTrack({
      request: new Request('https://example.com/api/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
        body: JSON.stringify({
          event,
          page: `${pageSlug}?ignored=query`,
          sentAt,
          payload: { page_slug: pageSlug, service: 'untrusted-service', lead_page_type: 'untrusted-type' },
        }),
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, funnelMetricRecorded: true });
  }
  await recordFunnelMetric({ eventName: 'form_submitted', pageSlug, timestampMs });

  const rollup = await getFunnelRollupFull({ span: 'day', bucket, pageSlug });
  expect(rollup).toMatchObject({ totalPageViews: 1, totalOpened: 1, totalSubmitted: 1 });
  expect(rollup.entries).toContainEqual(
    expect.objectContaining({ pageSlug, pageType, service, city, pageViews: 1, formOpened: 1, formSubmitted: 1 })
  );
});

test('records a published project with canonical service dimensions', async () => {
  const project = funnelPublicPages.find((page) => page.pageType === 'project');
  expect(project).toBeTruthy();
  const timestampMs = Date.UTC(2035, 0, 6, 10, 0, 0);
  const bucket = '2035-01-06';

  for (const eventName of ['page_view', 'form_opened', 'form_submitted'] as const) {
    await recordFunnelMetric({ eventName, pageSlug: project!.pageSlug, timestampMs });
  }

  const rollup = await getFunnelRollupFull({ span: 'day', bucket, pageSlug: project!.pageSlug });
  expect(rollup).toMatchObject({ totalPageViews: 1, totalOpened: 1, totalSubmitted: 1 });
  expect(rollup.entries[0]).toMatchObject({
    pageSlug: project!.pageSlug,
    pageType: 'project',
    service: project!.service,
    city: project!.city,
  });
});

test('keeps existing service-page dimensions and normalizes trailing slash and query strings', () => {
  expect(
    resolveFunnelDimensions({
      pageSlug: '/kuhni/?phone=not-a-dimension',
      city: 'untrusted-city',
      service: 'shkafy',
      pageType: 'untrusted-type',
    })
  ).toEqual({
    pageSlug: '/kuhni',
    city: 'irkutsk',
    district: '',
    service: 'kuhni-na-zakaz',
    pageType: 'service-money',
  });
  expect(resolveFunnelDimensions({ pageSlug: '/?phone=not-a-dimension' })?.pageSlug).toBe('/');
  expect(resolveFunnelDimensions({ pageSlug: '/contacts/?phone=not-a-dimension' })?.pageSlug).toBe('/contacts');
});

test.each(['/unknown', '/admin', '/api/leads', '/projects/uglovaya-garderobnaya-s-dveryami-kupe-irkutsk'])(
  'rejects untrusted, technical or unpublished route %s',
  (pageSlug) => {
    expect(resolveFunnelDimensions({ pageSlug })).toBeNull();
  }
);

test('does not add rejected routes to aggregate totals', async () => {
  const timestampMs = Date.UTC(2035, 0, 8, 10, 0, 0);
  const bucket = '2035-01-08';
  for (const pageSlug of [
    '/unknown',
    '/admin',
    '/api/leads',
    '/projects/uglovaya-garderobnaya-s-dveryami-kupe-irkutsk',
  ]) {
    await recordFunnelMetric({ eventName: 'page_view', pageSlug, timestampMs });
  }

  const rollup = await getFunnelRollupFull({ span: 'day', bucket });
  expect(rollup.totalPageViews).toBe(0);
  expect(rollup.entries).toHaveLength(0);
});

test('filters rollups by canonical service ids without mixing path segments', async () => {
  const timestampMs = Date.UTC(2035, 0, 7, 10, 0, 0);
  const bucket = '2035-01-07';
  const expectedServices = ['kuhni-na-zakaz', 'shkafy-kupe', 'garderobnye'];
  expect(services.map((service) => service.id)).toEqual(expectedServices);
  expect(getMetricsServiceFilterOptions()).toEqual([
    { value: 'kuhni-na-zakaz', label: 'Кухни на заказ' },
    { value: 'shkafy-kupe', label: 'Шкафы-купе' },
    { value: 'garderobnye', label: 'Гардеробные' },
  ]);

  for (const page of funnelPublicPages.filter((item) => item.pageType === 'service-money')) {
    await recordFunnelMetric({ eventName: 'page_view', pageSlug: page.pageSlug, timestampMs });
  }

  const all = await getFunnelRollupFull({ span: 'day', bucket });
  expect(all.totalPageViews).toBe(3);

  for (const service of expectedServices) {
    const filtered = await getFunnelRollupFull({ span: 'day', bucket, service });
    expect(filtered.totalPageViews).toBe(1);
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0]?.service).toBe(service);
  }

  for (const legacyPathSegment of ['kuhni', 'shkafy']) {
    const filtered = await getFunnelRollupFull({ span: 'day', bucket, service: legacyPathSegment });
    expect(filtered.totalPageViews).toBe(0);
    expect(filtered.entries).toHaveLength(0);
  }
});
