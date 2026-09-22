import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const REQUIRED_SERVICE_CITIES = ['irkutsk'];

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

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countServiceCityBlocks(html) {
  const regex = /<article\b[^>]*class=(['"])([^'"]*\bcity-block\b[^'"]*)\1[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  let count = 0;
  while ((match = regex.exec(html)) !== null) {
    const blockHtml = match[3] || '';
    const mention = stripHtml(blockHtml).toLowerCase();
    if (/(irkutsk|иркутск)/i.test(mention) || /data-geo-mention-layer/i.test(blockHtml)) {
      count += 1;
    }
  }
  return count;
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
    const irkutskBlocks = countServiceCityBlocks(html);
    if (irkutskBlocks === 0) {
      errors.push(`- ${slug}: missing LocalCityBlock evidence for [${REQUIRED_SERVICE_CITIES.join(', ')}]`);
    }
  }

  if (errors.length > 0) {
    fail(`Indexable coverage gate failed.\n${errors.join('\n')}`);
  }

  console.log(
    `Indexable coverage gate passed: ${pages.length} money pages contain LocalCityBlock evidence for [${REQUIRED_SERVICE_CITIES.join(', ')}].`
  );
}

export { countServiceCityBlocks };

const isDirectExecution = () => {
  const currentFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  const moduleFilePath = fileURLToPath(import.meta.url);
  return Boolean(currentFilePath) && path.resolve(currentFilePath) === path.resolve(moduleFilePath);
};

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
