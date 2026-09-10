import fs from 'node:fs';
import path from 'node:path';

import { loadIndexabilityPolicyModule } from './lib/load-indexability-policy.mjs';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const DEFAULT_MAX_NOINDEX_SHARE = 0.7;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseFraction(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

function toRoutePath(filePath) {
  const relative = path.relative(DIST_DIR, filePath).replace(/\\/g, '/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'/index.html'.length)}`;
  if (relative.endsWith('.html')) return `/${relative.slice(0, -'.html'.length)}`;
  return `/${relative}`;
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
  let noindex = false;
  let nofollow = false;
  for (const tag of metaTags) {
    const attrs = parseTagAttributes(tag);
    if ((attrs.name || '').toLowerCase() !== 'robots') continue;
    const robotsValue = String(attrs.content || '')
      .toLowerCase()
      .split(',')
      .map((item) => item.trim());
    if (robotsValue.includes('noindex')) noindex = true;
    if (robotsValue.includes('nofollow')) nofollow = true;
  }
  return { noindex, nofollow };
}

async function main() {
  assert(fs.existsSync(DIST_DIR), 'dist is missing. Run "npm run build" first.');

  const { getIndexabilityPolicy } = await loadIndexabilityPolicyModule();
  const pages = walkHtmlFiles(DIST_DIR);
  assert(pages.length > 0, 'No built HTML pages found in dist/.');

  const mismatches = [];
  let jsonIndexableCount = 0;
  let htmlIndexableCount = 0;

  for (const htmlPath of pages) {
    const slug = toRoutePath(htmlPath);
    const policy = getIndexabilityPolicy(slug);
    const html = fs.readFileSync(htmlPath, 'utf8');
    const robotsMeta = parseRobotsMeta(html);
    const expectedIndexable = Boolean(policy.index);
    const expectedFollow = Boolean(policy.follow);
    const runtimeIndexable = !robotsMeta.noindex;
    const runtimeFollow = !robotsMeta.nofollow;

    if (!policy.isKnown) {
      mismatches.push(`${slug}: route is built but not classified in src/config/indexability-policy.ts`);
      continue;
    }

    if (expectedIndexable) jsonIndexableCount += 1;
    if (runtimeIndexable) htmlIndexableCount += 1;

    if (expectedIndexable !== runtimeIndexable) {
      mismatches.push(
        `${slug}: policy classification="${policy.classification}" expects robots "${
          expectedIndexable ? 'index' : 'noindex'
        }", runtime robots="${robotsMeta.noindex ? 'noindex' : 'index'}"`
      );
    }

    if (expectedFollow !== runtimeFollow) {
      mismatches.push(
        `${slug}: policy expects follow="${expectedFollow ? 'follow' : 'nofollow'}", runtime robots="${
          runtimeFollow ? 'follow' : 'nofollow'
        }"`
      );
    }
  }

  if (jsonIndexableCount !== htmlIndexableCount) {
    mismatches.push(`indexable count mismatch: generated=${jsonIndexableCount}, runtime_html=${htmlIndexableCount}`);
  }

  const maxNoindexShare = parseFraction(process.env.MAX_NOINDEX_SHARE, DEFAULT_MAX_NOINDEX_SHARE);
  const totalPages = pages.length;
  const noindexCount = totalPages - jsonIndexableCount;
  const noindexShare = totalPages > 0 ? noindexCount / totalPages : 0;

  if (noindexShare > maxNoindexShare) {
    mismatches.push(
      `noindex share exceeds threshold: noindex=${noindexCount}/${totalPages} (${(noindexShare * 100).toFixed(
        2
      )}%), limit=${(maxNoindexShare * 100).toFixed(2)}%`
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Indexability runtime consistency check failed (${mismatches.length}):\n${mismatches.map((x) => `- ${x}`).join('\n')}`
    );
  }

  console.log(
    `Indexability runtime consistency check passed: pages=${pages.length}, indexable=${jsonIndexableCount}, noindex=${noindexCount}, noindex_share=${(
      noindexShare * 100
    ).toFixed(2)}%, max_noindex_share=${(maxNoindexShare * 100).toFixed(2)}%.`
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
