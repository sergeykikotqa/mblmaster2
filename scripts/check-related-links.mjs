import fs from 'node:fs';
import path from 'node:path';
import { loadIndexabilityPolicyModule } from './lib/load-indexability-policy.mjs';

const ROOT = process.cwd();
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const DIST_DIR = path.join(ROOT, 'dist');

function normalizePath(pathname) {
  const normalized = `/${String(pathname || '').replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function toDistHtmlPath(pageSlug) {
  const normalized = normalizePath(pageSlug);
  if (normalized === '/') return path.join(DIST_DIR, 'index.html');
  return path.join(DIST_DIR, normalized.slice(1), 'index.html');
}

function hasHrefInHtml(html, href) {
  const normalized = normalizePath(href);
  const variants = normalized === '/' ? ['/'] : [normalized, `${normalized}/`];
  return variants.some(
    (value) => html.includes(`href="${value}"`) || html.includes(`href='${value}'`) || html.includes(`href="${value}#`)
  );
}

async function main() {
  if (!fs.existsSync(GENERATED_PAGES_PATH)) {
    throw new Error('generated-pages.json is missing. Run "npm run build:data" first.');
  }
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('dist is missing. Run "npm run build" first.');
  }

  const pages = JSON.parse(fs.readFileSync(GENERATED_PAGES_PATH, 'utf8'));
  assert(Array.isArray(pages), 'generated-pages.json must be an array');
  const policyModule = await loadIndexabilityPolicyModule();
  const getIndexabilityPolicy =
    typeof policyModule.getIndexabilityPolicy === 'function' ? policyModule.getIndexabilityPolicy : null;
  assert(getIndexabilityPolicy, 'indexability policy module must export getIndexabilityPolicy(pathname)');

  const knownSlugs = new Set(pages.map((page) => normalizePath(page?.pageSlug)));
  for (const page of pages) {
    const cityId = String(page?.cityId || '').trim();
    if (cityId) {
      knownSlugs.add(normalizePath(`/${cityId}/`));
    }
  }
  const errors = [];

  for (const page of pages) {
    const slug = normalizePath(page?.pageSlug);
    const related = Array.isArray(page?.related) ? page.related : [];
    if (related.length < 2) {
      errors.push(`[${slug}] related links must be >= 2, got ${related.length}`);
      continue;
    }

    const seen = new Set();
    for (const item of related) {
      const href = normalizePath(item?.href);
      if (!href || href === '/') {
        errors.push(`[${slug}] related href is invalid`);
        continue;
      }
      if (seen.has(href)) {
        errors.push(`[${slug}] duplicate related href "${href}"`);
      }
      seen.add(href);

      const routePolicy = getIndexabilityPolicy(href);
      const isKnownRoute = Boolean(routePolicy?.isKnown);
      if (!knownSlugs.has(href) && !isKnownRoute) {
        errors.push(`[${slug}] related href "${href}" is not present in generated pages or known content routes`);
      }

      const title = String(item?.title || '').trim();
      if (!title) {
        errors.push(`[${slug}] related link "${href}" has empty title`);
      }
    }

    const htmlPath = toDistHtmlPath(slug);
    if (!fs.existsSync(htmlPath)) {
      errors.push(`[${slug}] runtime HTML is missing: ${path.relative(ROOT, htmlPath).replace(/\\/g, '/')}`);
      continue;
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    const runtimeMatches = related.filter((item) => hasHrefInHtml(html, item?.href || '')).length;
    const requiredRuntimeMatches = Math.min(2, related.length);
    if (runtimeMatches < requiredRuntimeMatches) {
      errors.push(
        `[${slug}] runtime HTML renders only ${runtimeMatches}/${related.length} related links (required >= ${requiredRuntimeMatches})`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Related links check failed (${errors.length}):\n${errors.join('\n')}`);
  }

  console.log(`Related links check passed: ${pages.length} generated pages validated.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
