import { afterEach, beforeEach, expect, test } from 'vitest';

import { post as postTrack } from '../src/pages/api/track';
import { getFunnelRollupFull, recordFunnelMetric } from '../src/server/metrics/funnel';

const ORIGINAL_ENV = {
  REDIS_URL: process.env.REDIS_URL,
};

beforeEach(() => {
  delete process.env.REDIS_URL;
});

afterEach(() => {
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
    reason: 'turnstile_required',
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
  expect(rollup.totalOpsReasons.submitBlocked.turnstile_required).toBeGreaterThanOrEqual(1);

  const kuhniEntry = rollup.entries.find((entry) => entry.pageSlug === '/kuhni');
  expect(kuhniEntry).toBeTruthy();
  expect(kuhniEntry?.ops.formPhoneValid).toBeGreaterThanOrEqual(1);
  expect(kuhniEntry?.opsReasons.validationErrors.phone).toBeGreaterThanOrEqual(1);
});

test('api/track persists ops funnel events with reasons into storage', async () => {
  const sentAt = new Date(Date.UTC(2035, 0, 4, 12, 0, 0)).toISOString();
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
        reason: 'turnstile_unavailable',
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
  expect(rollup.totalOpsReasons.submitBlocked.turnstile_unavailable).toBeGreaterThanOrEqual(1);
});
