import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { getCanonicalUrl } from '../../src/lib/canonical';
import { getIndexabilityPolicy, normalizePolicyPath } from '../../src/config/indexability-policy';

const MANIFEST_PATH = path.join(process.cwd(), 'artifacts', 'smoke-manifest.json');

function loadRoutes(): string[] {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`SEO smoke manifest is missing: ${MANIFEST_PATH}`);
  }
  try {
    const payload = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const routes = Array.isArray(payload?.seo?.routes) ? payload.seo.routes : [];
    if (routes.length === 0) throw new Error('SEO smoke manifest contains no routes');
    return routes;
  } catch (error) {
    throw new Error(`SEO smoke manifest is invalid: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
  }
}

function appendQuery(pathname: string, query: string) {
  if (!query) return pathname;
  if (pathname.includes('?')) return `${pathname}&${query}`;
  return `${pathname}?${query}`;
}

const routes = loadRoutes();

test.describe('SEO invariants', () => {
  test(`routes loaded (${routes.length})`, async () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  for (const rawPath of routes) {
    const routePath = normalizePolicyPath(rawPath);
    const policy = getIndexabilityPolicy(routePath);

    test(`canonical + robots + meta for ${routePath}`, async ({ page }) => {
      expect(policy.isKnown).toBe(true);

      const targetUrl = appendQuery(routePath, 'utm_source=playwright');
      const response = await page.goto(targetUrl, { waitUntil: 'networkidle' });
      expect(response, `No HTTP response for ${routePath}`).not.toBeNull();
      expect(response?.status(), `Unexpected HTTP status for ${routePath}`).toBe(200);
      expect(new URL(page.url()).pathname).toBe(routePath);

      const canonicalHref = await page.locator('link[rel="canonical"]').getAttribute('href');
      expect(canonicalHref).toBeTruthy();
      expect(canonicalHref).toBe(getCanonicalUrl(new URL(page.url())));

      const title = (await page.title()) || '';
      expect(title.trim().length).toBeGreaterThan(0);

      const description = (await page.locator('meta[name="description"]').getAttribute('content')) || '';
      expect(description.trim().length).toBeGreaterThan(0);

      const robots = (await page.locator('meta[name="robots"]').getAttribute('content')) || '';
      const robotsValue = robots.toLowerCase();

      if (policy.index) {
        expect(robotsValue).not.toContain('noindex');
      } else {
        expect(robotsValue).toContain('noindex');
      }

      if (policy.follow) {
        expect(robotsValue).not.toContain('nofollow');
      } else {
        expect(robotsValue).toContain('nofollow');
      }
    });
  }
});
