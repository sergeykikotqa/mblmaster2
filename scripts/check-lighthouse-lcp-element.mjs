import fs from 'node:fs';
import path from 'node:path';

import { buildAuditRoutes, classifyRouteType } from './lib/audit-routes.mjs';

const ROOT = process.cwd();
const LHCI_DIR = path.join(ROOT, '.lighthouseci');
const OUTPUT_PATH = path.join(ROOT, 'artifacts', 'lighthouse-lcp-elements.json');

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

/** Best-effort extraction of the LCP resource when Lighthouse reports one. */
function extractLcpResource(audit) {
  const details = audit?.details;
  if (!details) return null;

  const tableItems =
    details.type === 'table'
      ? details.items
      : details.type === 'list' && Array.isArray(details.items)
        ? details.items.filter((item) => item?.type === 'table').flatMap((item) => item.items || [])
        : [];

  for (const item of tableItems) {
    const resource = (item?.items || []).find((entry) => entry?.type === 'resource' && entry?.resourceUrl);
    if (resource) {
      return {
        resourceUrl: String(resource.resourceUrl || ''),
        transferSize: Number.isFinite(resource.transferSize) ? resource.transferSize : null,
        requestStartTime: Number.isFinite(resource.requestStartTime) ? resource.requestStartTime : null,
        responseEndTime: Number.isFinite(resource.responseEndTime) ? resource.responseEndTime : null,
      };
    }
  }

  return null;
}

function isHeroImageNode(node) {
  if (!node) return false;
  const selector = String(node.selector || '').toLowerCase();
  const snippet = String(node.snippet || '').toLowerCase();
  const isImage =
    snippet.includes('<img') ||
    snippet.includes('<picture') ||
    selector.includes('img') ||
    selector.includes('picture');
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
  const diagnostics = [];
  let projectRuns = 0;

  for (const filePath of files) {
    const lhr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const url = new URL(lhr.finalUrl || lhr.requestedUrl);
    const routePath = normalizePath(url.pathname);
    const type = typeByPath.get(routePath) || classifyRouteType(routePath) || 'unknown';

    const lcpAudit = lhr.audits?.['largest-contentful-paint'];
    const audit = lhr.audits?.['largest-contentful-paint-element'];
    const node = extractLcpNode(audit);
    const resource = extractLcpResource(audit);

    // Diagnostic scope is every audited route, so a home-page regression stays
    // visible even though the hero-image assertion below only covers projects.
    diagnostics.push({
      route: routePath,
      type,
      file: path.basename(filePath),
      lcpMs: Number.isFinite(lcpAudit?.numericValue) ? Math.round(lcpAudit.numericValue) : null,
      selector: node?.selector || 'unknown',
      snippet: node?.snippet || 'unknown',
      resourceUrl: resource?.resourceUrl || null,
      transferSize: resource?.transferSize ?? null,
      requestStartTime: resource?.requestStartTime ?? null,
      responseEndTime: resource?.responseEndTime ?? null,
    });

    if (type !== 'project') continue;
    projectRuns += 1;

    if (!node || !isHeroImageNode(node)) {
      failures.push({
        route: routePath,
        selector: node?.selector || 'unknown',
        snippet: node?.snippet || 'unknown',
        file: path.basename(filePath),
      });
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUTPUT_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), runs: diagnostics }, null, 2)}\n`,
    'utf8'
  );

  console.log('[lighthouse] LCP diagnostics (all routes):');
  for (const entry of diagnostics) {
    const resource = entry.resourceUrl ? ` resource=${entry.resourceUrl}` : '';
    const size = entry.transferSize === null ? '' : ` transferSize=${entry.transferSize}`;
    console.log(
      `[lighthouse]   route=${entry.route} type=${entry.type} lcpMs=${entry.lcpMs ?? 'n/a'} ` +
        `selector="${entry.selector}" snippet="${entry.snippet}"${resource}${size} (${entry.file})`
    );
  }
  console.log(`[lighthouse] LCP diagnostics written to ${OUTPUT_PATH}`);

  if (failures.length > 0) {
    console.error('[lighthouse] LCP element check failed for project pages.');
    failures.forEach((entry) => {
      console.error(`- ${entry.route} (${entry.file}) -> selector="${entry.selector}", snippet="${entry.snippet}"`);
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
