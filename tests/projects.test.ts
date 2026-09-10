import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { expect, test } from 'vitest';
import { generateProjectSlug } from '../src/utils/slugify';

type ProjectFrontmatter = {
  slug?: string;
  title?: string;
  city?: string;
  service?: string;
  street?: string;
  images?: string[];
  materials?: Record<string, string>;
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function readFrontmatter(filePath: string): ProjectFrontmatter {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return (yaml.load(match[1]) || {}) as ProjectFrontmatter;
}

function normalizeSlug(value: string | undefined): string {
  return String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.mdx?$/i, '');
}

test('projects content files have valid seo-critical structure', () => {
  const projectsDir = path.join(process.cwd(), 'src/content/projects');
  const files = fs.readdirSync(projectsDir).filter((name) => name.endsWith('.md') || name.endsWith('.mdx'));
  expect(files.length).toBeGreaterThan(0);

  const seenSlugs = new Set<string>();

  for (const file of files) {
    const fullPath = path.join(projectsDir, file);
    const data = readFrontmatter(fullPath);

    expect(data.city).toMatch(/^(irkutsk|angarsk|shelekhov)$/);
    expect(data.service).toMatch(/^(kuhni|shkafy|garderobnye)$/);
    if (typeof data.street !== 'undefined') {
      expect(typeof data.street).toBe('string');
      expect(String(data.street || '').trim().length).toBeGreaterThan(0);
    }

    expect(Array.isArray(data.images)).toBe(true);
    expect((data.images || []).length).toBeGreaterThan(0);
    expect(String(data.title || '').trim().length).toBeGreaterThan(0);

    const generatedSlug = generateProjectSlug({
      title: String(data.title || ''),
      city: String(data.city || ''),
      service: String(data.service || ''),
      layout: String((data as Record<string, unknown>).layout || ''),
      street: String(data.street || ''),
    });
    expect(generatedSlug.length).toBeGreaterThan(0);
    expect(generatedSlug).toMatch(SLUG_PATTERN);

    const explicitSlug = normalizeSlug(data.slug);
    if (explicitSlug) {
      expect(explicitSlug).toMatch(SLUG_PATTERN);
    }

    const finalSlug = explicitSlug || generatedSlug;
    expect(finalSlug).toMatch(SLUG_PATTERN);
    expect(seenSlugs.has(finalSlug)).toBe(false);
    seenSlugs.add(finalSlug);
  }
});
