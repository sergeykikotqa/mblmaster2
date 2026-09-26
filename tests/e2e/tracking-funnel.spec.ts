import { expect, test, type Page } from '@playwright/test';
import { mockSmartCaptcha } from './smartcaptcha-mock';

const CANONICAL_FORM_EVENTS = [
  'form_view',
  'form_focus',
  'form_start',
  'form_progress',
  'form_phone_valid',
  'form_submit_attempt',
  'form_submit_success',
] as const;

async function readEvents(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { dataLayer?: Array<{ event?: string }> };
    return Array.isArray(w.dataLayer) ? w.dataLayer.map((entry) => entry?.event || '') : [];
  });
}

async function readDataLayer(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { dataLayer?: Array<Record<string, unknown>> };
    return Array.isArray(w.dataLayer) ? w.dataLayer : [];
  });
}

test.describe('Lead tracking funnel', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/track', async (route) => {
      await route.fulfill({ status: 204, body: '' });
    });
  });

  test('emits canonical form funnel events in order for a successful money-page submit', async ({ page }) => {
    await mockSmartCaptcha(page);
    await page.route('**/api/leads', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          leadId: 'lead-tracking-funnel-e2e',
          receivedAt: new Date().toISOString(),
        }),
      });
    });

    await page.goto('/kuhni');
    await page.waitForFunction(() => Boolean((window as { __leadTrackingInit?: boolean }).__leadTrackingInit));
    await page.waitForFunction(() => Boolean((window as { __contactFormsInit?: boolean }).__contactFormsInit));
    await page.evaluate(() => {
      (window as unknown as { dataLayer?: Array<{ event?: string }> }).dataLayer = [];
    });

    await page.locator('[data-cta="service_hero_primary"]').first().click();
    await expect(page).toHaveURL(/#contact$/);

    const form = page.locator('form.lead-contact-form').first();
    const phoneInput = form.locator('input[name="phone"]');
    await expect(form).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const active = document.activeElement;
          return active instanceof HTMLInputElement ? active.name : '';
        })
      )
      .toBe('phone');

    let dataLayerEvents = await readEvents(page);
    expect(dataLayerEvents).toContain('cta_click');
    expect(dataLayerEvents).toContain('form_opened');
    expect(dataLayerEvents).toContain('form_view');
    expect(dataLayerEvents).toContain('form_focus');
    expect(dataLayerEvents).not.toContain('form_start');

    await phoneInput.fill('9123456789');
    await form.locator('input[name="name"]').fill('Tracking Funnel');
    await form.locator('input[name="consent"]').check();
    const widgetButton = form.locator('[data-smartcaptcha-widget] button');
    await expect(widgetButton).toBeVisible();
    await widgetButton.click();
    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-success-box]')).toBeVisible();

    dataLayerEvents = await readEvents(page);
    const canonicalEvents = dataLayerEvents.filter((event) =>
      CANONICAL_FORM_EVENTS.includes(event as (typeof CANONICAL_FORM_EVENTS)[number])
    );
    expect(canonicalEvents).toEqual([...CANONICAL_FORM_EVENTS]);
  });

  test('does not emit form_start when the user only focuses the form', async ({ page }) => {
    await page.goto('/kuhni');
    await page.waitForFunction(() => Boolean((window as { __leadTrackingInit?: boolean }).__leadTrackingInit));
    await page.waitForFunction(() => Boolean((window as { __contactFormsInit?: boolean }).__contactFormsInit));
    await page.evaluate(() => {
      (window as unknown as { dataLayer?: Array<{ event?: string }> }).dataLayer = [];
    });

    await page.locator('[data-cta="service_hero_primary"]').first().click();
    await expect(page).toHaveURL(/#contact$/);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const active = document.activeElement;
          return active instanceof HTMLInputElement ? active.name : '';
        })
      )
      .toBe('phone');

    const dataLayerEvents = await readEvents(page);
    expect(dataLayerEvents).toContain('form_focus');
    expect(dataLayerEvents).not.toContain('form_start');
    expect(dataLayerEvents).not.toContain('form_phone_valid');
  });

  test('emits submit_blocked with smartcaptcha_required when anti-bot step is incomplete', async ({ page }) => {
    await mockSmartCaptcha(page);
    await page.goto('/contacts');
    await page.waitForFunction(() => Boolean((window as { __leadTrackingInit?: boolean }).__leadTrackingInit));
    await page.waitForFunction(() => Boolean((window as { __contactFormsInit?: boolean }).__contactFormsInit));
    await page.evaluate(() => {
      (window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer = [];
    });

    const form = page.locator('form.lead-contact-form').first();
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('Blocked Case');
    await form.locator('input[name="consent"]').check();
    await form.locator('[data-submit-btn]').click();

    const entries = await readDataLayer(page);
    const submitAttemptIndex = entries.findIndex((entry) => entry.event === 'form_submit_attempt');
    const blockedEntry = entries.find((entry) => entry.event === 'form_submit_blocked');

    expect(submitAttemptIndex).toBeGreaterThan(-1);
    expect(blockedEntry).toBeTruthy();
    expect(String(blockedEntry?.reason || '')).toBe('smartcaptcha_required');
    expect(entries.findIndex((entry) => entry.event === 'form_submit_blocked')).toBeGreaterThan(submitAttemptIndex);
  });

  test('emits validation_error reasons for empty submit instead of silently failing', async ({ page }) => {
    await page.goto('/contacts');
    await page.waitForFunction(() => Boolean((window as { __leadTrackingInit?: boolean }).__leadTrackingInit));
    await page.waitForFunction(() => Boolean((window as { __contactFormsInit?: boolean }).__contactFormsInit));
    await page.evaluate(() => {
      (window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer = [];
    });

    const form = page.locator('form.lead-contact-form').first();
    await form.locator('[data-submit-btn]').click();

    const entries = await readDataLayer(page);
    const submitAttemptIndex = entries.findIndex((entry) => entry.event === 'form_submit_attempt');
    const validationReasons = entries
      .filter((entry) => entry.event === 'form_validation_error')
      .map((entry) => String(entry.reason || ''));

    expect(submitAttemptIndex).toBeGreaterThan(-1);
    expect(validationReasons).toEqual(expect.arrayContaining(['phone', 'name', 'consent']));
  });
});
