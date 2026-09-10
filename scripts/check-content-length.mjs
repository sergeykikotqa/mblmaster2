import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const MIN_MAIN_WORDS = Number(process.env.MIN_MONEY_PAGE_WORDS || 600);
const MIN_CITY_BLOCK_WORDS = Number(process.env.MIN_CITY_BLOCK_WORDS || 200);

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

function countWords(value) {
  return stripHtml(value).split(/\s+/).filter(Boolean).length;
}

function extractMain(html) {
  const match = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return match ? match[1] : html;
}

function extractCityBlocks(html) {
  const blocks = [];
  const regex = /<article\b[^>]*data-local-city-block=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    blocks.push({
      city: match[2],
      html: match[3],
    });
  }
  return blocks;
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
    const mainWords = countWords(extractMain(html));
    if (mainWords < MIN_MAIN_WORDS) {
      errors.push(`- ${slug}: main content has ${mainWords} words, expected >= ${MIN_MAIN_WORDS}`);
    }

    const cityBlocks = extractCityBlocks(html);
    for (const block of cityBlocks) {
      const blockWords = countWords(block.html);
      if (blockWords < MIN_CITY_BLOCK_WORDS) {
        errors.push(
          `- ${slug}: city block "${block.city}" has ${blockWords} words, expected >= ${MIN_CITY_BLOCK_WORDS}`
        );
      }
    }
  }

  if (errors.length > 0) {
    fail(`Content length gate failed.\n${errors.join('\n')}`);
  }

  console.log(
    `Content length gate passed: main>=${MIN_MAIN_WORDS}, city-block>=${MIN_CITY_BLOCK_WORDS}, pages=${pages.length}.`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
