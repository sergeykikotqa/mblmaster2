import fs from 'node:fs';
import path from 'node:path';

import { loadIndexabilityPolicyModule } from './lib/load-indexability-policy.mjs';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const SITEMAP_FILE_PATTERN = /^sitemap(?:-(?:index|\d+))?\.xml$/i;
const SITEMAP_ROUTE_PATTERN = /^\/sitemap(?:-(?:index|\d+))?\.xml$/i;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeRoutePath(pathname) {
  const normalized = `/${String(pathname || '').replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function collectSitemapFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SITEMAP_FILE_PATTERN.test(entry.name))
    .map((entry) => path.join(dirPath, entry.name));
}

function extractLocValues(xml) {
  const values = [];
  const regex = /<loc>([^<]+)<\/loc>/gi;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    values.push(match[1].trim());
  }
  return values;
}

function extractPathname(loc) {
  try {
    const parsed = new URL(loc);
    return normalizeRoutePath(parsed.pathname);
  } catch {
    return normalizeRoutePath(loc);
  }
}

async function main() {
  assert(fs.existsSync(DIST_DIR), 'dist directory is missing. Run `npm run build` first.');
  const { getIndexabilityPolicy } = await loadIndexabilityPolicyModule();

  const sitemapFiles = collectSitemapFiles(DIST_DIR);
  assert(sitemapFiles.length > 0, 'No sitemap XML files found in dist/.');

  const violations = [];

  for (const filePath of sitemapFiles) {
    const relativePath = path.relative(ROOT, filePath).replace(/\\/g, '/');
    const xml = fs.readFileSync(filePath, 'utf8');
    const locs = extractLocValues(xml);

    for (const loc of locs) {
      const pathname = extractPathname(loc);
      if (SITEMAP_ROUTE_PATTERN.test(pathname)) {
        continue;
      }
      const policy = getIndexabilityPolicy(pathname);
      if (!policy.isKnown) {
        violations.push(`- ${relativePath}: ${loc} (route is not classified)`);
        continue;
      }
      if (!policy.includeInSitemap) {
        violations.push(`- ${relativePath}: ${loc} (classification="${policy.classification}")`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`Sitemap policy check failed.\nUnexpected URLs present in sitemap:\n${violations.join('\n')}`);
  }

  console.log(`Sitemap policy check passed: ${sitemapFiles.length} sitemap XML files checked.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
