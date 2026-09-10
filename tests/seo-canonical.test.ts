import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { toCanonical } from '../src/lib/url-builder';

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
