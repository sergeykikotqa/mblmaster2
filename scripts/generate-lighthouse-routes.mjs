import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, '.lighthouserc.json');
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');

const ARTICLES_DIR = path.join(ROOT, 'src', 'content', 'articles');
const GUIDES_DIR = path.join(ROOT, 'src', 'content', 'guides');
const FAQ_DIR = path.join(ROOT, 'src', 'content', 'faq');
const PROJECTS_DIR = path.join(ROOT, 'src', 'content', 'projects');

function normalizePath(pathname) {
  const normalized = `/${String(pathname || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function listMarkdownFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.mdx?$/i.test(entry.name))
    .map((entry) => path.join(dirPath, entry.name))
    .sort();
}

function parseFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return (yaml.load(match[1]) || {}) ?? {};
}

function pickFirstSlug(dirPath, predicate) {
  const files = listMarkdownFiles(dirPath);
  for (const filePath of files) {
    const frontmatter = parseFrontmatter(filePath);
    if (predicate && !predicate(frontmatter)) continue;
    const slug = String(frontmatter?.slug || path.basename(filePath, path.extname(filePath))).trim();
    if (slug) return slug;
  }
  return null;
}

function loadGeneratedPages() {
  if (!fs.existsSync(GENERATED_PAGES_PATH)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(GENERATED_PAGES_PATH, 'utf8'));
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
}

function buildRoutes() {
  const routes = new Set([
    '/',
    '/kuhni',
    '/shkafy',
    '/garderobnye',
    '/projects',
    '/contacts',
  ]);

  const generatedPages = loadGeneratedPages();
  if (generatedPages.length > 0) {
    const first = generatedPages[0];
    if (first?.pageSlug) {
      routes.add(normalizePath(first.pageSlug));
    }
  }

  const articleSlug = pickFirstSlug(ARTICLES_DIR, (data) => {
    if (data?.draft) return false;
    if (data?.seoReady === false) return false;
    if (data?.isArchived) return false;
    if (data?.noindex) return false;
    return true;
  });
  if (articleSlug) routes.add(`/articles/${articleSlug}`);

  const guideSlug = pickFirstSlug(GUIDES_DIR, (data) => !data?.draft);
  if (guideSlug) routes.add(`/guides/${guideSlug}`);

  const projectSlug = pickFirstSlug(PROJECTS_DIR, (data) => !data?.draft);
  if (projectSlug) routes.add(`/projects/${projectSlug}`);

  const faqSlug = pickFirstSlug(FAQ_DIR, (data) => !data?.draft);
  if (faqSlug) routes.add(`/faq/${faqSlug}`);

  return [...routes].map((route) => normalizePath(route));
}

function updateLighthouseConfig(routes) {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('.lighthouserc.json is missing.');
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const urls = routes.map((route) => `http://localhost${route === '/' ? '' : route}`);
  config.ci = config.ci || {};
  config.ci.collect = config.ci.collect || {};
  config.ci.collect.url = urls;
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`[lighthouse] updated routes: ${urls.length}`);
}

try {
  const routes = buildRoutes();
  if (routes.length === 0) {
    throw new Error('No routes resolved for Lighthouse.');
  }
  updateLighthouseConfig(routes);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

