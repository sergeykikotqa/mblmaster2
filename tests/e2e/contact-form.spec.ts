import { expect, test, type Page } from '@playwright/test';

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

  test('shows retry button on API failure and success state after retry', async ({ page }) => {
    let submitCalls = 0;

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

    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-form-status]')).toContainText('Lead delivery failed');

    const retryButton = form.locator('[data-retry-btn]');
    await expect(retryButton).toBeVisible();
    await retryButton.click();

    await expect(form.locator('[data-success-box]')).toBeVisible();
    await expect(form.locator('[data-form-content]')).toHaveCount(0);
    expect(submitCalls).toBe(2);
  });

  test('reveals anti-bot step after valid phone and blocks submit until challenge is completed', async ({ page }) => {
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      await route.abort();
    });

    await page.goto(CONTACTS_PAGE);

    const form = await getLeadForm(page);
    await form.evaluate((node) => {
      (node as HTMLFormElement).dataset.turnstileTestMode = 'required';
      (window as Window & { turnstile?: Record<string, unknown> }).turnstile = {};
    });

    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="consent"]').check();

    await expect(form.locator('[data-turnstile-step]')).toBeVisible();

    await form.locator('[data-submit-btn]').click();

    await expect(form.locator('[data-error-turnstile]')).toContainText('Сначала завершите проверку');
    await expect(form.locator('[data-form-status]')).toContainText('Нужно завершить проверку формы.');
    await expect(form.locator('[data-submit-fallback]')).toBeVisible();
    await expect(form.locator('[data-submit-fallback-call]')).toHaveAttribute('href', 'tel:+79641072613');
    expect(submitCalls).toBe(0);
  });

  test('shows explicit unavailable state and fallback call when turnstile cannot load', async ({ page }) => {
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      await route.abort();
    });

    await page.goto(CONTACTS_PAGE);

    const form = await getLeadForm(page);
    await form.evaluate((node) => {
      delete (window as Window & { turnstile?: unknown }).turnstile;
      (node as HTMLFormElement).dataset.turnstileTestMode = 'unavailable';
    });

    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="consent"]').check();
    await expect(form.locator('[data-turnstile-step]')).toBeVisible();

    await form.locator('[data-submit-btn]').click();

    await expect(form.locator('[data-error-turnstile]')).toContainText('Не удалось загрузить проверку');
    await expect(form.locator('[data-form-status]')).toContainText('Проверка формы временно недоступна.');
    await expect(form.locator('[data-submit-fallback]')).toBeVisible();
    await expect(form.locator('[data-submit-fallback-call]')).toHaveAttribute('href', 'tel:+79641072613');
    expect(submitCalls).toBe(0);
  });
});
