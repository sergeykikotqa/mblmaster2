import { expect, test } from '@playwright/test';

test('header navigation is visible on laptop width and opens service page', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/', { waitUntil: 'networkidle' });

  const mainNav = page.locator('#header nav[aria-label="Main navigation"]');
  await expect(mainNav).toBeVisible();

  const kitchensLink = mainNav.getByRole('link', { name: 'Кухни на заказ' });
  await kitchensLink.click();

  await expect(page).toHaveURL(/\/kuhni$/);
});

test('mobile header menu opens and keeps service navigation reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Toggle Menu' }).click();

  const mobilePanel = page.locator('#header [data-aw-mobile-panel]');
  await expect(mobilePanel).toBeVisible();

  await mobilePanel.getByRole('link', { name: 'Кухни на заказ' }).click();
  await expect(page).toHaveURL(/\/kuhni$/);
});
