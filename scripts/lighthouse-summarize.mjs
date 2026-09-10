import fs from 'node:fs';
import path from 'node:path';

import { buildAuditRoutes, classifyRouteType } from './lib/audit-routes.mjs';

const ROOT = process.cwd();
const LHCI_DIR = path.join(ROOT, '.lighthouseci');
const OUTPUT_PATH = path.join(ROOT, 'artifacts', 'lighthouse-summary.json');
const MAX_WORST = 15;

function listLhrFiles() {
  if (!fs.existsSync(LHCI_DIR)) return [];
  return fs
    .readdirSync(LHCI_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('lhr-') && entry.name.endsWith('.json'))
    .map((entry) => path.join(LHCI_DIR, entry.name));
}

function readLhr(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function getMetric(lhr, key) {
  const audit = lhr?.audits?.[key];
  if (!audit) return null;
  return audit.numericValue ?? audit.score ?? null;
}

function normalizePath(pathname) {
  const normalized = `/${String(pathname || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
}

function summarizeByType(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.type)) groups.set(row.type, []);
    groups.get(row.type).push(row);
  }

  const summaries = [];
  for (const [type, items] of groups.entries()) {
    const perfValues = items.map((item) => item.performance).filter((v) => typeof v === 'number');
    summaries.push({
      type,
      count: items.length,
      performance: mean(perfValues),
      lcp: mean(items.map((item) => item.lcp).filter(Number.isFinite)),
      cls: mean(items.map((item) => item.cls).filter(Number.isFinite)),
      tbt: mean(items.map((item) => item.tbt).filter(Number.isFinite)),
      fcp: mean(items.map((item) => item.fcp).filter(Number.isFinite)),
      si: mean(items.map((item) => item.si).filter(Number.isFinite)),
      totalByteWeight: mean(items.map((item) => item.totalByteWeight).filter(Number.isFinite)),
      unusedJs: mean(items.map((item) => item.unusedJs).filter(Number.isFinite)),
    });
  }

  return summaries.sort((a, b) => a.type.localeCompare(b.type));
}

async function main() {
  const files = listLhrFiles();
  if (!files.length) {
    throw new Error('No LHCI results found in .lighthouseci/');
  }

  const { routes } = await buildAuditRoutes();
  const typeByPath = new Map(routes.map((route) => [route.path, route.type]));

  const rows = files.map((filePath) => {
    const lhr = readLhr(filePath);
    const url = new URL(lhr.finalUrl || lhr.requestedUrl);
    const routePath = normalizePath(url.pathname);
    const type = typeByPath.get(routePath) || classifyRouteType(routePath) || 'unknown';

    return {
      url: url.toString(),
      routePath,
      type,
      performance: lhr?.categories?.performance?.score ? lhr.categories.performance.score * 100 : null,
      lcp: getMetric(lhr, 'largest-contentful-paint'),
      cls: getMetric(lhr, 'cumulative-layout-shift'),
      tbt: getMetric(lhr, 'total-blocking-time'),
      fcp: getMetric(lhr, 'first-contentful-paint'),
      si: getMetric(lhr, 'speed-index'),
      totalByteWeight: getMetric(lhr, 'total-byte-weight'),
      unusedJs: getMetric(lhr, 'unused-javascript'),
      file: path.basename(filePath),
    };
  });

  const worstByPerf = [...rows]
    .filter((row) => typeof row.performance === 'number')
    .sort((a, b) => a.performance - b.performance)
    .slice(0, MAX_WORST);

  const summary = {
    generatedAt: new Date().toISOString(),
    totalRuns: rows.length,
    byType: summarizeByType(rows),
    worstPages: worstByPerf,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`[lighthouse] summary saved to ${path.relative(ROOT, OUTPUT_PATH).replace(/\\/g, '/')}`);
}

main().catch((error) => {
  console.error('[lighthouse] summarize failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
