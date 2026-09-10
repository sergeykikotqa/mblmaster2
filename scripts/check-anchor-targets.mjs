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

function extractAnchors(html) {
  const ids = new Set();
  const idMatches = html.matchAll(/\sid\s*=\s*(['"])(.*?)\1/gi);
  for (const match of idMatches) {
    const id = String(match[2] || '').trim();
    if (id) ids.add(id);
  }

  const nameMatches = html.matchAll(/\sname\s*=\s*(['"])(.*?)\1/gi);
  for (const match of nameMatches) {
    const name = String(match[2] || '').trim();
    if (name) ids.add(name);
  }

  return ids;
}

function extractAnchorLinks(html) {
  const links = [];
  const hrefMatches = html.matchAll(/href\s*=\s*(["'])(.*?)\1/gi);
  for (const match of hrefMatches) {
    const rawHref = String(match[2] || '').trim();
    if (!rawHref) continue;
    const decodedHref = rawHref.replace(/&#38;|&amp;/g, '&');
    if (
      decodedHref.startsWith('mailto:') ||
      decodedHref.startsWith('tel:') ||
      decodedHref.startsWith('javascript:')
    ) {
      continue;
    }
    if (decodedHref.startsWith('http://') || decodedHref.startsWith('https://') || decodedHref.startsWith('//')) {
      continue;
    }
    if (decodedHref.startsWith('/_astro/') || decodedHref.startsWith('/.netlify/')) {
      continue;
    }

    const hashIndex = decodedHref.indexOf('#');
    if (hashIndex === -1) continue;

    const pathPart = decodedHref.slice(0, hashIndex);
    const anchor = decodedHref.slice(hashIndex + 1);
    if (!anchor || anchor === 'top') {
      continue;
    }

    links.push({
      rawHref: decodedHref,
      pathPart,
      anchor,
    });
  }
  return links;
}

function resolveTargetRoute(sourceRoute, pathPart) {
  if (!pathPart) return sourceRoute;
  if (pathPart.startsWith('/')) return normalizeRoutePath(pathPart);
  const base = sourceRoute === '/' ? '/' : `${sourceRoute}/`;
  try {
    return normalizeRoutePath(new URL(pathPart, `https://local.test${base}`).pathname);
  } catch {
    return normalizeRoutePath(pathPart);
  }
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('Anchor target check failed: dist directory is missing. Run `npm run build` first.');
  process.exit(1);
}

const htmlFiles = walkHtmlFiles(DIST_DIR);
const anchorsByRoute = new Map();

for (const filePath of htmlFiles) {
  const html = fs.readFileSync(filePath, 'utf8');
  const routePath = normalizeRoutePath(toRoutePath(filePath));
  anchorsByRoute.set(routePath, extractAnchors(html));
}

const errors = [];

for (const filePath of htmlFiles) {
  const html = fs.readFileSync(filePath, 'utf8');
  const routePath = normalizeRoutePath(toRoutePath(filePath));
  const links = extractAnchorLinks(html);
  const pageRef = path.relative(ROOT, filePath).replace(/\\/g, '/');

  for (const link of links) {
    const targetRoute = resolveTargetRoute(routePath, link.pathPart);
    const anchors = anchorsByRoute.get(targetRoute);
    if (!anchors || !anchors.has(link.anchor)) {
      errors.push(`[${pageRef}] missing anchor "#${link.anchor}" in "${targetRoute}" (href="${link.rawHref}")`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Anchor target check failed (${errors.length}):\n${errors.join('\n')}`);
  process.exit(1);
}

console.log(`Anchor target check passed: ${htmlFiles.length} HTML files checked.`);
