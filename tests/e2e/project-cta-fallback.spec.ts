import { expect, test, type Page } from '@playwright/test';

const PROJECTS_PAGE = '/projects';

async function getFirstProjectCta(page: Page) {
  const cta = page.locator('.project-card [data-project-modal-trigger]').first();
  await expect(cta).toBeVisible();
  return cta;
}

async function expectContactHref(page: Page) {
  const cta = await getFirstProjectCta(page);
  await expect(cta).toHaveJSProperty('tagName', 'A');

  const href = await cta.getAttribute('href');
  const slug = await cta.getAttribute('data-project-slug');
  const service = await cta.getAttribute('data-project-service');
  expect(href).toBeTruthy();
  expect(slug).toBeTruthy();

  const url = new URL(href || '', page.url());
  expect(url.pathname).toBe('/contacts');
  expect(url.searchParams.get('from')).toBe('project');
  expect(url.searchParams.get('slug')).toBe(slug);
  if (service) expect(url.searchParams.get('service')).toBe(service);

  return { cta, href: url.pathname + url.search, slug: slug || '', service: service || '' };
}

test.describe('Project CTA progressive enhancement', () => {
  test('navigates to contextual contacts when JavaScript is disabled', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    await page.goto(PROJECTS_PAGE);
    const { cta, slug } = await expectContactHref(page);

    await Promise.all([page.waitForURL((url) => url.pathname === '/contacts'), cta.click()]);
    expect(new URL(page.url()).searchParams.get('slug')).toBe(slug);
    await expect(page.locator('a[href^="tel:"]:visible').first()).toBeVisible();

    await context.close();
  });

  test('opens the prepared modal for an ordinary click and preserves project context', async ({ page }) => {
    await page.goto(PROJECTS_PAGE);
    const { cta, slug, service } = await expectContactHref(page);
    const title = (await cta.getAttribute('data-project-title')) || '';
    expect(title).toBeTruthy();

    const card = cta.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " project-card ")]');
    await expect(card.locator('a.project-link')).toHaveAttribute('href', /^\/projects\//);
    await expect(card.locator('a.project-title-link')).toHaveAttribute('href', /^\/projects\//);

    await cta.click();

    const modal = page.locator('[data-project-modal]');
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-project-modal-title]')).toHaveText(title);
    expect(new URL(page.url()).pathname).toBe('/projects');
    await expect(modal.locator('input[name="project_slug"]')).toHaveValue(slug);
    await expect(modal.locator('input[name="project_name"]')).toHaveValue(title);
    await expect(modal.locator('input[name="project_service"]')).toHaveValue(service);
    await expect(modal.locator('input[name="service"]')).toHaveValue(service);

    await modal.locator('button[data-project-modal-close]').click();
    await expect(modal).toBeHidden();
    await expect(card).toBeVisible();
  });

  test('uses the contact fallback when the modal script does not load', async ({ page }) => {
    await page.route('**/scripts/project-modal.js', async (route) => {
      await route.abort('failed');
    });

    await page.goto(PROJECTS_PAGE);
    const { cta, slug } = await expectContactHref(page);

    await Promise.all([page.waitForURL((url) => url.pathname === '/contacts'), cta.click()]);
    expect(new URL(page.url()).searchParams.get('slug')).toBe(slug);
    await expect(page.locator('a[href^="tel:"]:visible').first()).toBeVisible();
  });

  test('does not suppress a modified click and keeps the native href available', async ({ page }) => {
    await page.goto(PROJECTS_PAGE);
    const { cta, href } = await expectContactHref(page);
    await expect(cta).toHaveAttribute('href', href);

    const preventedByModalHandler = await cta.evaluate((link) => {
      let prevented = false;
      const observeAfterModalHandler = (event: MouseEvent) => {
        prevented = event.defaultPrevented;
        event.preventDefault();
      };
      link.addEventListener('click', observeAfterModalHandler, { once: true });
      link.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          ctrlKey: true,
        })
      );
      return prevented;
    });

    expect(preventedByModalHandler).toBe(false);
    await expect(page.locator('[data-project-modal]')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/projects');
  });
});
