import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const STRICT_MODE = String(process.env.SEO_JARGON_STRICT || '').toLowerCase() === 'true';
const TARGET_ROUTES = new Set([
  '/',
  '/contacts',
  '/o-kompanii',
  '/kuhni',
  '/shkafy',
  '/garderobnye',
  '/irkutsk',
  '/angarsk',
  '/shelekhov',
]);
const FORBIDDEN_PATTERNS = [
  /money-страниц/gi,
  /money page/gi,
  /thin geo/gi,
  /geo-дубл/gi,
  /local city blocks/gi,
  /ux hub/gi,
  /seo page/gi,
];

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

function toVisibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('SEO jargon check failed: dist directory is missing. Run `npm run build` first.');
  process.exit(1);
}

const warnings = [];
const htmlFiles = walkHtmlFiles(DIST_DIR);

for (const filePath of htmlFiles) {
  const routePath = normalizeRoutePath(toRoutePath(filePath));
  if (!TARGET_ROUTES.has(routePath)) continue;

  const html = fs.readFileSync(filePath, 'utf8');
  const visibleText = toVisibleText(html);
  const pageRef = path.relative(ROOT, filePath).replace(/\\/g, '/');

  for (const pattern of FORBIDDEN_PATTERNS) {
    const matches = visibleText.match(pattern);
    if (matches?.length) {
      warnings.push(`[${pageRef}] forbidden SEO jargon matched pattern "${pattern}"`);
    }
  }
}

if (warnings.length > 0) {
  const header = `SEO jargon check found ${warnings.length} issue(s).`;
  if (STRICT_MODE) {
    console.error(`${header}\n${warnings.join('\n')}`);
    process.exit(1);
  }

  console.warn(`${header}\n${warnings.join('\n')}`);
} else {
  console.log(`SEO jargon check passed: ${TARGET_ROUTES.size} target route groups scanned.`);
}
