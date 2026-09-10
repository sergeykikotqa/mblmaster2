import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ROUTES_PATH = path.join(process.cwd(), 'artifacts', 'audit-routes.json');

function loadRoutes() {
  if (!fs.existsSync(ROUTES_PATH)) {
    throw new Error(`Missing audit routes file: ${ROUTES_PATH}. Run "node scripts/generate-audit-routes.mjs" first.`);
  }
  const payload = JSON.parse(fs.readFileSync(ROUTES_PATH, 'utf8'));
  const routes = Array.isArray(payload?.routes) ? payload.routes : [];
  return routes.filter((route: { policy?: { classification?: string } }) => route?.policy?.classification !== 'blocked');
}

const routes = loadRoutes();

test.describe.serial('A11y full scan', () => {
  test(`routes loaded (${routes.length})`, async () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  for (const route of routes) {
    test(`a11y ${route.path}`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'networkidle' });
      const results = await new AxeBuilder({ page }).analyze();
      if (results.violations.length) {
        console.error(
          JSON.stringify(
            results.violations.map((violation) => ({
              id: violation.id,
              impact: violation.impact,
              description: violation.description,
              nodes: violation.nodes.map((node) => ({ target: node.target, failureSummary: node.failureSummary })),
            })),
            null,
            2
          )
        );
      }
      expect(results.violations).toEqual([]);
    });
  }
});
