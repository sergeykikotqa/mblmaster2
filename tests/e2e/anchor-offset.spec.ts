import { test, type Page } from '@playwright/test';

async function expectTargetVisibleBelowHeader(page: Page, pagePath: string, targetId: string, clickSelector?: string) {
  const header = pagePath === '/' ? '#header' : 'header';
  const url = pagePath.includes('#') ? pagePath : `${pagePath}#${targetId}`;

  await page.goto(url.split('#')[0]);
  if (clickSelector) {
    await page.click(clickSelector);
  } else if (url.includes('#')) {
    await page.goto(url);
  }

  await page.waitForFunction(
    ({ headerSelector, target }) => {
      const headerEl = document.querySelector(headerSelector);
      const targetEl = document.getElementById(target);
      if (!headerEl || !targetEl) return false;
      const headerBottom = headerEl.getBoundingClientRect().bottom;
      const targetTop = targetEl.getBoundingClientRect().top;
      return targetTop >= headerBottom - 2;
    },
    { headerSelector: header, target: targetId }
  );
}

test.describe('Anchor offset', () => {
  test('in-page anchor stays visible below sticky header', async ({ page }) => {
    await expectTargetVisibleBelowHeader(page, '/', 'contact', 'a[href="#contact"]');
  });

  test('hash navigation on load stays visible below sticky header', async ({ page }) => {
    await expectTargetVisibleBelowHeader(page, '/contacts', 'contact');
  });
});
