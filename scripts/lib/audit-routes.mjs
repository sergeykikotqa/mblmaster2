import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { loadIndexabilityPolicyModule } from './load-indexability-policy.mjs';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const CONTENT_DIR = path.join(ROOT, 'src', 'content');

const ARTICLES_DIR = path.join(CONTENT_DIR, 'articles');
const GUIDES_DIR = path.join(CONTENT_DIR, 'guides');
const FAQ_DIR = path.join(CONTENT_DIR, 'faq');
const PROJECTS_DIR = path.join(CONTENT_DIR, 'projects');

const GENERATED_PAGES_PATH = path.join(DATA_DIR, 'generated-pages.json');
const CITIES_PATH = path.join(DATA_DIR, 'cities.json');
const SERVICES_PATH = path.join(DATA_DIR, 'services.json');

const TYPE_PRIORITY = new Map([
  ['home', 100],
  ['article', 95],
  ['project', 90],
  ['guide', 85],
  ['faq', 80],
  ['service', 75],
  ['city', 70],
  ['static', 60],
  ['unknown', 10],
]);

const STATIC_TYPE_MAP = new Map([
  ['/', 'home'],
  ['/contacts', 'contacts'],
  ['/o-kompanii', 'about'],
  ['/projects', 'projects-index'],
  ['/articles', 'articles-index'],
  ['/guides', 'guides-index'],
  ['/faq', 'faq-index'],
  ['/privacy', 'legal'],
  ['/terms', 'legal'],
  ['/kuhni', 'service'],
  ['/shkafy', 'service'],
  ['/garderobnye', 'service'],
  ['/kuhni-3-metra', 'landing'],
]);

function normalizePath(pathname) {
  const normalized = `/${String(pathname || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

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

function listMarkdownFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = [];
  const stack = [dirPath];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function slugFromFile(filePath, frontmatter) {
  const base = path.basename(filePath).replace(/\.mdx?$/i, '');
  return String(frontmatter?.slug || base).trim();
}

function safeReadJson(filePath, fallback = []) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return payload;
  } catch {
    return fallback;
  }
}

function typePriority(type) {
  return TYPE_PRIORITY.get(type) ?? TYPE_PRIORITY.get('unknown');
}

function mergeRoute(existing, incoming) {
  if (!existing) return incoming;
  if (typePriority(incoming.type) > typePriority(existing.type)) {
    return { ...existing, ...incoming };
  }
  return { ...incoming, ...existing };
}

function classifyStaticRoute(pathname) {
  return STATIC_TYPE_MAP.get(pathname) || 'static';
}

export async function buildAuditRoutes() {
  const { getIndexabilityPolicy, INDEX_PATHS, TEMP_NOINDEX_PATHS, NOINDEX_FOLLOW_PATHS, BLOCKED_PATHS } =
    await loadIndexabilityPolicyModule();

  const routesMap = new Map();

  const addRoute = (pathname, meta) => {
    const normalized = normalizePath(pathname);
    if (!normalized) return;
    const policy = getIndexabilityPolicy(normalized);
    if (policy.classification === 'blocked') return;
    if (policy.index === false) return;

    const route = {
      path: normalized,
      type: meta?.type || 'unknown',
      source: meta?.source || 'unknown',
      flags: meta?.flags || {},
      policy: {
        classification: policy.classification,
        index: policy.index,
        follow: policy.follow,
        includeInSitemap: policy.includeInSitemap,
        isKnown: policy.isKnown,
      },
    };

    const existing = routesMap.get(normalized);
    routesMap.set(normalized, mergeRoute(existing, route));
  };

  const staticPatterns = [...INDEX_PATHS, ...TEMP_NOINDEX_PATHS, ...NOINDEX_FOLLOW_PATHS, ...BLOCKED_PATHS].filter(
    (pattern) => !String(pattern).endsWith('/*')
  );
  for (const pattern of staticPatterns) {
    const pathValue = normalizePath(pattern);
    addRoute(pathValue, { type: classifyStaticRoute(pathValue), source: 'policy' });
  }

  const generatedPages = Array.isArray(safeReadJson(GENERATED_PAGES_PATH, []))
    ? safeReadJson(GENERATED_PAGES_PATH, [])
    : [];
  for (const page of generatedPages) {
    const slug = normalizePath(page?.pageSlug || '');
    if (!slug || slug === '/') continue;
    addRoute(slug, {
      type: page?.pageType === 'service-money' ? 'service' : 'generated',
      source: 'generated-pages',
      flags: {
        indexabilityPolicy: page?.indexabilityPolicy,
        releaseStage: page?.releaseStage,
      },
    });
  }

  const cities = safeReadJson(CITIES_PATH, []);
  if (Array.isArray(cities)) {
    for (const city of cities) {
      if (!city?.id) continue;
      addRoute(`/${city.id}`, { type: 'city', source: 'cities' });
    }
  }

  const services = safeReadJson(SERVICES_PATH, []);
  if (Array.isArray(services)) {
    for (const service of services) {
      if (!service?.pathSegment && !service?.id) continue;
      const slug = normalizePath(`/${service.pathSegment || service.id}`);
      addRoute(slug, { type: 'service', source: 'services' });
    }
  }

  const articleFiles = listMarkdownFiles(ARTICLES_DIR);
  for (const filePath of articleFiles) {
    const frontmatter = parseMarkdownFrontmatter(filePath);
    if (frontmatter?.draft) continue;
    const slug = slugFromFile(filePath, frontmatter);
    if (!slug) continue;
    addRoute(`/articles/${slug}`, {
      type: 'article',
      source: 'content',
      flags: {
        seoReady: frontmatter?.seoReady === true,
        isArchived: frontmatter?.isArchived === true,
        noindex: frontmatter?.noindex === true,
      },
    });
  }

  const guideFiles = listMarkdownFiles(GUIDES_DIR);
  for (const filePath of guideFiles) {
    const frontmatter = parseMarkdownFrontmatter(filePath);
    if (frontmatter?.draft) continue;
    const slug = slugFromFile(filePath, frontmatter);
    if (!slug) continue;
    addRoute(`/guides/${slug}`, { type: 'guide', source: 'content' });
  }

  const faqFiles = listMarkdownFiles(FAQ_DIR);
  for (const filePath of faqFiles) {
    const frontmatter = parseMarkdownFrontmatter(filePath);
    if (frontmatter?.draft) continue;
    const slug = slugFromFile(filePath, frontmatter);
    if (!slug) continue;
    addRoute(`/faq/${slug}`, { type: 'faq', source: 'content' });
  }

  const projectFiles = listMarkdownFiles(PROJECTS_DIR);
  for (const filePath of projectFiles) {
    const frontmatter = parseMarkdownFrontmatter(filePath);
    if (frontmatter?.draft) continue;
    const slug = slugFromFile(filePath, frontmatter);
    if (!slug) continue;
    addRoute(`/projects/${slug}`, { type: 'project', source: 'content' });
  }

  const routes = [...routesMap.values()].sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  return {
    routes,
    meta: {
      total: routes.length,
      generatedAt: new Date().toISOString(),
    },
  };
}

export function classifyRouteType(pathname) {
  const normalized = normalizePath(pathname);
  if (normalized.startsWith('/articles/')) return 'article';
  if (normalized.startsWith('/projects/')) return 'project';
  if (normalized.startsWith('/guides/')) return 'guide';
  if (normalized.startsWith('/faq/')) return 'faq';
  if (STATIC_TYPE_MAP.has(normalized)) return STATIC_TYPE_MAP.get(normalized);
  if (normalized === '/' || normalized === '') return 'home';
  return 'unknown';
}
