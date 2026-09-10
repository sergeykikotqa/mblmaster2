import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const METRIKA_SRC = '/scripts/metrika.js';

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

function shouldSkipRoute(routePath) {
  if (routePath === '/admin' || routePath.startsWith('/admin/')) return true;
  if (routePath === '/api' || routePath.startsWith('/api/')) return true;
  if (routePath === '/decapcms' || routePath.startsWith('/decapcms/')) return true;
  return false;
}

function readRequiredMetrikaId() {
  const metrikaId = String(process.env.PUBLIC_YANDEX_METRIKA_ID || '').trim();
  if (!metrikaId) {
    throw new Error('Missing required env: PUBLIC_YANDEX_METRIKA_ID');
  }
  if (!/^\d{4,}$/.test(metrikaId)) {
    throw new Error('PUBLIC_YANDEX_METRIKA_ID must be a numeric counter id');
  }
  return metrikaId;
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('Metrika embed check failed: dist directory is missing. Run `npm run build` first.');
  process.exit(1);
}

const metrikaId = readRequiredMetrikaId();
const htmlFiles = walkHtmlFiles(DIST_DIR);
const errors = [];

for (const filePath of htmlFiles) {
  const routePath = normalizeRoutePath(toRoutePath(filePath));
  if (shouldSkipRoute(routePath)) continue;

  const html = fs.readFileSync(filePath, 'utf8');
  const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
  const metrikaTags = scriptTags
    .map((tag) => ({ tag, attrs: parseTagAttributes(tag) }))
    .filter((item) => String(item.attrs.src || '').includes(METRIKA_SRC));

  if (metrikaTags.length === 0) {
    errors.push(`[${routePath}] missing ${METRIKA_SRC}`);
    continue;
  }

  if (metrikaTags.length > 1) {
    errors.push(`[${routePath}] duplicate ${METRIKA_SRC} (${metrikaTags.length})`);
    continue;
  }

  const dataId = String(metrikaTags[0].attrs['data-metrika-id'] || '').trim();
  if (!dataId) {
    errors.push(`[${routePath}] ${METRIKA_SRC} missing data-metrika-id`);
    continue;
  }
  if (dataId !== metrikaId) {
    errors.push(`[${routePath}] ${METRIKA_SRC} data-metrika-id mismatch (expected ${metrikaId}, got ${dataId})`);
  }
}

if (errors.length > 0) {
  console.error(`Metrika embed check failed (${errors.length}):\n${errors.join('\n')}`);
  process.exit(1);
}

console.log(`Metrika embed check passed: ${htmlFiles.length} HTML files checked.`);
