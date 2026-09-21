import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const CITY_HUBS = ['/irkutsk', '/angarsk', '/shelekhov'];
const ALLOWED_MAIN_LINKS = new Set(['/kuhni', '/shkafy', '/garderobnye']);
const SITE_URL = String(process.env.PUBLIC_SITE_URL || 'https://example.com').replace(/\/$/, '');

function fail(message) {
  throw new Error(message);
}

function normalizePathname(value) {
  const normalized = `/${String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function toDistHtmlPath(routePath) {
  const normalized = normalizePathname(routePath);
  if (normalized === '/') return path.join(DIST_DIR, 'index.html');
  return path.join(DIST_DIR, normalized.slice(1), 'index.html');
}

function parseTagAttributes(tag) {
  const attrs = {};
  const attrRegex = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = attrRegex.exec(tag)) !== null) {
    attrs[String(match[1] || '').toLowerCase()] = String(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function parseRobotsMeta(html) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const attrs = parseTagAttributes(tag);
    if ((attrs.name || '').toLowerCase() !== 'robots') continue;
    return String(attrs.content || '')
      .toLowerCase()
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseCanonical(html) {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const attrs = parseTagAttributes(tag);
    const relValue = String(attrs.rel || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (relValue.includes('canonical')) {
      return String(attrs.href || '').trim();
    }
  }
  return '';
}

export function extractCommercialNavigationLinks(html, sourcePath) {
  const navMatches = [...html.matchAll(/<nav\b[^>]*data-city-commercial-nav[^>]*>([\s\S]*?)<\/nav>/gi)].map((match) => match[1]);
  if (navMatches.length === 0) {
    return new Set();
  }
  return extractInternalLinks(navMatches.join('\n'), sourcePath);
}

function extractInternalLinks(html, sourcePath) {
  const links = new Set();
  const regex = /href\s*=\s*(["'])(.*?)\1/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const rawHref = String(match[2] || '').trim();
    if (
      !rawHref ||
      rawHref.startsWith('#') ||
      /^https?:\/\//i.test(rawHref) ||
      rawHref.startsWith('mailto:') ||
      rawHref.startsWith('tel:') ||
      rawHref.startsWith('javascript:') ||
      rawHref.startsWith('data:') ||
      rawHref.startsWith('//')
    ) {
      continue;
    }

    try {
      const resolved = rawHref.startsWith('/')
        ? rawHref
        : new URL(rawHref, `https://local.test${sourcePath === '/' ? '/' : `${sourcePath}/`}`).pathname;
      links.add(normalizePathname(resolved));
    } catch {
      // Ignore malformed href values.
    }
  }

  return links;
}

export function collectCityHubIssues(html, routePath, siteUrl = SITE_URL) {
  const errors = [];
  const robots = parseRobotsMeta(html);
  const canonical = parseCanonical(html);
  const navLinks = extractCommercialNavigationLinks(html, routePath);
  const disallowedLinks = [...navLinks].filter((href) => href !== '/privacy' && !ALLOWED_MAIN_LINKS.has(href));
  const missingMoneyLinks = [...ALLOWED_MAIN_LINKS].filter((href) => !navLinks.has(href));

  if (!robots.includes('index') || !robots.includes('follow')) {
    errors.push(
      `- ${routePath}: expected robots to contain "index,follow", got "${robots.join(',') || '(missing)'}"`
    );
  }

  const expectedCanonical = `${siteUrl.replace(/\/$/, '')}${routePath}`;
  if (canonical !== expectedCanonical) {
    errors.push(`- ${routePath}: expected self-canonical "${expectedCanonical}", got "${canonical || '(missing)'}"`);
  }

  if (disallowedLinks.length > 0) {
    errors.push(
      `- ${routePath}: commercial navigation may link only to money pages, found [${disallowedLinks.join(', ')}]`
    );
  }

  if (missingMoneyLinks.length > 0) {
    errors.push(`- ${routePath}: city hub must link to all money pages, missing [${missingMoneyLinks.join(', ')}]`);
  }

  return errors;
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    fail('City hub policy gate failed: dist directory is missing. Run `npm run build` first.');
  }

  const errors = [];

  for (const routePath of CITY_HUBS) {
    const htmlPath = toDistHtmlPath(routePath);
    if (!fs.existsSync(htmlPath)) {
      errors.push(`- ${routePath}: missing HTML at ${path.relative(ROOT, htmlPath).replace(/\\/g, '/')}`);
      continue;
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    errors.push(...collectCityHubIssues(html, routePath, SITE_URL));
  }

  if (errors.length > 0) {
    fail(`City hub policy gate failed.\n${errors.join('\n')}`);
  }

  console.log(
    `City hub policy gate passed: ${CITY_HUBS.length} hubs are index,self-canonical and link only to money pages in commercial navigation.`
  );
}

const isDirectExecution = () => {
  const currentFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return Boolean(currentFilePath) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
};

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
