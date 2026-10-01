import { expect, test, type Page } from '@playwright/test';

import { mockSmartCaptcha } from './e2e/smartcaptcha-mock';

type TrackEvent = { event?: string };
type ConsentWindow = Window & {
  __analyticsConsent?: {
    getState?: () => string;
    setState?: (state: string) => void;
  };
};

async function observeAnalytics(page: Page) {
  const trackEvents: TrackEvent[] = [];
  const externalRequests: string[] = [];
  const browserErrors: string[] = [];

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: () => false,
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.route('**/api/track', async (route) => {
    try {
      trackEvents.push(JSON.parse(route.request().postData() || '{}') as TrackEvent);
    } catch {
      trackEvents.push({ event: 'INVALID_JSON' });
    }
    await route.fulfill({ status: 204, body: '' });
  });
  await page.route('https://www.googletagmanager.com/**', async (route) => {
    externalRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
  await page.route('https://mc.yandex.ru/**', async (route) => {
    externalRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });

  return { trackEvents, externalRequests, browserErrors };
}

async function waitForClient(page: Page) {
  await page.waitForFunction(() => Boolean((window as { __leadTrackingInit?: boolean }).__leadTrackingInit));
  await page.waitForFunction(() => Boolean((window as { __contactFormsInit?: boolean }).__contactFormsInit));
}

test('unknown consent sends no optional form analytics and loads no external analytics', async ({ page }) => {
  const observed = await observeAnalytics(page);
  await page.goto('/contacts', { waitUntil: 'networkidle' });
  await waitForClient(page);

  const form = page.locator('form.lead-contact-form').first();
  await form.locator('input[name="phone"]').focus();
  await form.locator('input[name="phone"]').fill('9123456789');
  await page.waitForTimeout(300);

  expect(await page.evaluate(() => (window as ConsentWindow).__analyticsConsent?.getState?.())).toBe('unknown');
  expect(observed.trackEvents).toEqual([]);
  expect(observed.externalRequests).toEqual([]);
});

test('denial persists and does not block a successful synthetic lead submission', async ({ page }) => {
  await mockSmartCaptcha(page);
  const observed = await observeAnalytics(page);
  let leadPosts = 0;
  await page.route('**/api/leads', async (route) => {
    leadPosts += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, leadId: 'synthetic-consent-denied-lead' }),
    });
  });

  await page.goto('/contacts', { waitUntil: 'networkidle' });
  await waitForClient(page);
  await page.locator('[data-analytics-consent="decline"]').click();

  const form = page.locator('form.lead-contact-form').first();
  await form.locator('input[name="phone"]').fill('9123456789');
  await expect(form.locator('input[name="name"], textarea')).toHaveCount(0);
  await form.locator('input[name="consent"]').check();
  await form.locator('[data-smartcaptcha-widget] button').click();
  await form.locator('[data-submit-btn]').click();
  await expect(form.locator('[data-success-box]')).toBeVisible();

  expect(leadPosts).toBe(1);
  expect(observed.trackEvents).toEqual([]);
  expect(observed.externalRequests).toEqual([]);

  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.evaluate(() => (window as ConsentWindow).__analyticsConsent?.getState?.())).toBe('denied');
  expect(observed.externalRequests).toEqual([]);
});

test('grant loads bundled Web Vitals and external analytics, persists, and can be revoked', async ({ page }) => {
  const observed = await observeAnalytics(page);
  await page.goto('/contacts?utm_content=PRIVATE_QUERY_SENTINEL', { waitUntil: 'networkidle' });
  await waitForClient(page);
  await page.locator('[data-analytics-consent="accept"]').click();

  await expect.poll(() => observed.externalRequests.length).toBe(1);
  const form = page.locator('form.lead-contact-form').first();
  await form.locator('input[name="phone"]').focus();
  await form.locator('input[name="phone"]').fill('9123456789');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect.poll(() => observed.trackEvents.some((entry) => entry.event === 'web_vital')).toBe(true);
  expect(observed.trackEvents.some((entry) => entry.event === 'form_focus')).toBe(true);
  expect(JSON.stringify(observed.trackEvents)).not.toContain('9123456789');
  expect(JSON.stringify(observed.trackEvents)).not.toContain('PRIVATE_QUERY_SENTINEL');
  for (const entry of observed.trackEvents) {
    expect(JSON.stringify(entry)).not.toMatch(/"open_id"|"opened_at"/);
  }
  const publicPhone = await page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('a[href^="tel:"]');
    if (!link) throw new Error('Call CTA is required for privacy regression');
    const href = link.getAttribute('href') || '';
    link.addEventListener('click', (event) => event.preventDefault(), { once: true });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return href.replace(/^tel:/, '');
  });
  await expect.poll(() => observed.trackEvents.some((entry) => entry.event === 'call_click')).toBe(true);
  const calls = observed.trackEvents.filter((entry) => entry.event === 'cta_click' || entry.event === 'call_click');
  expect(JSON.stringify(calls)).not.toContain(publicPhone);
  expect(JSON.stringify(calls).replace(/[^0-9]/g, '')).not.toContain(publicPhone.replace(/[^0-9]/g, ''));
  const metrikaCalls = await page.evaluate(() => {
    const ym = (window as Window & { ym?: { a?: IArguments[] } }).ym;
    return (ym?.a || []).map((entry) => Array.from(entry));
  });
  const init = metrikaCalls.find((entry) => entry[1] === 'init');
  expect(init?.[2]).toMatchObject({ webvisor: false, clickmap: false, trackLinks: false, defer: true });
  expect(JSON.stringify(metrikaCalls)).not.toContain('9123456789');
  expect(JSON.stringify(metrikaCalls)).not.toContain('PRIVATE_QUERY_SENTINEL');
  expect(observed.browserErrors.filter((message) => /web-vitals|module specifier/i.test(message))).toEqual([]);

  await page.evaluate(() => (window as ConsentWindow).__analyticsConsent?.setState?.('denied'));
  await page.evaluate(() => (window as ConsentWindow).__analyticsConsent?.setState?.('granted'));
  await page.waitForTimeout(100);
  expect(observed.externalRequests.filter((url) => url.includes('googletagmanager.com'))).toHaveLength(0);

  observed.externalRequests.length = 0;
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.evaluate(() => (window as ConsentWindow).__analyticsConsent?.getState?.())).toBe('granted');
  await expect.poll(() => observed.externalRequests.length).toBe(1);

  await page.evaluate(() => (window as ConsentWindow).__analyticsConsent?.setState?.('denied'));
  const countAfterRevocation = observed.trackEvents.length;
  await page.locator('form.lead-contact-form input[name="phone"]').first().focus();
  await page.locator('form.lead-contact-form input[name="phone"]').first().fill('9000000000');
  await page.waitForTimeout(300);
  expect(observed.trackEvents).toHaveLength(countAfterRevocation);
});
