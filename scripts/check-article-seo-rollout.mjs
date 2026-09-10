import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const ARTICLE_SEO_STATE_PATH = path.join(ROOT, 'data', 'article-seo-state.json');
const SITEMAP_PATTERN = /^sitemap(?:-(?:index|\d+))?\.xml$/i;
const SITEMAP_ROUTE_PATTERN = /^\/sitemap(?:-(?:index|\d+))?\.xml$/i;

function normalizeRoutePath(routePath) {
  if (!routePath || routePath === '/') return '/';
  return routePath.replace(/\/+$/, '') || '/';
}

function toDistHtmlPath(routePath) {
  const normalized = normalizeRoutePath(routePath);
  if (normalized === '/') return path.join(DIST_DIR, 'index.html');
  return path.join(DIST_DIR, normalized.slice(1), 'index.html');
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

function toRoutePath(filePath) {
  const relative = path.relative(DIST_DIR, filePath).replace(/\\/g, '/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'/index.html'.length)}`;
  if (relative.endsWith('.html')) return `/${relative.slice(0, -'.html'.length)}`;
  return `/${relative}`;
}

function parseTagAttributes(tag) {
  const attrs = {};
  const attrRegex = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = attrRegex.exec(tag)) !== null) {
    const key = String(match[1] || '').toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = String(value);
  }
  return attrs;
}

function parseRobotsMeta(html) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const attrs = parseTagAttributes(tag);
    if ((attrs.name || '').toLowerCase() !== 'robots') continue;
    return String(attrs.content || '')
      .toLowerCase()
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function collectSitemapPaths() {
  const sitemapFiles = fs
    .readdirSync(DIST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SITEMAP_PATTERN.test(entry.name))
    .map((entry) => path.join(DIST_DIR, entry.name));

  const paths = new Set();
  const regex = /<loc>([^<]+)<\/loc>/gi;

  for (const filePath of sitemapFiles) {
    const xml = fs.readFileSync(filePath, 'utf8');
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const value = String(match[1] || '').trim();
      if (!value) continue;
      try {
        const parsed = new URL(value);
        const pathname = normalizeRoutePath(parsed.pathname);
        if (!SITEMAP_ROUTE_PATTERN.test(pathname)) {
          paths.add(pathname);
        }
      } catch {
        // Ignore malformed locs here; dedicated sitemap gates handle them.
      }
    }
  }

  return paths;
}

function extractArticleLinks(html) {
  const hrefs = new Set();
  const regex = /href\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const rawHref = String(match[2] || '').trim();
    if (!rawHref.startsWith('/articles/')) continue;
    const pathname = normalizeRoutePath(rawHref.split(/[?#]/)[0]);
    if (pathname !== '/articles') {
      hrefs.add(pathname);
    }
  }
  return hrefs;
}

function expectRobots(routePath, html, expectedDirectives, errors) {
  const robots = parseRobotsMeta(html);
  const normalized = robots.join(',');
  const expected = expectedDirectives.join(',');
  if (normalized !== expected) {
    errors.push(`${routePath}: expected robots "${expected}", got "${normalized || '(missing)'}"`);
  }
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('Article SEO rollout check failed: dist directory is missing. Run `npm run build` first.');
  process.exit(1);
}

if (!fs.existsSync(ARTICLE_SEO_STATE_PATH)) {
  console.error(
    'Article SEO rollout check failed: data/article-seo-state.json is missing. Run `npm run build:data` first.'
  );
  process.exit(1);
}

const articleSeoState = JSON.parse(fs.readFileSync(ARTICLE_SEO_STATE_PATH, 'utf8'));
const readyArticlePaths = new Set(
  Array.isArray(articleSeoState?.readyArticlePaths)
    ? articleSeoState.readyArticlePaths.map((item) => normalizeRoutePath(item))
    : []
);
const archivedArticlePaths = new Set(
  Array.isArray(articleSeoState?.archivedArticlePaths)
    ? articleSeoState.archivedArticlePaths.map((item) => normalizeRoutePath(item))
    : []
);
const noindexArticlePaths = new Set(
  Array.isArray(articleSeoState?.noindexArticlePaths)
    ? articleSeoState.noindexArticlePaths.map((item) => normalizeRoutePath(item))
    : []
);
const hasReadyArticles = Boolean(articleSeoState?.hasReadyArticles);
const sitemapPaths = collectSitemapPaths();
const htmlFiles = walkHtmlFiles(DIST_DIR);
const articleDetailRoutes = htmlFiles
  .map((filePath) => normalizeRoutePath(toRoutePath(filePath)))
  .filter((routePath) => routePath.startsWith('/articles/') && routePath !== '/articles');
const errors = [];

const articleListPath = '/articles';
const articleListHtmlPath = toDistHtmlPath(articleListPath);
if (!fs.existsSync(articleListHtmlPath)) {
  errors.push('/articles: missing built HTML');
} else {
  const articleListHtml = fs.readFileSync(articleListHtmlPath, 'utf8');
  expectRobots(
    articleListPath,
    articleListHtml,
    hasReadyArticles ? ['index', 'follow'] : ['noindex', 'follow'],
    errors
  );
  const linkedArticlePaths = extractArticleLinks(articleListHtml);

  for (const readyPath of readyArticlePaths) {
    if (!linkedArticlePaths.has(readyPath)) {
      errors.push(`/articles: ready article "${readyPath}" is missing from the article list`);
    }
  }

  for (const linkedPath of linkedArticlePaths) {
    if (!readyArticlePaths.has(linkedPath)) {
      errors.push(`/articles: non-ready article "${linkedPath}" must not be rendered in the article list`);
    }
  }
}

for (const routePath of articleDetailRoutes) {
  const htmlPath = toDistHtmlPath(routePath);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const isArchived = archivedArticlePaths.has(routePath);
  const isExplicitNoindex = noindexArticlePaths.has(routePath);
  const isReady = readyArticlePaths.has(routePath);

  if (isArchived || isExplicitNoindex) {
    expectRobots(routePath, html, ['noindex', 'nofollow'], errors);
    if (sitemapPaths.has(routePath)) {
      errors.push(`${routePath}: noindex article must not be present in sitemap`);
    }
    continue;
  }

  expectRobots(routePath, html, isReady ? ['index', 'follow'] : ['noindex', 'follow'], errors);

  if (isReady && !sitemapPaths.has(routePath)) {
    errors.push(`${routePath}: ready article is missing from sitemap`);
  }

  if (!isReady && sitemapPaths.has(routePath)) {
    errors.push(`${routePath}: non-ready article must not be present in sitemap`);
  }
}

if (hasReadyArticles && readyArticlePaths.size === 0) {
  errors.push('article seo state claims hasReadyArticles=true but readyArticlePaths is empty');
}

if (errors.length > 0) {
  console.error(
    `Article SEO rollout check failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`
  );
  process.exit(1);
}

console.log(
  `Article SEO rollout check passed: ready=${readyArticlePaths.size}, builtArticles=${articleDetailRoutes.length}, hasReadyArticles=${hasReadyArticles}.`
);
