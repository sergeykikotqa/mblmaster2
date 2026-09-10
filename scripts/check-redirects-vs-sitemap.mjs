import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REDIRECTS_PATH = path.join(ROOT, '_redirects');
const DIST_DIR = path.join(ROOT, 'dist');
const SITEMAP_PATTERN = /^sitemap(?:-(?:index|\d+))?\.xml$/i;
const SEO_REDIRECT_STATUSES = new Set([301, 302, 308]);

function fail(message) {
  throw new Error(message);
}

function normalizePathname(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/')) return '';
  const normalized = `/${raw.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function parseRedirectPaths(content) {
  const redirects = new Set();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutComment = line.split('#')[0]?.trim() || '';
    if (!withoutComment) continue;

    const parts = withoutComment.split(/\s+/);
    if (parts.length < 3) continue;

    const source = parts[0];
    const statusRaw = parts[2]?.replace(/!$/, '') || '';
    const status = Number(statusRaw);

    if (!source.startsWith('/')) continue;
    if (!Number.isFinite(status) || !SEO_REDIRECT_STATUSES.has(status)) continue;
    if (source.includes('*') || source.includes(':')) continue;

    const normalized = normalizePathname(source);
    if (!normalized || normalized === '/') continue;
    redirects.add(normalized);
  }
  return redirects;
}

function collectSitemapPaths() {
  if (!fs.existsSync(DIST_DIR)) {
    fail('dist directory is missing. Run `npm run build` first.');
  }

  const sitemapFiles = fs
    .readdirSync(DIST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SITEMAP_PATTERN.test(entry.name))
    .map((entry) => path.join(DIST_DIR, entry.name));

  if (sitemapFiles.length === 0) {
    fail('No sitemap XML files found in dist/.');
  }

  const paths = new Set();
  const locRegex = /<loc>([^<]+)<\/loc>/gi;

  for (const sitemapPath of sitemapFiles) {
    const xml = fs.readFileSync(sitemapPath, 'utf8');
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
      const value = String(match[1] || '').trim();
      if (!value) continue;
      try {
        const parsed = new URL(value);
        const normalized = normalizePathname(parsed.pathname);
        if (normalized) paths.add(normalized);
      } catch {
        const normalized = normalizePathname(value);
        if (normalized) paths.add(normalized);
      }
    }
  }

  return paths;
}

function collectBuiltPaths() {
  const paths = new Set();

  function walk(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const relative = path.relative(DIST_DIR, absolute).replace(/\\/g, '/');
      if (relative === 'index.html') {
        paths.add('/');
        continue;
      }
      if (relative.endsWith('/index.html')) {
        const route = normalizePathname(relative.slice(0, -'/index.html'.length));
        if (route) paths.add(route);
        continue;
      }
      if (relative.endsWith('.html')) {
        const route = normalizePathname(relative.slice(0, -'.html'.length));
        if (route) paths.add(route);
      }
    }
  }

  walk(DIST_DIR);
  return paths;
}

function main() {
  if (!fs.existsSync(REDIRECTS_PATH)) {
    fail('Missing root _redirects file.');
  }

  const redirects = parseRedirectPaths(fs.readFileSync(REDIRECTS_PATH, 'utf8'));
  if (redirects.size === 0) {
    console.log('Redirect/sitemap guard passed: no static SEO redirects found.');
    return;
  }

  const sitemapPaths = collectSitemapPaths();
  const builtPaths = collectBuiltPaths();

  const sitemapViolations = [];
  const builtViolations = [];

  for (const redirectPath of redirects) {
    if (sitemapPaths.has(redirectPath)) {
      sitemapViolations.push(redirectPath);
    }
    if (builtPaths.has(redirectPath)) {
      builtViolations.push(redirectPath);
    }
  }

  if (sitemapViolations.length > 0 || builtViolations.length > 0) {
    const lines = [];
    if (sitemapViolations.length > 0) {
      lines.push('Redirect paths present in sitemap:');
      for (const pathValue of sitemapViolations) lines.push(`- ${pathValue}`);
    }
    if (builtViolations.length > 0) {
      lines.push('Redirect paths still built as HTML routes:');
      for (const pathValue of builtViolations) lines.push(`- ${pathValue}`);
    }
    fail(`Redirect/sitemap guard failed.\n${lines.join('\n')}`);
  }

  console.log(`Redirect/sitemap guard passed: ${redirects.size} redirect paths checked.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
