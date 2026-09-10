import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const SKIP_PATHS = new Set(['/404', '/decapcms', '/projects/kuhnya-baykalskaya']);

function shouldSkipRoute(routePath) {
  if (SKIP_PATHS.has(routePath)) return true;
  if (routePath === '/admin' || routePath.startsWith('/admin/')) return true;
  if (routePath === '/api' || routePath.startsWith('/api/')) return true;
  return false;
}

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

function findAllByRegex(input, regex) {
  const result = [];
  const cloned = new RegExp(regex.source, regex.flags);
  let match;
  while ((match = cloned.exec(input)) !== null) {
    result.push(match);
  }
  return result;
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
  console.error('SEO gates failed: dist directory is missing. Run `npm run build` before `npm run check:seo`.');
  process.exit(1);
}

const htmlFiles = walkHtmlFiles(DIST_DIR);
const errors = [];
const titleToPaths = new Map();
const descriptionToPaths = new Map();
const canonicalToPaths = new Map();

for (const filePath of htmlFiles) {
  const routePath = normalizeRoutePath(toRoutePath(filePath));
  if (shouldSkipRoute(routePath)) continue;

  const html = fs.readFileSync(filePath, 'utf8');
  const titleMatches = findAllByRegex(html, /<title>([\s\S]*?)<\/title>/gi);
  const metaTags = findAllByRegex(html, /<meta\b[^>]*>/gi);
  const linkTags = findAllByRegex(html, /<link\b[^>]*>/gi);
  const descriptionMatches = metaTags
    .map((match) => parseTagAttributes(match[0]))
    .filter((attrs) => attrs.name?.toLowerCase() === 'description')
    .map((attrs) => attrs.content || '');
  const robotsMatches = metaTags
    .map((match) => parseTagAttributes(match[0]))
    .filter((attrs) => attrs.name?.toLowerCase() === 'robots')
    .map((attrs) => attrs.content || '');
  const canonicalMatches = linkTags
    .map((match) => parseTagAttributes(match[0]))
    .filter((attrs) => (attrs.rel || '').toLowerCase().split(/\s+/).includes('canonical'))
    .map((attrs) => attrs.href || '');
  const h1Count = findAllByRegex(html, /<h1\b/gi).length;

  const pageRef = path.relative(ROOT, filePath).replace(/\\/g, '/');

  if (titleMatches.length !== 1) {
    errors.push(`[${pageRef}] expected exactly 1 <title>, got ${titleMatches.length}`);
  }
  if (descriptionMatches.length !== 1) {
    errors.push(`[${pageRef}] expected exactly 1 meta description, got ${descriptionMatches.length}`);
  }
  if (canonicalMatches.length !== 1) {
    errors.push(`[${pageRef}] expected exactly 1 canonical link, got ${canonicalMatches.length}`);
  }
  if (h1Count !== 1) {
    errors.push(`[${pageRef}] expected exactly 1 <h1>, got ${h1Count}`);
  }

  const title = titleMatches[0]?.[1]?.trim() || '';
  const description = descriptionMatches[0]?.trim() || '';
  const canonical = canonicalMatches[0]?.trim() || '';
  const robots = robotsMatches[0]?.trim().toLowerCase() || '';
  const isNoindex = robots
    .split(',')
    .map((item) => item.trim())
    .includes('noindex');

  if (!title) {
    errors.push(`[${pageRef}] empty <title> is not allowed`);
  } else {
    const list = titleToPaths.get(title) || [];
    list.push(routePath);
    titleToPaths.set(title, list);
  }

  if (!description) {
    errors.push(`[${pageRef}] empty meta description is not allowed`);
  } else {
    const list = descriptionToPaths.get(description) || [];
    list.push(routePath);
    descriptionToPaths.set(description, list);
  }

  if (canonical) {
    try {
      const parsed = new URL(canonical);
      const canonicalPath = normalizeRoutePath(parsed.pathname);
      if (canonicalPath !== routePath) {
        errors.push(`[${pageRef}] canonical path mismatch: expected "${routePath}", got "${canonicalPath}"`);
      }
      if (parsed.search || parsed.hash) {
        errors.push(`[${pageRef}] canonical must not include query/hash, got "${canonical}"`);
      }

      const list = canonicalToPaths.get(canonicalPath) || [];
      list.push({
        routePath,
        isNoindex,
      });
      canonicalToPaths.set(canonicalPath, list);
    } catch {
      errors.push(`[${pageRef}] canonical must be an absolute URL, got "${canonical}"`);
    }
  }
}

for (const [title, paths] of titleToPaths.entries()) {
  if (paths.length > 1) {
    errors.push(`duplicate title "${title}" on routes: ${paths.join(', ')}`);
  }
}

for (const [description, paths] of descriptionToPaths.entries()) {
  if (paths.length > 1) {
    errors.push(`duplicate description "${description}" on routes: ${paths.join(', ')}`);
  }
}

for (const [canonical, entries] of canonicalToPaths.entries()) {
  const indexablePaths = entries.filter((entry) => !entry.isNoindex).map((entry) => entry.routePath);
  if (indexablePaths.length > 1) {
    errors.push(`duplicate canonical "${canonical}" on routes: ${indexablePaths.join(', ')}`);
  }
}

if (errors.length > 0) {
  console.error(`SEO quality gates failed (${errors.length}):\n${errors.join('\n')}`);
  process.exit(1);
}

console.log(`SEO quality gates passed: ${htmlFiles.length} HTML files checked.`);
