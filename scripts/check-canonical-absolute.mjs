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

function parseTagAttributes(tag) {
  const attributes = {};
  const attrRegex = /([^\s=/>]+)\s*=\s*(['"])([\s\S]*?)\2/g;
  let match;
  while ((match = attrRegex.exec(tag)) !== null) {
    attributes[match[1].toLowerCase()] = match[3];
  }
  return attributes;
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('Canonical absolute check failed: dist directory is missing. Run `npm run build` first.');
  process.exit(1);
}

const errors = [];
const htmlFiles = walkHtmlFiles(DIST_DIR);

for (const filePath of htmlFiles) {
  const html = fs.readFileSync(filePath, 'utf8');
  const routePath = normalizeRoutePath(toRoutePath(filePath));
  const pageRef = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const canonicalMatches = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => parseTagAttributes(match[0]))
    .filter((attrs) => (attrs.rel || '').toLowerCase().split(/\s+/).includes('canonical'))
    .map((attrs) => String(attrs.href || '').trim());

  for (const canonical of canonicalMatches) {
    if (canonical.startsWith('/')) {
      errors.push(`[${pageRef}] canonical must be absolute, got "${canonical}" for route "${routePath}"`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Canonical absolute check failed (${errors.length}):\n${errors.join('\n')}`);
  process.exit(1);
}

console.log(`Canonical absolute check passed: ${htmlFiles.length} HTML files checked.`);
