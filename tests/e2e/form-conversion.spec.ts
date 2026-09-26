import { expect, test } from '@playwright/test';

import { mockSmartCaptcha } from './smartcaptcha-mock';

test.describe('Form conversion flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/track', async (route) => {
      await route.fulfill({ status: 204, body: '' });
    });
  });

  test('money-page CTA moves focus into contact form and submits with minimal data', async ({ page }) => {
    await mockSmartCaptcha(page);
    await page.route('**/api/leads', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          leadId: 'lead-form-conversion-e2e',
          receivedAt: new Date().toISOString(),
        }),
      });
    });

    await page.goto('/kuhni');
    await page.waitForFunction(() => Boolean((window as { __leadTrackingInit?: boolean }).__leadTrackingInit));
    await page.waitForFunction(() => Boolean((window as { __contactFormsInit?: boolean }).__contactFormsInit));

    await page.locator('[data-cta="service_hero_primary"]').first().click();
    await expect(page).toHaveURL(/#contact$/);

    const form = page.locator('form.lead-contact-form').first();
    await expect(form).toBeVisible();

    const firstInput = form.locator('input[name="phone"]');
    const firstInputBoxBeforeFocus = await firstInput.boundingBox();
    expect(firstInputBoxBeforeFocus).not.toBeNull();

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const active = document.activeElement;
          return active instanceof HTMLInputElement ? active.name : '';
        })
      )
      .toBe('phone');

    const stickyVisibleOnFocus = await page.locator('#money-page-sticky-cta').evaluate((node) => {
      const element = node as HTMLElement;
      const styles = window.getComputedStyle(element);
      return !element.hidden && element.dataset.visible === 'true' && styles.display !== 'none';
    });
    expect(stickyVisibleOnFocus).toBe(false);

    await expect(firstInput).toBeInViewport();

    await firstInput.fill('9123456789');
    await form.locator('input[name="name"]').fill('Form E2E');
    await form.locator('input[name="consent"]').check();
    await form.locator('[data-smartcaptcha-widget] button').click();
    const submitButton = form.locator('[data-submit-btn]');
    await expect(submitButton).toBeEnabled();
    await expect(submitButton).toBeInViewport();

    await submitButton.click();

    await expect(form.locator('[data-success-box]')).toBeVisible();

    const dataLayerEvents = await page.evaluate(() => {
      const w = window as unknown as { dataLayer?: Array<{ event?: string }> };
      return Array.isArray(w.dataLayer) ? w.dataLayer.map((entry) => entry?.event || '') : [];
    });

    expect(dataLayerEvents).toContain('cta_click');
    expect(dataLayerEvents).toContain('form_view');
    expect(dataLayerEvents).toContain('form_opened');
    expect(dataLayerEvents).toContain('form_focus');
    expect(dataLayerEvents).toContain('form_first_input_focus');
    expect(dataLayerEvents).toContain('form_start');
    expect(dataLayerEvents).toContain('form_progress');
    expect(dataLayerEvents).toContain('form_phone_valid');
    expect(dataLayerEvents).toContain('form_submit_attempt');
    expect(dataLayerEvents).toContain('form_submit_success');
  });
});
