import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';

const routes = [
  { name: 'home', path: '/' },
  { name: 'service', path: '/kuhni' },
  { name: 'contacts', path: '/contacts' },
  { name: 'guides', path: '/guides?q=кухня' },
  { name: 'project', path: '/projects/kuhnya-bogdana' },
];

const viewports = [
  { name: 'desktop', width: 1440, height: 1200 },
  { name: 'mobile', width: 390, height: 844 },
];

const projectScrollPositions = [0, 0.25, 0.5, 0.75, 1];

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
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(route.path, { waitUntil: 'domcontentloaded' });

        const scrollPositions = route.name === 'project' ? projectScrollPositions : [0];
        for (const scrollPosition of scrollPositions) {
          await page.evaluate((position) => {
            const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
            window.scrollTo(0, Math.max(0, maxScroll * position));
          }, scrollPosition);

          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .disableRules(['color-contrast'])
            .analyze();
          const serious = results.violations.filter(
            (violation) => violation.impact === 'critical' || violation.impact === 'serious'
          );

          if (serious.length > 0) {
            throw new Error(
              `A11y violations on ${route.path} at ${scrollPosition}:\n${formatViolations(serious)}`
            );
          }

          expect(serious.length).toBe(0);
        }
      });
    }
  }
});

test.describe('project detail contrast', () => {
  for (const viewport of viewports) {
    test(`axe color contrast (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/projects/kuhnya-bogdana', { waitUntil: 'domcontentloaded' });

      for (const scrollPosition of projectScrollPositions) {
        await page.evaluate((position) => {
          const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
          window.scrollTo(0, Math.max(0, maxScroll * position));
        }, scrollPosition);

        const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
        if (results.violations.length > 0) {
          throw new Error(
            `Project contrast violations at ${scrollPosition}:\n${formatViolations(results.violations)}`
          );
        }

        expect(results.violations).toEqual([]);
      }
    });
  }
});
