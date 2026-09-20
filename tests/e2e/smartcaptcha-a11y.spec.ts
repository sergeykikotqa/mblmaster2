import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { mockSmartCaptcha } from './smartcaptcha-mock';

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`SmartCaptcha form and error state are accessible at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockSmartCaptcha(page);
    await page.goto('/contacts');

    const form = page.locator('form.lead-contact-form').first();
    await form.locator('input[name="phone"]').fill('9123456789');
    await form.locator('input[name="name"]').fill('Тест');
    await form.locator('input[name="consent"]').check();
    await expect(form.locator('[data-smartcaptcha-widget] button')).toBeVisible();
    await form.locator('[data-submit-btn]').click();
    await expect(form.locator('[data-error-smartcaptcha]')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('form.lead-contact-form')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter((violation) =>
      ['serious', 'critical'].includes(String(violation.impact))
    );
    expect(
      serious,
      JSON.stringify(serious.map((item) => ({ id: item.id, nodes: item.nodes.map((n) => n.target) })))
    ).toEqual([]);
  });
}
