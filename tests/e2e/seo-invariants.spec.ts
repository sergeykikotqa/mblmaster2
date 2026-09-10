import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { getCanonicalUrl } from '../../src/lib/canonical';
import { getIndexabilityPolicy, normalizePolicyPath } from '../../src/config/indexability-policy';

const MANIFEST_PATH = path.join(process.cwd(), 'artifacts', 'smoke-manifest.json');
const DEFAULT_ROUTES = ['/', '/kuhni', '/articles/kak-vybrat-kuhnyu'];

function loadRoutes(): string[] {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return DEFAULT_ROUTES;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const routes = Array.isArray(payload?.seo?.routes) ? payload.seo.routes : [];
    return routes.length > 0 ? routes : DEFAULT_ROUTES;
  } catch {
    return DEFAULT_ROUTES;
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
      await page.goto(targetUrl, { waitUntil: 'networkidle' });

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
