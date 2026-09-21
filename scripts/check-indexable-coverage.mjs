import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const REQUIRED_CITY_BLOCKS = ['irkutsk'];

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

function main() {
  if (!fs.existsSync(GENERATED_PAGES_PATH)) {
    fail('generated-pages.json is missing. Run "npm run build:data" first.');
  }
  if (!fs.existsSync(DIST_DIR)) {
    fail('dist is missing. Run "npm run build" first.');
  }

  const pages = JSON.parse(fs.readFileSync(GENERATED_PAGES_PATH, 'utf8')).filter(
    (page) => String(page?.pageType || '') === 'service-money'
  );
  const errors = [];

  for (const page of pages) {
    const slug = normalizePathname(page.pageSlug);
    const htmlPath = toDistHtmlPath(slug);
    if (!fs.existsSync(htmlPath)) {
      errors.push(`- ${slug}: missing HTML at ${path.relative(ROOT, htmlPath).replace(/\\/g, '/')}`);
      continue;
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    const presentCities = new Set();
    const regex = /data-local-city-block=(["'])([^"']+)\1/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      presentCities.add(
        String(match[2] || '')
          .trim()
          .toLowerCase()
      );
    }

    const missing = REQUIRED_CITY_BLOCKS.filter((city) => !presentCities.has(city));
    if (missing.length > 0) {
      errors.push(`- ${slug}: missing LocalCityBlock sections for [${missing.join(', ')}]`);
    }
  }

  if (errors.length > 0) {
    fail(`Indexable coverage gate failed.\n${errors.join('\n')}`);
  }

  console.log(
    `Indexable coverage gate passed: ${pages.length} money pages contain all required LocalCityBlock sections.`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
