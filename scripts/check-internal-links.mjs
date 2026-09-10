import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');

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

function extractInternalLinks(html) {
  const links = [];
  const regex = /href\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const rawHref = String(match[2] || '').trim();
    if (
      !rawHref ||
      rawHref.startsWith('#') ||
      rawHref.startsWith('mailto:') ||
      rawHref.startsWith('tel:') ||
      rawHref.startsWith('javascript:') ||
      rawHref.startsWith('data:') ||
      rawHref.startsWith('//') ||
      rawHref.startsWith('http://') ||
      rawHref.startsWith('https://')
    ) {
      continue;
    }

    const cleanPath = rawHref.split(/[?#]/)[0] || '/';
    if (cleanPath.startsWith('/_astro/') || cleanPath.startsWith('/.netlify/')) {
      continue;
    }
    if (/\.[a-z0-9]{2,6}$/i.test(cleanPath)) {
      continue;
    }

    links.push({
      rawHref,
      path: normalizeRoutePath(cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`),
    });
  }
  return links;
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('Internal link check failed: dist directory is missing. Run `npm run build` first.');
  process.exit(1);
}

const htmlFiles = walkHtmlFiles(DIST_DIR);
const builtRoutes = new Set(htmlFiles.map((filePath) => normalizeRoutePath(toRoutePath(filePath))));

const errors = [];

for (const filePath of htmlFiles) {
  const html = fs.readFileSync(filePath, 'utf8');
  const pageRef = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const links = extractInternalLinks(html);

  for (const link of links) {
    if (!builtRoutes.has(link.path)) {
      errors.push(`[${pageRef}] broken internal link "${link.rawHref}" -> "${link.path}"`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Internal link check failed (${errors.length}):\n${errors.join('\n')}`);
  process.exit(1);
}

console.log(`Internal link check passed: ${htmlFiles.length} HTML files checked.`);
