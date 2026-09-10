import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, '.lighthouserc.json');

function normalizeRoutePath(routePath) {
  const normalized = `/${String(routePath || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function toDistHtmlPath(distDir, routePath) {
  const normalized = normalizeRoutePath(routePath);
  if (normalized === '/') return path.join(distDir, 'index.html');
  return path.join(distDir, normalized.slice(1), 'index.html');
}

function parseTargetPathInfo(target) {
  try {
    const pathname = new URL(target).pathname || '/';
    return {
      rawPathname: pathname,
      normalizedPath: normalizeRoutePath(pathname),
    };
  } catch {
    const pathname = String(target || '').trim() || '/';
    return {
      rawPathname: pathname,
      normalizedPath: normalizeRoutePath(pathname),
    };
  }
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

function extractCanonical(html) {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  const canonicals = linkTags
    .map((tag) => parseTagAttributes(tag))
    .filter((attrs) =>
      String(attrs.rel || '')
        .toLowerCase()
        .split(/\s+/)
        .includes('canonical')
    )
    .map((attrs) => String(attrs.href || '').trim())
    .filter(Boolean);

  return canonicals;
}

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Lighthouse route check failed: .lighthouserc.json is missing.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const staticDistDir = String(config?.ci?.collect?.staticDistDir || './dist');
const distDir = path.resolve(ROOT, staticDistDir);
const targets = Array.isArray(config?.ci?.collect?.url) ? config.ci.collect.url : [];

if (!fs.existsSync(distDir)) {
  console.error(
    `Lighthouse route check failed: staticDistDir "${staticDistDir}" does not exist. Run \`npm run build\` first.`
  );
  process.exit(1);
}

if (targets.length === 0) {
  console.error('Lighthouse route check failed: no URLs configured in .lighthouserc.json.');
  process.exit(1);
}

const errors = [];

for (const target of targets) {
  const targetInfo = parseTargetPathInfo(target);
  const htmlPath = toDistHtmlPath(distDir, targetInfo.normalizedPath);
  if (!fs.existsSync(htmlPath)) {
    errors.push(`- ${target} -> ${path.relative(ROOT, htmlPath).replace(/\\/g, '/')}`);
    continue;
  }

  if (targetInfo.rawPathname !== targetInfo.normalizedPath && targetInfo.rawPathname !== '/') {
    errors.push(`- ${target}: LHCI URL must use canonical pathname "${targetInfo.normalizedPath}"`);
    continue;
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const canonicals = extractCanonical(html);
  if (canonicals.length !== 1) {
    errors.push(`- ${target}: expected exactly 1 canonical in ${path.relative(ROOT, htmlPath).replace(/\\/g, '/')}`);
    continue;
  }

  try {
    const canonicalPath = normalizeRoutePath(new URL(canonicals[0]).pathname);
    if (canonicalPath !== targetInfo.normalizedPath) {
      errors.push(
        `- ${target}: canonical path "${canonicalPath}" does not match LHCI path "${targetInfo.normalizedPath}"`
      );
    }
  } catch {
    errors.push(`- ${target}: canonical must be absolute URL, got "${canonicals[0]}"`);
  }
}

if (errors.length > 0) {
  console.error(`Lighthouse route check failed (${errors.length}):\n${errors.join('\n')}`);
  process.exit(1);
}

console.log(`Lighthouse route check passed: ${targets.length} configured URLs exist in ${staticDistDir}.`);
