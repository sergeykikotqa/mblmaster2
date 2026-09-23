import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';

const routes = [
  { name: 'home', path: '/' },
  { name: 'articles', path: '/articles' },
  { name: 'article', path: '/articles/kak-splanirovat-garderobnuyu' },
  { name: 'service', path: '/kuhni' },
  { name: 'projects', path: '/projects' },
  { name: 'project', path: '/projects/biruzovaya-uglovaya-kuhnya-irkutsk' },
  { name: 'contacts', path: '/contacts' },
  { name: 'guides', path: '/guides?q=кухня' },
];

const viewports = [
  { name: 'desktop', width: 1440, height: 1200 },
  { name: 'mobile', width: 390, height: 844 },
];

const scrollPositions = [0, 0.25, 0.5, 0.75, 1];

const formatViolations = (violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']) =>
  violations
    .map((violation) => {
      const nodes = violation.nodes.map((node) => node.target.join(' ')).join(', ');
      return `${violation.id} (${violation.impact}): ${violation.help} -> ${nodes}`;
    })
    .join('\n');

test.describe('a11y smoke', () => {
  for (const viewport of viewports) {
    for (const route of routes) {
      test(`axe scan: ${route.name} (${viewport.name})`, async ({ page }) => {
        test.setTimeout(90_000);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const response = await page.goto(route.path, { waitUntil: 'domcontentloaded' });
        expect(response, `No HTTP response for ${route.path}`).not.toBeNull();
        expect(response?.status(), `Unexpected HTTP status for ${route.path}`).toBe(200);
        expect(new URL(page.url()).pathname).toBe(new URL(route.path, 'http://127.0.0.1').pathname);
        await expect(page.locator('html')).not.toHaveAttribute('data-e2e', 'true');
        await page.evaluate(() => document.fonts.ready);

        for (const scrollPosition of scrollPositions) {
          await page.evaluate((position) => {
            const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
            window.scrollTo(0, Math.max(0, maxScroll * position));
          }, scrollPosition);
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          );

          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          const serious = results.violations.filter(
            (violation) => violation.impact === 'critical' || violation.impact === 'serious'
          );

          if (serious.length > 0) {
            throw new Error(`A11y violations on ${route.path} at ${scrollPosition}:\n${formatViolations(serious)}`);
          }

          expect(serious.length).toBe(0);
        }
      });
    }
  }
});
