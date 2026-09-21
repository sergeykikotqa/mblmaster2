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

const APPROVED_PROJECT_MIGRATION_MAP: Record<string, string> = {
  'garderobnaya-sovetskaya': 'garderobnaya-s-muzhskoy-i-zhenskoy-zonoy-irkutsk',
  'kuhnya-baykalskiy-trakt': 'belaya-uglovaya-kuhnya-zagorodny-dom-irkutsk',
  'kuhnya-bogdana': 'biruzovaya-uglovaya-kuhnya-irkutsk',
  'kuhnya-dzerzhinskogo': 'belaya-uglovaya-kuhnya-s-barnoy-stoykoy-irkutsk',
  'kuhnya-krasnokazachya': 'bezhevaya-uglovaya-kuhnya-irkutsk',
  'kuhnya-piskunova': 'uglovaya-kuhnya-s-podsvetkoy-irkutsk',
  'kuhnya-trilissera': 'belaya-uglovaya-kuhnya-s-derevyannoy-stoleshnitsey-irkutsk',
  'kuhnya-verkhnyaya-naberezhnaya': 'pryamaya-kuhnya-s-vysokimi-penalami-irkutsk',
  'shkaf-deputatskaya': 'vstroennyi-shkaf-s-rabochey-zonoy-irkutsk',
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseRedirectRules(): Array<{ source: string; target: string; status: string }> {
  const file = path.join(process.cwd(), 'config', 'redirects.rules');
  const text = fs.readFileSync(file, 'utf8');
  const parsed: Array<{ source: string; target: string; status: string }> = [];

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+(\S+)\s+(\d{3})\s*$/);
    if (match) {
      parsed.push({ source: match[1], target: match[2], status: match[3] });
    }
  }

  return parsed;
}

function normalizeUrl(value: string): string {
  if (!value) return '/';
  let candidate = value.trim();
  if (candidate.includes('://')) {
    candidate = new URL(candidate).pathname;
  }
  if (!candidate.startsWith('/')) {
    candidate = `/${candidate}`;
  }
  candidate = candidate.split('#')[0].split('?')[0];
  candidate = candidate.replace(/\\/g, '/');
  while (candidate.includes('//')) {
    candidate = candidate.replace(/\/\//g, '/');
  }
  return candidate === '' ? '/' : candidate;
}

function readSitemapUrls(): Set<string> {
  const sitemapPaths = [
    path.join(process.cwd(), 'public', 'sitemap.xml'),
    path.join(process.cwd(), 'dist', 'sitemap.xml'),
  ];
  const urls = new Set<string>();

  for (const filePath of sitemapPaths) {
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    const matches = text.matchAll(/<loc>(.*?)<\/loc>/gi);
    for (const match of matches) {
      urls.add(normalizeUrl(match[1]));
    }
  }

  return urls;
}

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
  expect(files.length).toBe(27);

  const seenSlugs = new Set<string>();

  for (const file of files) {
    const fullPath = path.join(projectsDir, file);
    const data = readFrontmatter(fullPath);

    expect(data.city).toBe('irkutsk');
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

test('public SEO geography is Irkutsk-only', () => {
  const policy = fs.readFileSync(path.join(process.cwd(), 'src', 'config', 'indexability-policy.ts'), 'utf8');

  expect(policy).toContain("'/irkutsk'");
  expect(policy).not.toContain("'/angarsk'");
  expect(policy).not.toContain("'/shelekhov'");
});

test('approved project slug migration map is present in redirect policy', () => {
  const redirects = fs.readFileSync(path.join(process.cwd(), 'config', 'redirects.rules'), 'utf8');

  for (const [oldSlug, newSlug] of Object.entries(APPROVED_PROJECT_MIGRATION_MAP)) {
    const from = `/projects/${oldSlug}`;
    const to = `/projects/${newSlug}`;
    expect(redirects).toContain(`${from} ${to} 301`);
  }
});

test('approved semantic project migration has no chains and canonical HTML semantics', () => {
  const rules = parseRedirectRules();
  const sitemapUrls = readSitemapUrls();

  for (const [oldSlug, newSlug] of Object.entries(APPROVED_PROJECT_MIGRATION_MAP)) {
    const oldPath = `/projects/${oldSlug}`;
    const newPath = `/projects/${newSlug}`;
    const direct = rules.filter((rule) => rule.source === oldPath && rule.target === newPath && rule.status === '301');
    const incoming = rules.filter((rule) => rule.target === oldPath && rule.status === '301');

    expect(direct).toHaveLength(1);
    expect(incoming).toHaveLength(0);

    const htmlPath = path.join(process.cwd(), 'dist', 'projects', newSlug, 'index.html');
    expect(fs.existsSync(htmlPath)).toBe(true);

    const html = fs.readFileSync(htmlPath, 'utf8');
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![1].replace(/<[^>]+>/g, '').trim().length).toBeGreaterThan(0);

    const h1Matches = html.match(/<h1\b/gi) || [];
    expect(h1Matches).toHaveLength(1);

    const robotsMatch = html.match(/<meta\s+[^>]*name=["']robots["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    expect(robotsMatch).not.toBeNull();
    expect(robotsMatch![1].toLowerCase()).toContain('index');
    expect(robotsMatch![1].toLowerCase()).toContain('follow');

    const canonicalMatch = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i);
    expect(canonicalMatch).not.toBeNull();
    expect(canonicalMatch![1].trim()).toBe(`https://example.com${newPath}`);

    const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((match) => normalizeUrl(match[1]));
    expect(hrefs.some((href) => href === oldPath)).toBe(false);
    expect(sitemapUrls.has(newPath)).toBe(true);
    expect(sitemapUrls.has(oldPath)).toBe(false);
  }
});
