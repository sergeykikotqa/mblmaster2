import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const DIST_DIR = path.join(ROOT, 'dist');

function countWords(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function normalizePath(pathname) {
  const normalized = `/${String(pathname || '').replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function toDistHtmlPath(pageSlug) {
  const normalized = normalizePath(pageSlug);
  if (normalized === '/') return path.join(DIST_DIR, 'index.html');
  return path.join(DIST_DIR, normalized.slice(1), 'index.html');
}

function main() {
  if (!fs.existsSync(GENERATED_PAGES_PATH)) {
    throw new Error('generated-pages.json is missing. Run "npm run build:data" first.');
  }
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('dist is missing. Run "npm run build" first.');
  }

  const pages = JSON.parse(fs.readFileSync(GENERATED_PAGES_PATH, 'utf8'));
  assert(Array.isArray(pages), 'generated-pages.json must be an array');

  const errors = [];
  for (const page of pages) {
    const slug = normalizePath(page?.pageSlug);
    const faq = Array.isArray(page?.faq) ? page.faq : [];
    if (faq.length < 3) {
      errors.push(`[${slug}] faq count must be >= 3, got ${faq.length}`);
      continue;
    }

    let wordsTotal = 0;
    for (const item of faq) {
      const question = String(item?.q || '').trim();
      const answer = String(item?.a || '').trim();
      if (!question) errors.push(`[${slug}] faq item has empty question`);
      if (!answer) errors.push(`[${slug}] faq item has empty answer`);
      wordsTotal += countWords(question) + countWords(answer);
    }

    if (page?.pageType === 'service-money' && wordsTotal < 120) {
      errors.push(`[${slug}] service-money faqWordsTotal must be >= 120, got ${wordsTotal}`);
    }

    const htmlPath = toDistHtmlPath(slug);
    if (!fs.existsSync(htmlPath)) {
      errors.push(`[${slug}] runtime HTML is missing: ${path.relative(ROOT, htmlPath).replace(/\\/g, '/')}`);
      continue;
    }

    const normalizedHtml = normalizeText(fs.readFileSync(htmlPath, 'utf8'));
    const renderedFaqQuestions = faq.filter((item) => normalizedHtml.includes(normalizeText(item?.q))).length;
    const requiredRenderedFaqQuestions = Math.min(2, faq.length);

    if (renderedFaqQuestions < requiredRenderedFaqQuestions) {
      errors.push(
        `[${slug}] runtime HTML contains only ${renderedFaqQuestions}/${faq.length} FAQ questions (required >= ${requiredRenderedFaqQuestions})`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`FAQ check failed (${errors.length}):\n${errors.join('\n')}`);
  }

  console.log(`FAQ check passed: ${pages.length} generated pages validated.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
