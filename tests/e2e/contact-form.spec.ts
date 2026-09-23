import { expect, test, type Page } from '@playwright/test';
import { mockSmartCaptcha } from './smartcaptcha-mock';

const CONTACTS_PAGE = '/contacts';

async function getLeadForm(page: Page) {
  const form = page.locator('form.lead-contact-form').first();
  await expect(form).toBeVisible();
  return form;
}

test.describe('Contact form', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/track', async (route) => {
      await route.fulfill({ status: 204, body: '' });
    });
  });

  test('shows validation errors and does not submit empty form', async ({ page }) => {
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      await route.continue();
    });

    await page.goto(CONTACTS_PAGE);

    const form = await getLeadForm(page);
    await form.locator('[data-submit-btn]').click();

    await expect(form.locator('[data-error-name]')).toBeVisible();
    await expect(form.locator('[data-error-phone]')).toBeVisible();
    await expect(form.locator('[data-error-consent]')).toBeVisible();
    await expect(form.locator('[data-form-status]')).toContainText('Проверьте корректность полей формы.');
    await expect(form.locator('[data-retry-btn]')).toBeHidden();

    expect(submitCalls).toBe(0);
  });

  test('formats valid Russian numbers and preserves invalid long numbers without truncation', async ({ page }) => {
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      await route.abort();
    });

    await page.goto(CONTACTS_PAGE);
    const form = await getLeadForm(page);
    const phoneInput = form.locator('input[name="phone"]');

    for (const [raw, expected] of [
      ['9', '+7 (9'],
      ['91', '+7 (91'],
      ['912', '+7 (912)'],
      ['9123', '+7 (912) 3'],
      ['9123456789', '+7 (912) 345-67-89'],
      ['89123456789', '+7 (912) 345-67-89'],
      ['79123456789', '+7 (912) 345-67-89'],
    ] as const) {
      await phoneInput.fill(raw);
      await expect(phoneInput).toHaveValue(expected);
    }

    const invalidCases = ['7123456789', '8123456789', '791234567890', '891234567890', '91234567890'];
    for (const raw of invalidCases) {
      await phoneInput.fill(raw);
      await expect(phoneInput).toHaveValue(raw);
      await form.locator('input[name="name"]').fill('CI E2E');
      await form.locator('input[name="consent"]').check();
      await form.locator('[data-submit-btn]').click();
      await expect(form.locator('[data-error-phone]')).toBeVisible();
      await expect(phoneInput).toHaveAttribute('aria-invalid', 'true');
      await expect(form.locator('[data-form-status]')).toContainText('Проверьте корректность полей формы.');
      expect(submitCalls).toBe(0);
      await form.locator('[data-submit-btn]').click();
      await phoneInput.fill(raw);
      await form.locator('input[name="name"]').fill('CI E2E');
      await form.locator('input[name="consent"]').check();
    }
  });

  test('allows submitting after correcting a previously invalid phone number', async ({ page }) => {
    let submitCalls = 0;

    await mockSmartCaptcha(page);

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      expect(payload.phone).toBe('+7 (912) 345-67-89');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, leadId: 'lead-corrected-phone', receivedAt: new Date().toISOString() }),
      });
    });

    await page.goto(CONTACTS_PAGE);
    const form = await getLeadForm(page);
    const phoneInput = form.locator('input[name="phone"]');

    await phoneInput.fill('91234567890');
    await expect(phoneInput).toHaveValue('91234567890');
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="consent"]').check();
    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-error-phone]')).toBeVisible();
    expect(submitCalls).toBe(0);

    await phoneInput.fill('9123456789');
    await expect(phoneInput).toHaveValue('+7 (912) 345-67-89');

    const widgetButton = form.locator('[data-smartcaptcha-widget] button');
    await expect(widgetButton).toBeVisible();
    await widgetButton.click();

    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-success-box]')).toBeVisible();
    expect(submitCalls).toBe(1);
  });

  test('shows retry button on API failure and success state after retry', async ({ page }) => {
    let submitCalls = 0;

    await mockSmartCaptcha(page);

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;

      const payload = route.request().postDataJSON() as Record<string, unknown>;
      expect(payload.name).toBe('CI E2E');
      expect(payload.phone).toBe('+7 (912) 345-67-89');
      expect(payload.consent).toBe(true);

      if (submitCalls === 1) {
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            message: 'Lead delivery failed',
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          leadId: 'lead-ci-e2e',
          receivedAt: new Date().toISOString(),
        }),
      });
    });

    await page.goto(CONTACTS_PAGE);

    const form = await getLeadForm(page);
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('textarea[name="message"]').fill('Нужен расчет кухни');
    await form.locator('input[name="consent"]').check();

    const widgetButton = form.locator('[data-smartcaptcha-widget] button');
    await expect(widgetButton).toBeVisible();
    await widgetButton.click();

    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-form-status]')).toContainText('Lead delivery failed');

    const retryButton = form.locator('[data-retry-btn]');
    await expect(retryButton).toBeVisible();
    await retryButton.click();
    await expect(form.locator('[data-error-smartcaptcha]')).toContainText('Сначала завершите проверку');
    expect(submitCalls).toBe(1);

    await widgetButton.click();
    await retryButton.click();

    await expect(form.locator('[data-success-box]')).toBeVisible();
    await expect(form.locator('[data-form-content]')).toHaveCount(0);
    expect(submitCalls).toBe(2);
  });

  test('reveals anti-bot step after valid phone and blocks submit until challenge is completed', async ({ page }) => {
    let submitCalls = 0;

    await mockSmartCaptcha(page);

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      await route.abort();
    });

    await page.goto(CONTACTS_PAGE);

    const form = await getLeadForm(page);
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="consent"]').check();

    await expect(form.locator('[data-smartcaptcha-step]')).toBeVisible();
    await expect(form.locator('[data-smartcaptcha-widget] button')).toBeVisible();

    await form.locator('[data-submit-btn]').click();

    await expect(form.locator('[data-error-smartcaptcha]')).toContainText('Сначала завершите проверку');
    await expect(form.locator('[data-form-status]')).toContainText('Нужно завершить проверку формы.');
    await expect(form.locator('[data-submit-fallback]')).toBeVisible();
    await expect(form.locator('[data-submit-fallback-call]')).toHaveAttribute('href', 'tel:+79641072613');
    expect(submitCalls).toBe(0);
  });

  test('shows explicit unavailable state and fallback call when SmartCaptcha cannot load', async ({ page }) => {
    let submitCalls = 0;

    await mockSmartCaptcha(page, { scriptUnavailable: true });

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      await route.abort();
    });

    await page.goto(CONTACTS_PAGE);

    const form = await getLeadForm(page);
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="consent"]').check();
    await expect(form.locator('[data-smartcaptcha-step]')).toBeVisible();

    await form.locator('[data-submit-btn]').click();

    await expect(form.locator('[data-error-smartcaptcha]')).toContainText('Не удалось загрузить проверку');
    await expect(form.locator('[data-form-status]')).toContainText('Проверка формы временно недоступна.');
    await expect(form.locator('[data-submit-fallback]')).toBeVisible();
    await expect(form.locator('[data-submit-fallback-call]')).toHaveAttribute('href', 'tel:+79641072613');
    expect(submitCalls).toBe(0);
  });

  test('uses one SmartCaptcha token per attempt and avoids duplicate submission on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSmartCaptcha(page);
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      expect(payload.smartCaptchaToken).toBe('mock-valid-token');

      if (submitCalls === 1) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, code: 'BOT_PROTECTION_FAILED', message: 'Проверка истекла.' }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, leadId: 'mobile-mock-lead', receivedAt: new Date().toISOString() }),
      });
    });

    await page.goto(CONTACTS_PAGE);
    const form = await getLeadForm(page);
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('Mobile Mock');
    await form.locator('input[name="consent"]').check();
    const widgetButton = form.locator('[data-smartcaptcha-widget] button');
    await expect(widgetButton).toBeVisible();
    await widgetButton.click();

    await form.locator('[data-submit-btn]').dblclick();
    await expect(form.locator('[data-error-smartcaptcha]')).toContainText('Проверка истекла.');
    expect(submitCalls).toBe(1);
    const resetCount = await page.evaluate(() =>
      Number((window as Window & { __smartCaptchaMock?: { resetCount: number } }).__smartCaptchaMock?.resetCount || 0)
    );
    expect(resetCount).toBe(1);

    await form.locator('[data-retry-btn]').click();
    expect(submitCalls).toBe(1);
    await widgetButton.click();
    await form.locator('[data-retry-btn]').click();
    await expect(form.locator('[data-success-box]')).toBeVisible();
    expect(submitCalls).toBe(2);
  });
});
