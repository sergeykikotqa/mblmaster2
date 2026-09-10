import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

type GeneratedPage = {
  pageSlug: string;
  pageType: string;
  cityId: string;
  indexabilityPolicy: string;
};

function readGeneratedPages(): GeneratedPage[] {
  const filePath = path.join(process.cwd(), 'data/generated-pages.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as GeneratedPage[];
}

test('generated-pages.json contains 3 money pages', () => {
  const pages = readGeneratedPages();
  expect(pages).toHaveLength(3);
});

test('generated-pages.json has exact money page slug set', () => {
  const pages = readGeneratedPages();
  const actual = new Set(pages.map((page) => page.pageSlug));
  const expected = new Set(['/kuhni', '/shkafy', '/garderobnye']);

  expect(actual).toEqual(expected);
});

test('generated-pages.json contains only indexable service-money pages', () => {
  const pages = readGeneratedPages();
  expect(pages.every((page) => page.pageType === 'service-money')).toBe(true);
  expect(pages.every((page) => page.indexabilityPolicy === 'index')).toBe(true);
});

test('generated-pages.json does not contain nested geo service routes', () => {
  const pages = readGeneratedPages();
  expect(
    pages.every((page) => {
      const segments = page.pageSlug.split('/').filter(Boolean);
      return segments.length === 1;
    })
  ).toBe(true);
});
