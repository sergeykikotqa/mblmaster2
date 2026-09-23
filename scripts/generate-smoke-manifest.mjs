import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const OUTPUT_PATH = path.join(ROOT, 'artifacts', 'smoke-manifest.json');
const ARTICLE_SEO_STATE_PATH = path.join(ROOT, 'data', 'article-seo-state.json');

const PROJECT_ANCHOR_ROUTE = '/projects/biruzovaya-uglovaya-kuhnya-irkutsk';

const CONTENT_MAP = [
  { dir: path.join('src', 'content', 'articles'), prefix: '/articles' },
  { dir: path.join('src', 'content', 'guides'), prefix: '/guides' },
  { dir: path.join('src', 'content', 'faq'), prefix: '/faq' },
  { dir: path.join('src', 'content', 'projects'), prefix: '/projects' },
  { dir: path.join('src', 'content', 'services'), prefix: '' },
  { dir: path.join('src', 'content', 'cities'), prefix: '' },
];

const GLOBAL_CHANGE_HINTS = [
  /^astro\.config\./i,
  /^src[\\/]+config[\\/]+indexability-policy/i,
  /^src[\\/]+lib[\\/]+canonical/i,
  /^src[\\/]+lib[\\/]+url-builder/i,
  /^src[\\/]+lib[\\/]+trailing-slash/i,
  /^src[\\/]+layouts[\\/]/i,
  /^src[\\/]+styles[\\/]/i,
  /^src[\\/]+components[\\/]+widgets[\\/]+Header/i,
  /^src[\\/]+components[\\/]+widgets[\\/]+Footer/i,
];

const MAX_LH_ROUTES = Number(process.env.LHCI_SMOKE_MAX_ROUTES || 8);

function normalizeRoutePath(value) {
  const normalized = `/${String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function resolveReadyArticleRoute() {
  const fallback = '/articles/kak-vybrat-kuhnyu-na-zakaz';
  if (!fs.existsSync(ARTICLE_SEO_STATE_PATH)) return fallback;
  try {
    const payload = JSON.parse(fs.readFileSync(ARTICLE_SEO_STATE_PATH, 'utf8'));
    const readyRoutes = Array.isArray(payload?.readyArticlePaths)
      ? payload.readyArticlePaths.map((item) => normalizeRoutePath(item)).filter(Boolean)
      : [];
    return readyRoutes[0] || fallback;
  } catch {
    return fallback;
  }
}

const READY_ARTICLE_ROUTE = resolveReadyArticleRoute();
const SEO_DEFAULT_ROUTES = ['/', '/kuhni', READY_ARTICLE_ROUTE];
const LH_ANCHOR_ROUTES = ['/', '/kuhni', PROJECT_ANCHOR_ROUTE, READY_ARTICLE_ROUTE];
const LH_GLOBAL_ROUTES = [
  '/',
  '/kuhni',
  PROJECT_ANCHOR_ROUTE,
  READY_ARTICLE_ROUTE,
  '/guides/process-izgotovleniya-kuhni',
  '/contacts',
];

const PAGE_SAMPLE_MAP = [
  { match: /src[\\/]+pages[\\/]+projects[\\/]+\[slug\]\.astro$/i, routes: [PROJECT_ANCHOR_ROUTE] },
  { match: /src[\\/]+pages[\\/]+articles[\\/]+\[slug\]\.astro$/i, routes: [READY_ARTICLE_ROUTE] },
  { match: /src[\\/]+pages[\\/]+guides[\\/]+\[slug\]\.astro$/i, routes: ['/guides/process-izgotovleniya-kuhni'] },
  { match: /src[\\/]+pages[\\/]+faq[\\/]+\[slug\]\.astro$/i, routes: ['/faq/voprosy-ob-ispolzovanii-kuhen'] },
  { match: /src[\\/]+pages[\\/]+\[service\]\.astro$/i, routes: ['/kuhni'] },
  { match: /src[\\/]+pages[\\/]+irkutsk\.astro$/i, routes: ['/irkutsk'] },
  { match: /src[\\/]+pages[\\/]+contacts\.astro$/i, routes: ['/contacts'] },
];

const COMPONENT_ROUTE_MAP = [
  { match: /src[\\/]+components[\\/]+projects[\\/]/i, routes: [PROJECT_ANCHOR_ROUTE] },
  { match: /src[\\/]+components[\\/]+case-blocks[\\/]/i, routes: [PROJECT_ANCHOR_ROUTE] },
  { match: /src[\\/]+components[\\/]+content[\\/]+ArticleLayout/i, routes: [READY_ARTICLE_ROUTE] },
  { match: /src[\\/]+components[\\/]+content[\\/]+GuideLayout/i, routes: ['/guides/process-izgotovleniya-kuhni'] },
  { match: /src[\\/]+components[\\/]+widgets[\\/]+Contact/i, routes: ['/contacts'] },
  { match: /src[\\/]+components[\\/]+ContactForm/i, routes: ['/contacts'] },
];

function extractFrontmatter(source) {
  const raw = String(source || '');
  if (!raw.startsWith('---')) return null;
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

function parseMarkdownFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const frontmatterSource = extractFrontmatter(raw);
  if (!frontmatterSource) return {};
  try {
    return (yaml.load(frontmatterSource) || {}) ?? {};
  } catch {
    return {};
  }
}

function slugFromFile(filePath, frontmatter) {
  const base = path.basename(filePath).replace(/\.mdx?$/i, '');
  return String(frontmatter?.slug || base).trim();
}

function readChangedFiles() {
  const base = process.env.SMOKE_DIFF_BASE || 'origin/main';
  const explicitFiles = String(process.env.SMOKE_DIFF_FILES || '').trim();
  if (explicitFiles) {
    return explicitFiles
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  try {
    const output = execSync(`git diff --name-only ${base}...HEAD`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    return String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    try {
      const output = execSync('git diff --name-only HEAD~1...HEAD', {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

function mapContentRoute(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const absolute = path.join(ROOT, filePath);
  if (!fs.existsSync(absolute)) return null;
  for (const entry of CONTENT_MAP) {
    const dir = entry.dir.replace(/\\/g, '/');
    if (!normalized.startsWith(dir)) continue;
    if (!/\.mdx?$/i.test(normalized)) return null;

    const frontmatter = parseMarkdownFrontmatter(absolute);
    if (entry.prefix === '/articles') {
      if (frontmatter?.draft) return null;
      if (frontmatter?.seoReady === false) return null;
      if (frontmatter?.isArchived) return null;
      if (frontmatter?.noindex) return null;
    }
    const slug = slugFromFile(absolute, frontmatter);
    if (!slug) return null;
    const prefix = entry.prefix || '';
    return normalizeRoutePath(prefix ? `${prefix}/${slug}` : `/${slug}`);
  }
  return null;
}

function mapPageRoute(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (!fs.existsSync(path.join(ROOT, filePath))) return null;
  if (normalized.startsWith('src/pages/api/')) return null;
  if (!/\.astro$/i.test(normalized)) return null;

  for (const sample of PAGE_SAMPLE_MAP) {
    if (sample.match.test(normalized)) return sample.routes;
  }

  const pagesRoot = normalizeRoutePath(
    normalized
      .replace(/^src[\\/]+pages/i, '')
      .replace(/\\/g, '/')
      .replace(/index\.astro$/i, '')
      .replace(/\.astro$/i, '')
  );

  if (pagesRoot.includes('[')) return null;
  if (pagesRoot === '/index') return ['/'];
  if (pagesRoot) return [pagesRoot === '/' ? '/' : pagesRoot];
  return null;
}

function addRoutes(target, routes) {
  if (!routes) return;
  for (const route of routes) {
    target.add(normalizeRoutePath(route));
  }
}

function isGlobalChange(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return GLOBAL_CHANGE_HINTS.some((pattern) => pattern.test(normalized));
}

function buildSeoRoutes(changedFiles, hasGlobalChange) {
  const routes = new Set();
  const reasons = [];

  for (const filePath of changedFiles) {
    const contentRoute = mapContentRoute(filePath);
    if (contentRoute) {
      routes.add(contentRoute);
      reasons.push({ file: filePath, route: contentRoute, reason: 'content-change' });
      continue;
    }
  }

  if (hasGlobalChange || routes.size === 0) {
    for (const route of SEO_DEFAULT_ROUTES) routes.add(route);
  }

  return {
    routes: Array.from(routes).sort(),
    reasons,
  };
}

function buildLighthouseRoutes(changedFiles, hasGlobalChange) {
  const routes = new Set();
  const reasons = [];

  for (const filePath of changedFiles) {
    const contentRoute = mapContentRoute(filePath);
    if (contentRoute) {
      addRoutes(routes, [contentRoute]);
      reasons.push({ file: filePath, route: contentRoute, reason: 'content-change' });
      continue;
    }

    if (filePath.replace(/\\/g, '/').startsWith('src/pages/')) {
      const pageRoutes = mapPageRoute(filePath);
      addRoutes(routes, pageRoutes);
      if (pageRoutes) {
        reasons.push({ file: filePath, route: pageRoutes.join(', '), reason: 'page-change' });
      }
      continue;
    }

    for (const entry of COMPONENT_ROUTE_MAP) {
      if (entry.match.test(filePath)) {
        addRoutes(routes, entry.routes);
        reasons.push({ file: filePath, route: entry.routes.join(', '), reason: 'component-change' });
        break;
      }
    }
  }

  if (hasGlobalChange || routes.size === 0) {
    addRoutes(routes, LH_GLOBAL_ROUTES);
  } else {
    addRoutes(routes, LH_ANCHOR_ROUTES);
  }

  let finalRoutes = Array.from(routes).sort();
  if (Number.isFinite(MAX_LH_ROUTES) && finalRoutes.length > MAX_LH_ROUTES) {
    const anchorSet = new Set(LH_ANCHOR_ROUTES.map((route) => normalizeRoutePath(route)));
    const anchors = finalRoutes.filter((route) => anchorSet.has(route));
    const rest = finalRoutes.filter((route) => !anchorSet.has(route));
    finalRoutes = [...anchors, ...rest.slice(0, Math.max(0, MAX_LH_ROUTES - anchors.length))];
  }

  return {
    routes: finalRoutes,
    reasons,
  };
}

function main() {
  const changedFiles = readChangedFiles();
  const hasGlobalChange = changedFiles.some((filePath) => isGlobalChange(filePath));

  const seo = buildSeoRoutes(changedFiles, hasGlobalChange);
  const lighthouse = buildLighthouseRoutes(changedFiles, hasGlobalChange);

  if (!seo.routes.length) {
    throw new Error('[smoke-manifest] Empty seo.routes. Refusing to generate manifest.');
  }

  if (!lighthouse.routes.length) {
    throw new Error('[smoke-manifest] Empty lighthouse.routes. Refusing to generate manifest.');
  }

  const payload = {
    seo,
    lighthouse,
    meta: {
      generatedAt: new Date().toISOString(),
      diffBase: process.env.SMOKE_DIFF_BASE || 'origin/main',
      changedFiles,
      hasGlobalChange,
      maxLighthouseRoutes: MAX_LH_ROUTES,
    },
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(
    `[smoke-manifest] seo=${payload.seo.routes.length} lh=${payload.lighthouse.routes.length} output=${path
      .relative(ROOT, OUTPUT_PATH)
      .replace(/\\/g, '/')}`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
