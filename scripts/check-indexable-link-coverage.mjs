import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const DEFAULT_MIN_INBOUND_LINKS = 1;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parsePositiveInt(value, fallback, min = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function normalizeRoutePath(pathname) {
  const normalized = `/${String(pathname || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function normalizeIndexabilityPolicy(indexabilityPolicy, pageType) {
  const raw = String(indexabilityPolicy || '').trim();
  if (raw === 'index') return 'index';
  if (raw === 'noindex_nofollow') return 'noindex_nofollow';
  if (raw === 'noindex_follow' || raw === 'noindex') return 'noindex_follow';
  return String(pageType || '').trim() === 'service-money' ? 'index' : 'noindex_follow';
}

function walkHtmlFiles(dirPath) {
  const output = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        output.push(fullPath);
      }
    }
  }
  return output;
}

function routePathFromHtmlFile(filePath) {
  const relative = path.relative(DIST_DIR, filePath).replace(/\\/g, '/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) {
    return normalizeRoutePath(relative.slice(0, -'/index.html'.length));
  }
  if (relative.endsWith('.html')) {
    return normalizeRoutePath(relative.slice(0, -'.html'.length));
  }
  return normalizeRoutePath(relative);
}

function extractInternalLinks(html, sourceRoutePath, sourceFile) {
  const links = new Set();
  const warnings = [];
  const regex = /href\s*=\s*(["'])(.*?)\1/gi;
  let match = regex.exec(html);

  while (match) {
    const rawHref = String(match[2] || '').trim();
    if (
      !rawHref ||
      rawHref.startsWith('#') ||
      rawHref.startsWith('mailto:') ||
      rawHref.startsWith('tel:') ||
      rawHref.startsWith('javascript:') ||
      rawHref.startsWith('data:') ||
      rawHref.startsWith('//')
    ) {
      match = regex.exec(html);
      continue;
    }

    try {
      let resolved;
      if (/^https?:\/\//i.test(rawHref)) {
        resolved = new URL(rawHref).pathname;
      } else if (rawHref.startsWith('/')) {
        resolved = rawHref;
        const normalized = normalizeRoutePath(rawHref.split(/[?#]/)[0] || '/');
        if (normalized !== rawHref && sourceFile) {
          warnings.push({
            href: rawHref,
            normalized,
            file: sourceFile,
          });
        }
      } else {
        const basePath = sourceRoutePath === '/' ? '/' : `${sourceRoutePath}/`;
        resolved = new URL(rawHref, `https://local.test${basePath}`).pathname;
      }

      links.add(normalizeRoutePath(resolved));
    } catch {
      // Ignore malformed href values and continue.
    }

    match = regex.exec(html);
  }

  return { links, warnings };
}

function main() {
  assert(fs.existsSync(GENERATED_PAGES_PATH), 'generated-pages.json is missing. Run "npm run build:data" first.');
  assert(fs.existsSync(DIST_DIR), 'dist is missing. Run "npm run build" first.');

  const minInboundLinks = parsePositiveInt(process.env.INDEXABLE_MIN_INBOUND_LINKS, DEFAULT_MIN_INBOUND_LINKS, 1);
  const pages = JSON.parse(fs.readFileSync(GENERATED_PAGES_PATH, 'utf8'));
  assert(Array.isArray(pages), 'generated-pages.json must be an array');

  const indexablePages = pages.filter(
    (page) => normalizeIndexabilityPolicy(page?.indexabilityPolicy, page?.pageType) === 'index'
  );
  assert(indexablePages.length > 0, 'generated-pages.json has no indexable pages');

  const indexablePaths = new Set(indexablePages.map((page) => normalizeRoutePath(page.pageSlug)));
  const inboundSourcesByPath = new Map();
  for (const page of indexablePages) {
    inboundSourcesByPath.set(normalizeRoutePath(page.pageSlug), new Set());
  }

  const htmlFiles = walkHtmlFiles(DIST_DIR);
  const warnings = [];
  for (const htmlFile of htmlFiles) {
    const sourcePath = routePathFromHtmlFile(htmlFile);
    const html = fs.readFileSync(htmlFile, 'utf8');
    const { links: targets, warnings: linkWarnings } = extractInternalLinks(html, sourcePath, htmlFile);
    warnings.push(...linkWarnings);

    for (const targetPath of targets) {
      if (!indexablePaths.has(targetPath)) continue;
      if (targetPath === sourcePath) continue;
      inboundSourcesByPath.get(targetPath)?.add(sourcePath);
    }
  }

  const failures = [];
  const report = [];
  for (const page of indexablePages) {
    const targetPath = normalizeRoutePath(page.pageSlug);
    const inboundSources = inboundSourcesByPath.get(targetPath) || new Set();
    const inboundCount = inboundSources.size;
    report.push({
      pageSlug: targetPath,
      inboundSources: inboundCount,
    });

    if (inboundCount < minInboundLinks) {
      failures.push({
        pageSlug: targetPath,
        inboundSources: inboundCount,
        examples: [...inboundSources].slice(0, 6),
      });
    }
  }

  report.sort((left, right) => left.inboundSources - right.inboundSources);

  if (failures.length > 0) {
    const details = failures
      .map(
        (item) => `- ${item.pageSlug}: inbound=${item.inboundSources}, examples=[${item.examples.join(', ') || 'none'}]`
      )
      .join('\n');
    throw new Error(`Indexable link coverage check failed (min inbound=${minInboundLinks}):\n${details}`);
  }

  if (warnings.length > 0) {
    const details = warnings
      .map((item) => {
        const pageRef = path.relative(ROOT, item.file).replace(/\\/g, '/');
        return `- ${pageRef}: href="${item.href}" -> normalized="${item.normalized}"`;
      })
      .join('\n');
    console.warn(`Indexable link coverage warnings (${warnings.length}):\n${details}`);
  }

  const floor = report[0]?.inboundSources ?? 0;
  console.log(
    `Indexable link coverage check passed: ${report.length} pages, min inbound=${minInboundLinks}, observed floor=${floor}.`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
