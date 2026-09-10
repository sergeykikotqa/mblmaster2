import { expect, test, type Page } from '@playwright/test';

const MONEY_ROUTES = ['/kuhni', '/shkafy', '/garderobnye', '/kuhni-3-metra'] as const;

async function expectStickyState(page: Page, expectedVisible: boolean) {
  await expect
    .poll(async () => {
      return page.locator('#money-page-sticky-cta').evaluate((node) => {
        const element = node as HTMLElement;
        const styles = window.getComputedStyle(element);
        return (
          !element.hidden &&
          element.dataset.visible === 'true' &&
          styles.display !== 'none' &&
          styles.visibility !== 'hidden'
        );
      });
    })
    .toBe(expectedVisible);
}

async function scrollPastHero(page: Page) {
  const heroBottom = await page.locator('.hm').evaluate((node) => {
    const element = node as HTMLElement;
    return element.offsetTop + element.offsetHeight + 120;
  });
  await page.evaluate((scrollTop) => window.scrollTo(0, scrollTop), heroBottom);
}

test.describe('Money page conversion contract', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const route of MONEY_ROUTES) {
    test(`${route} keeps unified CTA contract`, async ({ page }) => {
      await page.goto(route, { waitUntil: 'domcontentloaded' });

      await expect(page.locator('body')).toHaveAttribute('data-page-type', 'service-money');
      await expect(page.locator('main')).toHaveAttribute('data-page-type', 'service-money');

      await expect(page.locator('[data-cta="service_hero_primary"]').first()).toHaveAttribute('href', '#contact');
      await expect(page.locator('[data-cta="service_hero_secondary"]').first()).toHaveAttribute(
        'href',
        '#service-projects'
      );
      await expect(page.locator('[data-cta="service_reentry_primary"]').first()).toHaveAttribute('href', '#contact');
      await expect(page.locator('[data-cta="service_reentry_call"]').first()).toHaveAttribute(
        'href',
        'tel:+79641072613'
      );
      await expect(page.locator('[data-cta="service_sticky_primary"]').first()).toHaveAttribute('href', '#contact');
      await expect(page.locator('[data-cta="service_sticky_call"]').first()).toHaveAttribute(
        'href',
        'tel:+79641072613'
      );

      await expect(page.locator('#service-projects')).toHaveCount(1);
      await expect(page.locator('#floating-call-button')).toHaveCount(0);
      await expect(page.locator('[data-cta="header_phone_mobile"]')).toHaveCount(0);
    });

    test(`${route} keeps sticky out of the way when the contact form is active`, async ({ page }) => {
      await page.goto(route, { waitUntil: 'domcontentloaded' });

      await expectStickyState(page, false);

      await scrollPastHero(page);

      await page.locator('#contact').scrollIntoViewIfNeeded();
      await expectStickyState(page, false);

      const phoneInput = page.locator('#contact input[name="phone"]').first();
      await phoneInput.click();
      await expect(phoneInput).toBeFocused();
      await expectStickyState(page, false);
    });
  }
});
