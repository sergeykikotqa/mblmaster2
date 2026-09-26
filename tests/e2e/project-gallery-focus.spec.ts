import { test, expect } from '@playwright/test';

test('project gallery lightbox is pointer-accessible and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto('/projects/biruzovaya-uglovaya-kuhnya-irkutsk', { waitUntil: 'domcontentloaded' });

  const gallery = page.locator('[data-project-gallery]');
  await expect(gallery).toBeVisible();

  const opener = gallery.locator('[data-gallery-open]').first();
  await opener.focus();
  await opener.click();

  const lightbox = page.locator('[data-gallery-lightbox]');
  await expect(lightbox).toHaveClass(/open/);

  const closeBtn = lightbox.locator('[data-gallery-close]');
  await expect(closeBtn).toBeFocused();

  const closeButtonReceivesPointer = await closeBtn.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hitTarget === button || button.contains(hitTarget);
  });
  expect(closeButtonReceivesPointer).toBeTruthy();

  await closeBtn.click();
  await expect(lightbox).not.toHaveClass(/open/);
  await expect(opener).toBeFocused();

  await opener.click();
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

test('project gallery lightbox respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/projects/biruzovaya-uglovaya-kuhnya-irkutsk', { waitUntil: 'domcontentloaded' });

  const gallery = page.locator('[data-project-gallery]');
  const opener = gallery.locator('[data-gallery-open]').first();
  await opener.click();

  const lightbox = page.locator('[data-gallery-lightbox]');
  await expect(lightbox).toHaveClass(/open/);
  expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBeTruthy();
  expect(
    await lightbox.evaluate(
      (element) =>
        element.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length
    )
  ).toBe(0);

  await lightbox.locator('[data-gallery-close]').click();
  await expect(lightbox).not.toHaveClass(/open/);
  await expect(opener).toBeFocused();
});
