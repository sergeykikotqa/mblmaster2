import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  rollup: vi.fn(),
}));

vi.mock('~/server/admin/auth', () => ({ authorizeAdminRequest: mocks.authorize }));
vi.mock('~/server/metrics/funnel', () => ({ getFunnelRollup: mocks.rollup }));

import { get } from '../src/pages/api/admin/metrics';

const emptyOps = {
  formView: 0,
  formFocus: 0,
  formFirstInputFocus: 0,
  formStart: 0,
  formProgress: 0,
  formPhoneValid: 0,
  formSubmitAttempt: 0,
  formSubmitSuccess: 0,
  formValidationError: 0,
  formSubmitBlocked: 0,
  formAbandoned: 0,
};

describe('admin metrics conversion contract', () => {
  beforeEach(() => {
    mocks.authorize.mockResolvedValue({ ok: true, method: 'session' });
    mocks.rollup.mockResolvedValue({
      span: 'day',
      bucket: '2035-01-12',
      generatedAtMs: Date.UTC(2035, 0, 12, 10, 0, 0),
      dataSource: 'memory',
      totalPageViews: 3,
      totalOpened: 1,
      totalSubmitted: 2,
      conversionRate: null,
      totalOps: emptyOps,
      totalOpsReasons: { validationErrors: {}, submitBlocked: {} },
      entries: [
        {
          pageSlug: '/kuhni',
          city: 'irkutsk',
          district: '',
          service: 'kuhni-na-zakaz',
          pageType: 'service-money',
          pageViews: 3,
          formOpened: 1,
          formSubmitted: 2,
          conversionRate: null,
          ops: emptyOps,
          opsReasons: { validationErrors: {}, submitBlocked: {} },
        },
      ],
    });
  });

  test('preserves raw counters and returns null instead of an incompatible percentage', async () => {
    const response = await get({
      request: new Request('https://mbl.example/api/admin/metrics?span=day'),
      clientAddress: '127.0.0.1',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.report).toEqual({
      pageViews: 3,
      opened: 1,
      submitted: 2,
      openedRate: null,
      submitRate: null,
      conversionRate: null,
    });
    expect(body.conversionRate).toBeNull();
    expect(body.entries[0]).toMatchObject({ formOpened: 1, formSubmitted: 2, conversionRate: null });
  });
});
