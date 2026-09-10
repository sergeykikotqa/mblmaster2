import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, 'artifacts', 'smoke-manifest.json');
const ARTICLE_SEO_STATE_PATH = path.join(ROOT, 'data', 'article-seo-state.json');
const READY_ARTICLE_FALLBACK = '/articles/kak-vybrat-kuhnyu-na-zakaz';

function normalizeRoute(value) {
  const normalized = `/${String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function resolveReadyArticleRoute() {
  if (!fs.existsSync(ARTICLE_SEO_STATE_PATH)) {
    return READY_ARTICLE_FALLBACK;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(ARTICLE_SEO_STATE_PATH, 'utf8'));
    const readyRoutes = Array.isArray(payload?.readyArticlePaths)
      ? payload.readyArticlePaths.map((item) => normalizeRoute(item)).filter(Boolean)
      : [];
    return readyRoutes[0] || READY_ARTICLE_FALLBACK;
  } catch {
    return READY_ARTICLE_FALLBACK;
  }
}

const DEFAULT_ROUTES = ['/', '/kuhni', resolveReadyArticleRoute()];

function setEnv(name, value) {
  if (!process.env[name]) {
    process.env[name] = value;
  }
}

function loadRoutes() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return DEFAULT_ROUTES;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const routes = Array.isArray(payload?.lighthouse?.routes) ? payload.lighthouse.routes : [];
    return routes.length > 0 ? routes : DEFAULT_ROUTES;
  } catch {
    return DEFAULT_ROUTES;
  }
}

async function main() {
  const generatorPath = path.join(ROOT, 'scripts', 'generate-smoke-manifest.mjs');
  await import(pathToFileURL(generatorPath).href);

  const smokeRoutes = loadRoutes();
  setEnv('LHCI_ROUTES', smokeRoutes.join(','));
  setEnv('LHCI_BATCH_SIZE', '8');

  const runnerPath = path.join(ROOT, 'scripts', 'check-lighthouse.mjs');
  await import(pathToFileURL(runnerPath).href);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
