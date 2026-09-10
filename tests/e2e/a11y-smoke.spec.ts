import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';

const routes = [
  { name: 'home', path: '/' },
  { name: 'service', path: '/kuhni' },
  { name: 'contacts', path: '/contacts' },
  { name: 'guides', path: '/guides?q=кухня' },
  { name: 'project', path: '/projects/kuhnya-bogdana' },
];

test.describe('a11y smoke', () => {
  for (const route of routes) {
    test(`axe scan: ${route.name}`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'domcontentloaded' });
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .disableRules(['color-contrast'])
        .analyze();
      const serious = results.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious'
      );

      if (serious.length > 0) {
        const details = serious
          .map((violation) => {
            const nodes = violation.nodes.map((node) => node.target.join(' ')).join(', ');
            return `${violation.id} (${violation.impact}): ${violation.help} -> ${nodes}`;
          })
          .join('\n');
        throw new Error(`A11y violations on ${route.path}:\n${details}`);
      }

      expect(serious.length).toBe(0);
    });
  }
});
