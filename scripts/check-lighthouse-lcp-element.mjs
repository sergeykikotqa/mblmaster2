import fs from 'node:fs';
import path from 'node:path';

import { buildAuditRoutes, classifyRouteType } from './lib/audit-routes.mjs';

const ROOT = process.cwd();
const LHCI_DIR = path.join(ROOT, '.lighthouseci');

function listLhrFiles() {
  if (!fs.existsSync(LHCI_DIR)) return [];
  return fs
    .readdirSync(LHCI_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('lhr-') && entry.name.endsWith('.json'))
    .map((entry) => path.join(LHCI_DIR, entry.name));
}

function normalizePath(pathname) {
  const normalized = `/${String(pathname || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function extractLcpNode(audit) {
  const details = audit?.details;
  if (!details) return null;

  if (details.type === 'table') {
    return details.items?.[0]?.node ?? null;
  }

  if (details.type === 'list' && Array.isArray(details.items)) {
    const tableItem = details.items.find((item) => item?.type === 'table' && Array.isArray(item.items));
    return tableItem?.items?.[0]?.node ?? null;
  }

  return null;
}

function isHeroImageNode(node) {
  if (!node) return false;
  const selector = String(node.selector || '').toLowerCase();
  const snippet = String(node.snippet || '').toLowerCase();
  const isImage = snippet.includes('<img') || snippet.includes('<picture') || selector.includes('img') || selector.includes('picture');
  const isHero = selector.includes('project-hero');
  return isImage && isHero;
}

async function main() {
  const files = listLhrFiles();
  if (!files.length) {
    throw new Error('No LHCI results found in .lighthouseci/');
  }

  const { routes } = await buildAuditRoutes();
  const typeByPath = new Map(routes.map((route) => [route.path, route.type]));

  const failures = [];
  let projectRuns = 0;

  for (const filePath of files) {
    const lhr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const url = new URL(lhr.finalUrl || lhr.requestedUrl);
    const routePath = normalizePath(url.pathname);
    const type = typeByPath.get(routePath) || classifyRouteType(routePath) || 'unknown';

    if (type !== 'project') continue;
    projectRuns += 1;

    const audit = lhr.audits?.['largest-contentful-paint-element'];
    const node = extractLcpNode(audit);
    if (!node || !isHeroImageNode(node)) {
      failures.push({
        route: routePath,
        selector: node?.selector || 'unknown',
        snippet: node?.snippet || 'unknown',
        file: path.basename(filePath),
      });
    }
  }

  if (failures.length > 0) {
    console.error('[lighthouse] LCP element check failed for project pages.');
    failures.forEach((entry) => {
      console.error(
        `- ${entry.route} (${entry.file}) -> selector="${entry.selector}", snippet="${entry.snippet}"`
      );
    });
    process.exit(1);
  }

  if (projectRuns === 0) {
    console.warn('[lighthouse] LCP element check skipped: no project routes found in LHCI output.');
    return;
  }

  console.log('[lighthouse] LCP element check passed for project pages.');
}

main().catch((error) => {
  console.error('[lighthouse] LCP element check failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
