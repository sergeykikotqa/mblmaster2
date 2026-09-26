import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { toCanonical } from '../src/lib/url-builder';
import { getCanonicalUrl } from '../src/lib/canonical';

type GeneratedPage = {
  pageSlug: string;
};

function readGeneratedPages(): GeneratedPage[] {
  const filePath = path.join(process.cwd(), 'data/generated-pages.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as GeneratedPage[];
}

test('money page URL model is /{service}', () => {
  const pages = readGeneratedPages();
  const validPattern = /^\/(kuhni|shkafy|garderobnye)$/;
  const invalidLegacyPattern = /^\/(irkutsk|angarsk|shelekhov)\/(kuhni|shkafy|garderobnye)$/;

  for (const page of pages) {
    expect(page.pageSlug).toMatch(validPattern);
    expect(page.pageSlug).not.toMatch(invalidLegacyPattern);
  }
});

test('canonical URL is relative and clean (no query/hash)', () => {
  const canonical = toCanonical('/kuhni', 'https://mebel-irkutsk.ru');
  expect(canonical).toBe('/kuhni');
  expect(canonical.includes('?')).toBe(false);
  expect(canonical.includes('#')).toBe(false);
});

test('public canonical origin does not retain a local test-server port', () => {
  expect(
    getCanonicalUrl(new URL('http://127.0.0.1:4507/kuhni?utm_source=test'), {
      publicSiteUrl: 'https://mebel-irkutsk.ru',
    })
  ).toBe('https://mebel-irkutsk.ru/kuhni');
});
