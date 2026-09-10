import fs from 'node:fs';
import path from 'node:path';

import { loadIndexabilityPolicyModule } from './lib/load-indexability-policy.mjs';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const SITEMAP_PATTERN = /^sitemap(?:-(?:index|\d+))?\.xml$/i;
const SITEMAP_ROUTE_PATTERN = /^\/sitemap(?:-(?:index|\d+))?\.xml$/i;

function normalizeRoutePath(routePath) {
  if (!routePath || routePath === '/') return '/';
  return routePath.replace(/\/+$/, '') || '/';
}

function toRoutePath(filePath) {
  const relative = path.relative(DIST_DIR, filePath).replace(/\\/g, '/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'/index.html'.length)}`;
  if (relative.endsWith('.html')) return `/${relative.slice(0, -'.html'.length)}`;
  return `/${relative}`;
}

function walkHtmlFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    const targetPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walkHtmlFiles(targetPath));
      continue;
    }
    if (entry.isFile() && targetPath.endsWith('.html')) {
      files.push(targetPath);
    }
  }
  return files;
}

function parseTagAttributes(tag) {
  const attributes = {};
  const attrRegex = /([^\s=/>]+)\s*=\s*(['"])([\s\S]*?)\2/g;
  let match;
  while ((match = attrRegex.exec(tag)) !== null) {
    attributes[match[1].toLowerCase()] = match[3];
  }
  return attributes;
}

function extractCanonical(html) {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  const canonicalMatches = linkTags
    .map((tag) => parseTagAttributes(tag))
    .filter((attrs) =>
      String(attrs.rel || '')
        .toLowerCase()
        .split(/\s+/)
        .includes('canonical')
    )
    .map((attrs) => String(attrs.href || '').trim())
    .filter(Boolean);

  return canonicalMatches;
}

function collectSitemapLocs() {
  const sitemapFiles = fs
    .readdirSync(DIST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SITEMAP_PATTERN.test(entry.name))
    .map((entry) => path.join(DIST_DIR, entry.name));

  if (sitemapFiles.length === 0) {
    throw new Error('No sitemap XML files found in dist/.');
  }

  const locs = new Set();
  const regex = /<loc>([^<]+)<\/loc>/gi;

  for (const filePath of sitemapFiles) {
    const xml = fs.readFileSync(filePath, 'utf8');
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const loc = String(match[1] || '').trim();
      if (!loc) continue;

      try {
        const parsed = new URL(loc);
        if (!SITEMAP_ROUTE_PATTERN.test(normalizeRoutePath(parsed.pathname))) {
          locs.add(parsed.toString());
        }
      } catch {
        // Ignore malformed sitemap entries here; other gates will catch them.
      }
    }
  }

  return locs;
}

async function main() {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('Canonical-in-sitemap check failed: dist directory is missing. Run `npm run build` first.');
  }

  const { getIndexabilityPolicy } = await loadIndexabilityPolicyModule();
  const sitemapLocs = collectSitemapLocs();
  const htmlFiles = walkHtmlFiles(DIST_DIR);
  const errors = [];

  for (const filePath of htmlFiles) {
    const routePath = normalizeRoutePath(toRoutePath(filePath));
    const policy = getIndexabilityPolicy(routePath);
    if (!policy.isKnown || !policy.includeInSitemap) continue;

    const html = fs.readFileSync(filePath, 'utf8');
    const canonicalMatches = extractCanonical(html);
    const pageRef = path.relative(ROOT, filePath).replace(/\\/g, '/');

    if (canonicalMatches.length !== 1) {
      errors.push(`[${pageRef}] expected exactly 1 canonical, got ${canonicalMatches.length}`);
      continue;
    }

    const canonical = canonicalMatches[0];
    try {
      const parsedCanonical = new URL(canonical);
      if (!sitemapLocs.has(parsedCanonical.toString())) {
        errors.push(`[${pageRef}] canonical "${parsedCanonical.toString()}" is missing from sitemap`);
      }
    } catch {
      errors.push(`[${pageRef}] canonical must be absolute URL, got "${canonical}"`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Canonical-in-sitemap check failed (${errors.length}):\n${errors.join('\n')}`);
  }

  console.log(`Canonical-in-sitemap check passed: ${htmlFiles.length} HTML files checked.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
