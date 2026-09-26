import { expect, test, type Locator, type Page } from '@playwright/test';

const PROJECTS_PAGE = '/projects';

async function openProjectModal(page: Page, index = 0) {
  const trigger = page.locator('[data-project-modal-trigger]:visible').nth(index);
  await expect(trigger).toBeVisible();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  const modal = page.locator('[data-project-modal]');
  await expect(modal).toBeVisible();
  return { trigger, modal };
}

async function expectFocusInside(modal: Locator) {
  await expect.poll(() => modal.evaluate((root) => root.contains(document.activeElement))).toBe(true);
}

async function getFocusableState(modal: Locator) {
  return modal.evaluate((root) => {
    const selector = [
      'a[href]',
      'area[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'iframe',
      '[contenteditable]:not([contenteditable="false"])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const items = Array.from(root.querySelectorAll(selector)).filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (!element.isConnected || element.hidden || element.closest('[hidden], [aria-hidden="true"], [inert]')) {
        return false;
      }
      if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true' || element.tabIndex < 0) {
        return false;
      }
      const styles = window.getComputedStyle(element);
      return styles.display !== 'none' && styles.visibility !== 'hidden' && element.getClientRects().length > 0;
    });
    return {
      count: items.length,
      activeIndex: items.indexOf(document.activeElement as Element),
    };
  });
}

test.describe('Project modal focus management', () => {
  test('traps desktop keyboard focus, isolates the background, and restores focus on Escape', async ({ page }) => {
    await page.goto(PROJECTS_PAGE);
    await page.evaluate(() => {
      const preInert = document.createElement('button');
      preInert.id = 'preexisting-inert-control';
      preInert.inert = true;
      preInert.textContent = 'Pre-existing inert control';
      document.body.append(preInert);
    });

    const trigger = page.locator('.project-card [data-project-modal-trigger]').first();
    await trigger.scrollIntoViewIfNeeded();
    const scrollBeforeOpen = await page.evaluate(() => window.scrollY);
    await trigger.click();
    const modal = page.locator('[data-project-modal]');
    await expect(modal).toBeVisible();

    await expect(modal.locator('input[name="phone"]')).toBeFocused();
    await expectFocusInside(modal);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const currentModal = document.querySelector('[data-project-modal]');
          return Array.from(document.body.children)
            .filter((element) => element !== currentModal && !element.contains(currentModal))
            .every((element) => element instanceof HTMLElement && element.inert);
        })
      )
      .toBe(true);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    await page.evaluate(() => {
      const dynamicControl = document.createElement('button');
      dynamicControl.id = 'dynamic-background-control';
      dynamicControl.textContent = 'Dynamic background control';
      document.body.append(dynamicControl);
    });
    await expect
      .poll(() => page.locator('#dynamic-background-control').evaluate((element) => (element as HTMLElement).inert))
      .toBe(true);

    await page.locator('#dynamic-background-control').evaluate((element) => (element as HTMLElement).focus());
    await expectFocusInside(modal);

    const initialState = await getFocusableState(modal);
    expect(initialState.count).toBeGreaterThan(1);
    expect(initialState.activeIndex).toBeGreaterThanOrEqual(0);
    for (let index = 0; index < initialState.count; index += 1) {
      await page.keyboard.press('Tab');
      await expectFocusInside(modal);
    }
    expect((await getFocusableState(modal)).activeIndex).toBe(initialState.activeIndex);
    for (let index = 0; index < initialState.count; index += 1) {
      await page.keyboard.press('Shift+Tab');
      await expectFocusInside(modal);
    }
    expect((await getFocusableState(modal)).activeIndex).toBe(initialState.activeIndex);

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(Math.round(scrollBeforeOpen));
    expect(await page.locator('#preexisting-inert-control').evaluate((element) => (element as HTMLElement).inert)).toBe(
      true
    );
    expect(await page.locator('#dynamic-background-control').evaluate((element) => (element as HTMLElement).inert)).toBe(
      false
    );
  });

  test('backdrop and close button restore focus to the exact trigger across repeated openings', async ({ page }) => {
    await page.goto(PROJECTS_PAGE);
    const first = await openProjectModal(page, 0);
    await first.modal.locator('.project-modal-backdrop[data-project-modal-close]').click({ position: { x: 4, y: 4 } });
    await expect(first.modal).toBeHidden();
    await expect(first.trigger).toBeFocused();

    const second = await openProjectModal(page, 1);
    await expectFocusInside(second.modal);
    await second.modal.locator('button[data-project-modal-close]').click();
    await expect(second.modal).toBeHidden();
    await expect(second.trigger).toBeFocused();

    await second.trigger.click();
    await expect(second.modal).toBeVisible();
    await second.trigger.evaluate((element) => element.remove());
    await page.keyboard.press('Escape');
    await expect(second.modal).toBeHidden();
    await expect.poll(() => page.evaluate(() => !document.querySelector('[data-project-modal]')?.contains(document.activeElement))).toBe(
      true
    );
    await expect.poll(() => page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.tabIndex >= 0)).toBe(
      true
    );
  });

  test('keeps mobile focus and scrolling inside the bottom-sheet dialog', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(PROJECTS_PAGE);
    const { trigger, modal } = await openProjectModal(page);
    const closeButton = modal.locator('button[data-project-modal-close]');

    await expect(closeButton).toBeFocused();
    await expect(closeButton).toBeInViewport();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    const state = await getFocusableState(modal);
    expect(state.activeIndex).toBe(0);
    expect(state.count).toBeGreaterThan(1);
    await page.keyboard.press('Shift+Tab');
    await expectFocusInside(modal);
    expect((await getFocusableState(modal)).activeIndex).toBe(state.count - 1);
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();

    const panelScroll = await modal.locator('[role="dialog"]').evaluate((panel) => ({
      overflowY: window.getComputedStyle(panel).overflowY,
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
    }));
    expect(['auto', 'scroll']).toContain(panelScroll.overflowY);
    expect(panelScroll.scrollHeight).toBeGreaterThanOrEqual(panelScroll.clientHeight);

    await closeButton.click();
    await expect(modal).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  });

  test('uses the same focus contract on a project detail page', async ({ page }) => {
    await page.goto(PROJECTS_PAGE);
    const projectHref = await page.locator('.project-card a.project-link').first().getAttribute('href');
    expect(projectHref).toMatch(/^\/projects\//);

    await page.goto(projectHref || PROJECTS_PAGE);
    const { trigger, modal } = await openProjectModal(page);
    await expectFocusInside(modal);
    await page.keyboard.press('Tab');
    await expectFocusInside(modal);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('recomputes focusable controls when retry and success states appear', async ({ page }) => {
    await page.goto(PROJECTS_PAGE);
    const { modal } = await openProjectModal(page);
    const form = modal.locator('form.lead-contact-form');
    const initialCount = (await getFocusableState(modal)).count;

    await form.evaluate((currentForm) => {
      const step = currentForm.querySelector('[data-smartcaptcha-step]');
      const widget = currentForm.querySelector('[data-smartcaptcha-widget]');
      if (!(step instanceof HTMLElement) || !(widget instanceof HTMLElement)) return;
      step.hidden = false;
      step.setAttribute('aria-hidden', 'false');
      step.classList.remove('hidden');
      const captchaControl = document.createElement('button');
      captchaControl.type = 'button';
      captchaControl.dataset.testCaptchaControl = 'true';
      captchaControl.textContent = 'Mock CAPTCHA control';
      widget.append(captchaControl);
    });
    const captchaControl = form.locator('[data-test-captcha-control]');
    await expect(captchaControl).toBeVisible();
    expect((await getFocusableState(modal)).count).toBe(initialCount + 2);

    const retry = form.locator('[data-retry-btn]');
    await retry.evaluate((element) => element.classList.remove('hidden'));
    await expect(retry).toBeVisible();
    const retryState = await getFocusableState(modal);
    expect(retryState.count).toBe(initialCount + 3);
    for (let index = 0; index < retryState.count; index += 1) {
      await page.keyboard.press('Tab');
      await expectFocusInside(modal);
    }

    await form.evaluate((currentForm) => {
      const formContent = currentForm.querySelector('[data-form-content]');
      const successBox = currentForm.querySelector('[data-success-box]');
      if (!(formContent instanceof HTMLElement) || !(successBox instanceof HTMLElement)) return;
      formContent.classList.add('hidden');
      successBox.classList.remove('hidden');
    });
    const successLink = form.locator('[data-success-box] a');
    await expect(successLink).toBeVisible();
    await successLink.focus();
    await page.keyboard.press('Tab');
    await expectFocusInside(modal);
    expect((await getFocusableState(modal)).count).toBeGreaterThan(1);
  });

  test('falls back to the dialog panel when no controls are available', async ({ page }) => {
    await page.goto(PROJECTS_PAGE);
    const { modal } = await openProjectModal(page);
    const panel = modal.locator('[role="dialog"]');

    await modal.locator('a, area, button, input, select, textarea, iframe, [contenteditable], [tabindex]:not([role="dialog"])').evaluateAll(
      (elements) => elements.forEach((element) => element.setAttribute('hidden', ''))
    );
    expect((await getFocusableState(modal)).count).toBe(0);

    await panel.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(panel).toBeFocused();
    await expectFocusInside(modal);
  });
});
