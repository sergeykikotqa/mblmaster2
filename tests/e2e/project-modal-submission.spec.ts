import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockSmartCaptcha } from './smartcaptcha-mock';

const PROJECTS_PAGE = '/projects';

type CapturedLead = {
  headers: Record<string, string>;
  payload: Record<string, unknown>;
};

async function openProjectModal(page: Page, index = 0) {
  const trigger = page.locator('[data-project-modal-trigger]:visible').nth(index);
  await expect(trigger).toBeVisible();
  const context = {
    project_slug: (await trigger.getAttribute('data-project-slug')) || '',
    project_name: (await trigger.getAttribute('data-project-title')) || '',
    project_service: (await trigger.getAttribute('data-project-service')) || '',
    pageSlug: (await trigger.getAttribute('data-project-page')) || '',
  };
  await trigger.click();
  const modal = page.locator('[data-project-modal]');
  const form = modal.locator('form.lead-contact-form');
  await expect(modal).toBeVisible();
  return { trigger, modal, form, context };
}

async function waitForFormReady(form: Locator) {
  await expect(form).toHaveAttribute('data-contact-form-initialized', 'true');
  await expect(form).toHaveAttribute('data-contact-form-state', 'ready');
  await expect(form.locator('[data-submit-btn]')).toBeEnabled();
}

async function fillValidLead(form: Locator) {
  await form.locator('input[name="phone"]').fill('9000000000');
  await form.locator('input[name="name"]').fill('Тест формы проекта');
  await form.locator('textarea[name="message"]').fill('Тестовый запрос без отправки реальной заявки.');
  await form.locator('input[name="consent"]').check();
  const captchaButton = form.locator('[data-smartcaptcha-widget] button');
  await expect(captchaButton).toBeVisible();
  await captchaButton.click();
}

async function captureLeadRequests(page: Page, captured: CapturedLead[]) {
  await page.route('**/api/leads', async (route) => {
    const request = route.request();
    captured.push({
      headers: request.headers(),
      payload: request.postDataJSON() as Record<string, unknown>,
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        leadId: 'project-modal-test-lead',
        receivedAt: new Date().toISOString(),
      }),
    });
  });
}

test.describe('Project modal submission', () => {
  test('initializes the cloned form and blocks an invalid submission client-side', async ({ page }) => {
    let leadPosts = 0;
    await page.route('**/api/leads', async (route) => {
      leadPosts += 1;
      await route.abort();
    });

    await page.goto(PROJECTS_PAGE);
    const pageUrl = page.url();
    const { form } = await openProjectModal(page);
    await waitForFormReady(form);

    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-error-phone]')).toBeVisible();
    await expect(form.locator('[data-error-name]')).toBeVisible();
    await expect(form.locator('[data-error-consent]')).toBeVisible();
    expect(leadPosts).toBe(0);
    expect(page.url()).toBe(pageUrl);
  });

  test('sends one JSON request with CAPTCHA, idempotency and project context', async ({ page }) => {
    await mockSmartCaptcha(page);
    const captured: CapturedLead[] = [];
    await captureLeadRequests(page, captured);

    await page.goto(PROJECTS_PAGE);
    const pageUrl = page.url();
    const { form, context } = await openProjectModal(page);
    await waitForFormReady(form);
    await fillValidLead(form);
    await form.locator('[data-submit-btn]').click();

    await expect(form.locator('[data-success-box]')).toBeVisible();
    expect(captured).toHaveLength(1);
    expect(captured[0].headers['content-type']).toContain('application/json');
    expect(captured[0].headers['x-idempotency-key']).toBeTruthy();
    expect(captured[0].payload).toMatchObject({
      project_slug: context.project_slug,
      project_name: context.project_name,
      project_service: context.project_service,
      service: context.project_service,
      pageSlug: context.pageSlug,
      smartCaptchaToken: 'mock-valid-token',
    });
    expect(page.url()).toBe(pageUrl);
  });

  test('blocks native submission and exposes a phone fallback when the client script fails', async ({ page }) => {
    let leadPosts = 0;
    await page.route('**/scripts/contact-form-client.js', async (route) => route.abort('failed'));
    await page.route('**/api/leads', async (route) => {
      leadPosts += 1;
      await route.abort();
    });

    await page.goto(PROJECTS_PAGE);
    const pageUrl = page.url();
    const { form } = await openProjectModal(page);
    await expect(form).toHaveAttribute('data-contact-form-state', 'unavailable');
    await expect(form).not.toHaveAttribute('data-contact-form-initialized', 'true');
    await expect(form.locator('[data-submit-btn]')).toBeDisabled();
    await expect(form.locator('[data-submit-fallback]')).toBeVisible();
    await expect(form.locator('[data-submit-fallback-call]')).toBeVisible();

    await form.evaluate((element) => (element as HTMLFormElement).requestSubmit());
    await page.waitForTimeout(100);
    expect(leadPosts).toBe(0);
    expect(page.url()).toBe(pageUrl);
  });

  test('blocks submission while loading, then initializes once without duplicate handlers', async ({ page }) => {
    await mockSmartCaptcha(page);
    let releaseScript: (() => void) | undefined;
    const scriptMayContinue = new Promise<void>((resolve) => {
      releaseScript = resolve;
    });
    let clientScriptRequests = 0;
    await page.route('**/scripts/contact-form-client.js', async (route) => {
      clientScriptRequests += 1;
      await scriptMayContinue;
      await route.continue();
    });
    const captured: CapturedLead[] = [];
    await captureLeadRequests(page, captured);

    await page.goto(PROJECTS_PAGE, { waitUntil: 'domcontentloaded' });
    const pageUrl = page.url();
    const { form } = await openProjectModal(page);
    await expect(form).toHaveAttribute('data-contact-form-state', 'loading');
    await expect(form.locator('[data-submit-btn]')).toBeDisabled();
    await form.evaluate((element) => (element as HTMLFormElement).requestSubmit());
    expect(captured).toHaveLength(0);
    expect(page.url()).toBe(pageUrl);

    releaseScript?.();
    await waitForFormReady(form);
    await fillValidLead(form);
    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-success-box]')).toBeVisible();
    expect(clientScriptRequests).toBe(1);
    expect(captured).toHaveLength(1);
  });

  test('keeps one initialized form and one POST across repeated modal openings', async ({ page }) => {
    await mockSmartCaptcha(page);
    const captured: CapturedLead[] = [];
    await captureLeadRequests(page, captured);

    await page.goto(PROJECTS_PAGE);
    const firstOpen = await openProjectModal(page);
    await waitForFormReady(firstOpen.form);
    await firstOpen.modal.locator('button[data-project-modal-close]').click();
    await expect(firstOpen.modal).toBeHidden();

    await firstOpen.trigger.click();
    await expect(firstOpen.modal).toBeVisible();
    await expect(firstOpen.form).toHaveAttribute('data-contact-form-initialized', 'true');
    await fillValidLead(firstOpen.form);
    await firstOpen.form.locator('[data-submit-btn]').click();
    await expect(firstOpen.form.locator('[data-success-box]')).toBeVisible();
    expect(captured).toHaveLength(1);
  });

  test('initializes the same form contract with project context on a detail page', async ({ page }) => {
    await page.goto(PROJECTS_PAGE);
    const projectHref = await page.locator('.project-card a.project-link').first().getAttribute('href');
    expect(projectHref).toMatch(/^\/projects\//);

    await page.goto(projectHref || PROJECTS_PAGE);
    const { form, context } = await openProjectModal(page);
    await waitForFormReady(form);
    expect(await form.locator('input[name="project_slug"]').inputValue()).toBe(context.project_slug);
    expect(await form.locator('input[name="project_name"]').inputValue()).toBe(context.project_name);
    expect(await form.locator('input[name="project_service"]').inputValue()).toBe(context.project_service);
    expect(await form.locator('input[name="service"]').inputValue()).toBe(context.project_service);
    expect(await form.locator('input[name="pageSlug"]').inputValue()).toBe(context.pageSlug);
  });

  test('fails closed with a visible phone fallback when CAPTCHA configuration is unavailable', async ({ page }) => {
    let leadPosts = 0;
    await page.route('**/api/captcha/config', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ provider: 'smartcaptcha', required: true, ready: false }),
      });
    });
    await page.route('**/api/leads', async (route) => {
      leadPosts += 1;
      await route.abort();
    });

    await page.goto(PROJECTS_PAGE);
    const pageUrl = page.url();
    const { form } = await openProjectModal(page);
    await waitForFormReady(form);
    await form.locator('input[name="phone"]').fill('9000000000');
    await form.locator('input[name="name"]').fill('Тест недоступной CAPTCHA');
    await form.locator('input[name="consent"]').check();
    await form.locator('[data-submit-btn]').click();

    await expect(form.locator('[data-error-smartcaptcha]')).toBeVisible();
    await expect(form.locator('[data-submit-fallback]')).toBeVisible();
    await expect(form.locator('[data-submit-fallback-call]')).toBeVisible();
    expect(leadPosts).toBe(0);
    expect(page.url()).toBe(pageUrl);
  });
});
