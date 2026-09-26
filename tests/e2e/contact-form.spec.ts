import { expect, test, type Page } from '@playwright/test';
import { mockSmartCaptcha } from './smartcaptcha-mock';

const CONTACTS_PAGE = '/contacts';

async function getLeadForm(page: Page) {
  const form = page.locator('form.lead-contact-form').first();
  await expect(form).toBeVisible();
  return form;
}

async function shortenSubmitTimeout(page: Page) {
  await page.addInitScript(() => {
    const realSetTimeout = window.setTimeout.bind(window);
    let shortenedSubmissionDeadlines = 0;

    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof delay === 'number' && delay === 20000 && shortenedSubmissionDeadlines === 0) {
        shortenedSubmissionDeadlines += 1;
        return realSetTimeout(callback, 50, ...args);
      }
      return realSetTimeout(callback, delay as number, ...args);
    }) as typeof window.setTimeout;
  });
}

async function allowLeadRequestToFinishAfterClientAbort(page: Page) {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      if (!requestUrl.includes('/api/leads') || !init) {
        return realFetch(input, init);
      }

      const detachedInit = { ...init, signal: undefined };
      return realFetch(input, detachedInit);
    }) as typeof window.fetch;
  });
}

async function delayLeadResponseBody(page: Page) {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      const requestUrl = input instanceof Request ? input.url : String(input);
      if (!requestUrl.includes('/api/leads')) return response;

      return {
        ok: response.ok,
        status: response.status,
        json: async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 180));
          return response.json();
        },
      } as Response;
    }) as typeof window.fetch;
  });
}

test.describe('Contact form', () => {
  test('shows no-JS fallback and blocks form submission when JavaScript is disabled', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      await route.abort();
    });

    await page.goto(CONTACTS_PAGE);

    const fallback = page.locator('[data-nojs-fallback]').first();
    await expect(fallback).toBeVisible();
    await expect(fallback.locator('[data-nojs-message]')).toContainText('Для отправки заявки нужен JavaScript.');
    await expect(page.locator('form.lead-contact-form')).toHaveCount(1);
    await expect(page.locator('form.lead-contact-form')).not.toBeVisible();

    const phoneLink = fallback.locator('[data-nojs-phone-link]');
    await expect(phoneLink).toHaveAttribute('href', /^tel:/);
    await expect(phoneLink).toContainText('+7');

    await page.keyboard.press('Enter');
    expect(submitCalls).toBe(0);
    await context.close();
  });

  test('shows no-JS fallback on a service page without exposing the normal form', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      await route.abort();
    });

    await page.goto('/kuhni');

    const form = page.locator('form.lead-contact-form').first();
    await expect(form).toHaveCount(1);
    await expect(form).not.toBeVisible();

    const fallback = page.locator('[data-nojs-fallback]').first();
    await expect(fallback).toBeVisible();
    await expect(fallback.locator('[data-nojs-message]')).toContainText('Для отправки заявки нужен JavaScript.');

    const phoneLink = fallback.locator('[data-nojs-phone-link]');
    await expect(phoneLink).toHaveAttribute('href', /^tel:/);
    await expect(phoneLink).toContainText('+7');

    await page.keyboard.press('Enter');
    expect(submitCalls).toBe(0);
    await context.close();
  });

  test('recovers from an ambiguous timeout, retries manually with the same key, and ignores a late response', async ({
    page,
  }) => {
    await mockSmartCaptcha(page);
    await shortenSubmitTimeout(page);
    await allowLeadRequestToFinishAfterClientAbort(page);

    const requestKeys: string[] = [];
    const captchaTokens: string[] = [];
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      const key = route.request().headers()['x-idempotency-key'] || '';
      requestKeys.push(key);
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      captchaTokens.push(String(payload.smartCaptchaToken || ''));
      if (submitCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 240));
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: 'Late response from the first attempt' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, leadId: 'lead-timeout-retry', receivedAt: new Date().toISOString() }),
      });
    });

    await page.goto(CONTACTS_PAGE);
    const form = await getLeadForm(page);
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="consent"]').check();
    await form.evaluate((formElement) => {
      for (const [name, value] of [
        ['project_variant', 'corner'],
        ['project_material', 'oak'],
      ]) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        input.dataset.extraField = name;
        formElement.append(input);
      }
    });
    await form.locator('[data-smartcaptcha-widget] button').click();

    await form.locator('[data-submit-btn]').click();

    await expect(form.locator('[data-form-status]')).toContainText('Не удалось получить подтверждение отправки');
    await expect(form.locator('[data-submit-fallback]')).toBeVisible();
    await expect(form.locator('[data-submit-fallback-call]')).toHaveAttribute('href', 'tel:+79641072613');
    await expect(form.locator('[data-retry-btn]')).toBeVisible();
    await expect(form.locator('[data-submit-btn]')).toBeEnabled();
    await expect(form.locator('[data-btn-text]')).not.toHaveText('Отправка...');

    await page.waitForTimeout(80);
    expect(submitCalls).toBe(1);

    await form.locator('[data-retry-btn]').click();
    await expect(form.locator('[data-error-smartcaptcha]')).toContainText('Сначала завершите проверку');
    expect(submitCalls).toBe(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await form.evaluate((formElement) => {
      const extraFields = Array.from(formElement.querySelectorAll('[data-extra-field]')).reverse();
      extraFields.forEach((field) => formElement.append(field));
    });
    await page.evaluate(() => {
      (window as Window & { __smartCaptchaMock?: { issue(value?: string): void } }).__smartCaptchaMock?.issue(
        'mock-retry-token'
      );
    });
    await form.locator('[data-retry-btn]').click();
    await expect(form.locator('[data-success-box]')).toBeVisible();
    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(captchaTokens).toEqual(['mock-valid-token', 'mock-retry-token']);

    await page.waitForTimeout(260);
    await expect(form.locator('[data-success-box]')).toBeVisible();
    await expect(form.locator('[data-form-status]')).toBeHidden();
  });

  test('creates a fresh idempotency key when the user changes the form after a timeout', async ({ page }) => {
    await mockSmartCaptcha(page);
    await shortenSubmitTimeout(page);
    await allowLeadRequestToFinishAfterClientAbort(page);

    const requestKeys: string[] = [];
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      const key = route.request().headers()['x-idempotency-key'] || '';
      requestKeys.push(key);
      if (submitCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, leadId: 'lead-timeout-new-key', receivedAt: new Date().toISOString() }),
      });
    });

    await page.goto(CONTACTS_PAGE);
    const form = await getLeadForm(page);
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="consent"]').check();
    await form.locator('[data-smartcaptcha-widget] button').click();

    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-form-status]')).toContainText('Не удалось получить подтверждение отправки');

    await form.locator('textarea[name="message"]').fill('Обновлённое описание после тайм-аута');
    await page.evaluate(() => {
      (window as Window & { __smartCaptchaMock?: { issue(value?: string): void } }).__smartCaptchaMock?.issue(
        'mock-changed-payload-token'
      );
    });
    await form.locator('[data-retry-btn]').click();
    await expect(form.locator('[data-success-box]')).toBeVisible();
    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[1]).not.toBe(requestKeys[0]);

    await page.waitForTimeout(200);
    await expect(form.locator('[data-success-box]')).toBeVisible();
  });

  test('applies the submission deadline while reading the response body', async ({ page }) => {
    await mockSmartCaptcha(page);
    await shortenSubmitTimeout(page);
    await delayLeadResponseBody(page);

    let submitCalls = 0;
    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, leadId: 'late-body', receivedAt: new Date().toISOString() }),
      });
    });

    await page.goto(CONTACTS_PAGE);
    const form = await getLeadForm(page);
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="consent"]').check();
    await form.locator('[data-smartcaptcha-widget] button').click();

    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-form-status]')).toContainText('Не удалось получить подтверждение отправки');
    await expect(form.locator('[data-submit-btn]')).toBeEnabled();
    expect(submitCalls).toBe(1);

    await page.waitForTimeout(220);
    await expect(form.locator('[data-success-box]')).toBeHidden();
    await expect(form.locator('[data-form-status]')).toContainText('Не удалось получить подтверждение отправки');
  });

  test('creates a fresh idempotency key when a dynamic extra field changes', async ({ page }) => {
    await mockSmartCaptcha(page);
    await shortenSubmitTimeout(page);
    await allowLeadRequestToFinishAfterClientAbort(page);

    const requestKeys: string[] = [];
    const projectVariants: string[] = [];
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      requestKeys.push(route.request().headers()['x-idempotency-key'] || '');
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      projectVariants.push(String(payload.project_variant || ''));
      if (submitCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, leadId: 'lead-extra-field', receivedAt: new Date().toISOString() }),
      });
    });

    await page.goto(CONTACTS_PAGE);
    const form = await getLeadForm(page);
    await form.evaluate((formElement) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'project_variant';
      input.value = 'corner';
      input.dataset.extraField = 'project_variant';
      formElement.append(input);
    });
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="consent"]').check();
    await form.locator('[data-smartcaptcha-widget] button').click();

    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-form-status]')).toContainText('Не удалось получить подтверждение отправки');

    await form.locator('input[data-extra-field="project_variant"]').evaluate((input) => {
      (input as HTMLInputElement).value = 'straight';
    });
    await page.evaluate(() => {
      (window as Window & { __smartCaptchaMock?: { issue(value?: string): void } }).__smartCaptchaMock?.issue(
        'mock-extra-field-token'
      );
    });
    await form.locator('[data-retry-btn]').click();

    await expect(form.locator('[data-success-box]')).toBeVisible();
    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[1]).not.toBe(requestKeys[0]);
    expect(projectVariants).toEqual(['corner', 'straight']);

    await page.waitForTimeout(200);
  });

  test('does not present an in-flight edit as part of the accepted payload', async ({ page }) => {
    await mockSmartCaptcha(page);

    const requestKeys: string[] = [];
    const messages: string[] = [];
    let submitCalls = 0;
    let releaseFirstResponse = () => {};
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      requestKeys.push(route.request().headers()['x-idempotency-key'] || '');
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      messages.push(String(payload.message || ''));
      if (submitCalls === 1) {
        await firstResponseGate;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, leadId: 'lead-in-flight-edit', receivedAt: new Date().toISOString() }),
      });
    });

    await page.goto(CONTACTS_PAGE);
    const form = await getLeadForm(page);
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('textarea[name="message"]').fill('Первоначальные данные');
    await form.locator('input[name="consent"]').check();
    await form.locator('[data-smartcaptcha-widget] button').click();

    const firstSubmit = form.locator('[data-submit-btn]').click();
    await expect.poll(() => submitCalls).toBe(1);
    await form.locator('textarea[name="message"]').fill('Изменённые во время отправки данные');
    releaseFirstResponse();
    await firstSubmit;

    await expect(form.locator('[data-form-status]')).toContainText('Заявка принята с данными на момент нажатия кнопки');
    await expect(form.locator('[data-form-status]')).toContainText(
      'Изменения, внесённые во время отправки, не переданы'
    );
    await expect(form.locator('[data-success-box]')).toBeHidden();
    await expect(form.locator('[data-retry-btn]')).toBeVisible();
    expect(messages).toEqual(['Первоначальные данные']);

    await page.evaluate(() => {
      (window as Window & { __smartCaptchaMock?: { issue(value?: string): void } }).__smartCaptchaMock?.issue(
        'mock-in-flight-retry-token'
      );
    });
    await form.locator('[data-retry-btn]').click();

    await expect(form.locator('[data-success-box]')).toBeVisible();
    expect(messages).toEqual(['Первоначальные данные', 'Изменённые во время отправки данные']);
    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[1]).not.toBe(requestKeys[0]);
  });

  test('keeps the no-JS fallback visible and contained on mobile without horizontal overflow', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    let submitCalls = 0;

    await page.route('**/api/leads', async (route) => {
      submitCalls += 1;
      await route.abort();
    });

    await page.goto(CONTACTS_PAGE);

    const fallback = page.locator('[data-nojs-fallback]').first();
    await expect(fallback).toBeVisible();
    const phoneLink = fallback.locator('[data-nojs-phone-link]');
    await expect(phoneLink).toHaveAttribute('href', /^tel:/);
    await expect(phoneLink).toContainText('+7');

    const overflow = await page.evaluate(() => {
      const fallbackEl = document.querySelector('[data-nojs-fallback]');
      return {
        document: document.documentElement.scrollWidth > window.innerWidth,
        fallback: fallbackEl instanceof HTMLElement ? fallbackEl.scrollWidth > window.innerWidth : false,
      };
    });

    expect(overflow.document).toBe(false);
    expect(overflow.fallback).toBe(false);
    expect(submitCalls).toBe(0);
    await context.close();
  });

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
    await form.locator('input[name="name"]').fill('CI E2E');
    await form.locator('input[name="consent"]').check();
    for (const raw of invalidCases) {
      await phoneInput.fill(raw);
      await expect(phoneInput).toHaveValue(raw);
      await form.locator('[data-submit-btn]').click();
      await expect(form.locator('[data-error-phone]')).toBeVisible();
      await expect(phoneInput).toHaveAttribute('aria-invalid', 'true');
      await expect(form.locator('[data-form-status]')).toContainText('Проверьте корректность полей формы.');
      expect(submitCalls).toBe(0);
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
