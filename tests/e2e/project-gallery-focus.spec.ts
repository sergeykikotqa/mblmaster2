import { test, expect } from '@playwright/test';

test('project gallery lightbox traps focus and restores', async ({ page }) => {
  await page.goto('/projects/kuhnya-bogdana', { waitUntil: 'domcontentloaded' });

  const gallery = page.locator('[data-project-gallery]');
  await expect(gallery).toBeVisible();

  const opener = gallery.locator('[data-gallery-open]').first();
  await opener.focus();
  await opener.click();

  const lightbox = page.locator('[data-gallery-lightbox]');
  await expect(lightbox).toHaveClass(/open/);

  const closeBtn = lightbox.locator('[data-gallery-close]');
  await expect(closeBtn).toBeFocused();

  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Tab');
    const isInside = await page.evaluate(() => {
      const modal = document.querySelector('[data-gallery-lightbox]');
      return Boolean(modal && modal.contains(document.activeElement));
    });
    expect(isInside).toBeTruthy();
  }

  await page.keyboard.press('Escape');
  await expect(lightbox).not.toHaveClass(/open/);
  await expect(opener).toBeFocused();
});
