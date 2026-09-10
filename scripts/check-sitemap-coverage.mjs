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

function collectSitemapPaths() {
  const sitemapFiles = fs
    .readdirSync(DIST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SITEMAP_PATTERN.test(entry.name))
    .map((entry) => path.join(DIST_DIR, entry.name));

  if (sitemapFiles.length === 0) {
    throw new Error('No sitemap XML files found in dist/.');
  }

  const paths = new Set();
  const regex = /<loc>([^<]+)<\/loc>/gi;

  for (const filePath of sitemapFiles) {
    const xml = fs.readFileSync(filePath, 'utf8');
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const value = String(match[1] || '').trim();
      if (!value) continue;

      try {
        const parsed = new URL(value);
        const pathname = normalizeRoutePath(parsed.pathname);
        if (!SITEMAP_ROUTE_PATTERN.test(pathname)) {
          paths.add(pathname);
        }
      } catch {
        const pathname = normalizeRoutePath(value);
        if (!SITEMAP_ROUTE_PATTERN.test(pathname)) {
          paths.add(pathname);
        }
      }
    }
  }

  return paths;
}

async function main() {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('Sitemap coverage check failed: dist directory is missing. Run `npm run build` first.');
  }

  const { getIndexabilityPolicy } = await loadIndexabilityPolicyModule();
  const htmlFiles = walkHtmlFiles(DIST_DIR);
  const builtRoutes = new Set();
  const expectedSitemapRoutes = new Set();
  const errors = [];

  for (const filePath of htmlFiles) {
    const routePath = normalizeRoutePath(toRoutePath(filePath));
    const policy = getIndexabilityPolicy(routePath);
    builtRoutes.add(routePath);

    if (!policy.isKnown) {
      errors.push(`- ${routePath}: built route is not classified in src/config/indexability-policy.ts`);
      continue;
    }

    if (policy.includeInSitemap) {
      expectedSitemapRoutes.add(routePath);
    }
  }

  const sitemapRoutes = collectSitemapPaths();
  const missing = [...expectedSitemapRoutes].filter((routePath) => !sitemapRoutes.has(routePath));
  const unexpected = [];

  for (const routePath of sitemapRoutes) {
    const policy = getIndexabilityPolicy(routePath);
    if (!builtRoutes.has(routePath)) {
      unexpected.push(`- ${routePath}: present in sitemap but missing from dist`);
      continue;
    }
    if (!policy.isKnown) {
      unexpected.push(`- ${routePath}: present in sitemap but not classified in src/config/indexability-policy.ts`);
      continue;
    }
    if (!policy.includeInSitemap) {
      unexpected.push(`- ${routePath}: present in sitemap but policy classification is "${policy.classification}"`);
    }
  }

  if (missing.length > 0 || unexpected.length > 0 || errors.length > 0) {
    const lines = ['Sitemap coverage check failed.'];
    if (errors.length > 0) {
      lines.push('Unclassified built routes:');
      lines.push(...errors);
    }
    if (missing.length > 0) {
      lines.push('Expected sitemap routes missing:');
      lines.push(...missing.map((routePath) => `- ${routePath}`));
    }
    if (unexpected.length > 0) {
      lines.push('Unexpected sitemap routes present:');
      lines.push(...unexpected);
    }
    throw new Error(lines.join('\n'));
  }

  console.log(
    `Sitemap coverage check passed: expected=${expectedSitemapRoutes.size}, actual=${sitemapRoutes.size}, html=${htmlFiles.length}.`
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
