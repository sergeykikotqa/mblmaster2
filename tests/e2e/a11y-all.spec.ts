import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const DIST_PATH = path.join(process.cwd(), 'dist');
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === '1';

function loadRoutes() {
  if (!fs.existsSync(DIST_PATH) || !fs.statSync(DIST_PATH).isDirectory()) {
    throw new Error(`Missing built site: ${DIST_PATH}. Run "npm run build" before the full accessibility scan.`);
  }

  const routes: { path: string; expectedStatus: number }[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(DIST_PATH, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        // Operational management interfaces are outside the public-site accessibility gate.
        if (relativePath === 'admin' || relativePath === 'decapcms') continue;
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.html')) continue;

      const pathname = relativePath.endsWith('/index.html')
        ? `/${relativePath.slice(0, -'/index.html'.length)}`
        : relativePath === 'index.html'
          ? '/'
          : `/${relativePath.slice(0, -'.html'.length)}`;
      // The standalone server exposes the error route at /404 with its HTTP 404 status.
      const routePath = relativePath === '404.html' ? (useExternalServer ? '/404' : '/404.html') : pathname;
      routes.push({
        path: routePath,
        expectedStatus: routePath === '/404.html' || routePath === '/404' ? 404 : routePath === '/410' ? 410 : 200,
      });
    }
  };
  visit(DIST_PATH);

  // The standalone Node route must render with HTTP 410, so it has no static HTML file.
  if (useExternalServer && !routes.some((route) => route.path === '/410')) {
    routes.push({ path: '/410', expectedStatus: 410 });
  }

  if (routes.length === 0) {
    throw new Error(`No built HTML routes found under ${DIST_PATH}. Run "npm run build" first.`);
  }

  return routes.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
}

const routes = loadRoutes();
const viewports = [
  { name: 'desktop', width: 1440, height: 1200 },
  { name: 'mobile', width: 390, height: 844 },
];
const scrollPositions = [0, 0.25, 0.5, 0.75, 1];

test.describe('A11y full scan', () => {
  test(`routes loaded (${routes.length})`, async () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  for (const viewport of viewports) {
    for (const route of routes) {
      test(`a11y ${route.path} (${viewport.name})`, async ({ page }) => {
        test.setTimeout(90_000);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const response = await page.goto(route.path, { waitUntil: 'domcontentloaded' });
        expect(response?.status(), `${route.path} should return HTTP ${route.expectedStatus}`).toBe(
          route.expectedStatus
        );
        await expect(page.locator('html')).not.toHaveAttribute('data-e2e', 'true');
        await page.evaluate(() => document.fonts.ready);

        const failures: Array<Record<string, unknown>> = [];
        for (const scrollPosition of scrollPositions) {
          await page.evaluate((position) => {
            const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
            window.scrollTo(0, Math.max(0, maxScroll * position));
          }, scrollPosition);
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          );

          const results = await new AxeBuilder({ page }).analyze();
          for (const violation of results.violations) {
            failures.push({
              position: scrollPosition,
              id: violation.id,
              impact: violation.impact,
              description: violation.description,
              nodes: violation.nodes.map((node) => ({ target: node.target, failureSummary: node.failureSummary })),
            });
          }
        }

        expect(failures, `A11y violations on ${route.path} (${viewport.name})`).toEqual([]);
      });
    }
  }
});
