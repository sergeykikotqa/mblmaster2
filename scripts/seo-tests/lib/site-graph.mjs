import fs from 'node:fs';
import path from 'node:path';

import { loadIndexabilityPolicyModule } from '../../lib/load-indexability-policy.mjs';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const ROBOTS_PATH = path.join(ROOT, 'public', 'robots.txt');
const TMP_DIR = path.join(ROOT, '.tmp', 'seo');
const REPORT_JSON_PATH = path.join(TMP_DIR, 'crawl-graph.json');
const REPORT_HTML_PATH = path.join(TMP_DIR, 'crawl-graph.html');
const SITEMAP_PATTERN = /^sitemap(?:-(?:index|\d+))?\.xml$/i;
const SITEMAP_ROUTE_PATTERN = /^\/sitemap(?:-(?:index|\d+))?\.xml$/i;
const TRACKABLE_PREFIXES = ['/_astro', '/.netlify', '/images', '/scripts', '/fonts'];
const TRACKABLE_FILE_EXTENSION_PATTERN =
  /\.(?:avif|bmp|css|csv|gif|ico|jpeg|jpg|js|json|map|mp4|pdf|png|svg|txt|webm|webp|woff2?|xml)$/i;
const ALLOWED_NOINDEX_TARGETS = new Set(['/irkutsk', '/privacy']);
const SUPPORT_WIDGET_PATTERN = /data-support-links|support-widget|support-links|contact-city-links|city-links/i;

function normalizeRoutePath(routePath) {
  const raw = String(routePath || '/').trim();
  if (!raw || raw === '/') return '/';

  const withoutOrigin = raw.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const withoutQueryHash = withoutOrigin.split(/[?#]/)[0] || '/';
  const withLeadingSlash = withoutQueryHash.startsWith('/') ? withoutQueryHash : `/${withoutQueryHash}`;
  return withLeadingSlash.replace(/\/+$/, '') || '/';
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

function extractCanonicalMatches(html) {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  return linkTags
    .map((tag) => parseTagAttributes(tag))
    .filter((attrs) =>
      String(attrs.rel || '')
        .toLowerCase()
        .split(/\s+/)
        .includes('canonical')
    )
    .map((attrs) => String(attrs.href || '').trim())
    .filter(Boolean);
}

function parseRobotsMeta(html) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const attrs = parseTagAttributes(tag);
    if ((attrs.name || '').toLowerCase() !== 'robots') continue;
    const directives = String(attrs.content || '')
      .toLowerCase()
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return {
      directives,
      noindex: directives.includes('noindex'),
      nofollow: directives.includes('nofollow'),
    };
  }

  return {
    directives: [],
    noindex: false,
    nofollow: false,
  };
}

function parseJsonLdBlocks(html) {
  const blocks = [];
  const regex = /<script\b[^>]*type=(['"])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    blocks.push(String(match[2] || '').trim());
  }
  return blocks;
}

function normalizeTypeNames(rawType) {
  if (Array.isArray(rawType)) {
    return rawType
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof rawType === 'string' && rawType.trim()) {
    return [rawType.trim()];
  }
  return [];
}

function collectTypedNodes(value, bucket, visited) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTypedNodes(item, bucket, visited);
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);

  const record = value;
  const typeNames = normalizeTypeNames(record['@type']);
  if (typeNames.length > 0) {
    bucket.push({ node: record, typeNames });
  }

  for (const child of Object.values(record)) {
    collectTypedNodes(child, bucket, visited);
  }
}

function summarizeSchema(html) {
  const blocks = parseJsonLdBlocks(html);
  const typedNodes = [];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      collectTypedNodes(parsed, typedNodes, new WeakSet());
    } catch {
      // Existing schema gates handle invalid JSON-LD.
    }
  }

  const uniqueTypes = new Set();
  let businessCount = 0;
  let breadcrumbCount = 0;

  for (const typed of typedNodes) {
    for (const typeName of typed.typeNames) {
      uniqueTypes.add(typeName);
      if (typeName === 'KitchenCabinetStore') {
        businessCount += 1;
      }
      if (typeName === 'BreadcrumbList') {
        breadcrumbCount += 1;
      }
    }
  }

  return {
    schemaTypes: [...uniqueTypes].sort(),
    businessCount,
    breadcrumbCount,
    jsonLdBlockCount: blocks.length,
    typedNodeCount: typedNodes.length,
  };
}

function collectSitemapEntries() {
  if (!fs.existsSync(DIST_DIR)) {
    return {
      paths: new Set(),
      urls: new Set(),
    };
  }

  const sitemapFiles = fs
    .readdirSync(DIST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SITEMAP_PATTERN.test(entry.name))
    .map((entry) => path.join(DIST_DIR, entry.name));

  const paths = new Set();
  const urls = new Set();
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
          urls.add(parsed.toString());
        }
      } catch {
        const pathname = normalizeRoutePath(value);
        if (!SITEMAP_ROUTE_PATTERN.test(pathname)) {
          paths.add(pathname);
        }
      }
    }
  }

  return { paths, urls };
}

function parseRobotsTxt() {
  if (!fs.existsSync(ROBOTS_PATH)) {
    return [];
  }

  const lines = fs.readFileSync(ROBOTS_PATH, 'utf8').split(/\r?\n/);
  const rules = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s*#.*$/, '').trim();
    if (!line) continue;

    const match = line.match(/^Disallow:\s*(.+)$/i);
    if (!match) continue;

    const rule = normalizeRoutePath(match[1]);
    if (rule) {
      rules.push(rule);
    }
  }

  return [...new Set(rules)];
}

function isBlockedByRobots(routePath, disallowRules) {
  const normalizedPath = normalizeRoutePath(routePath);
  return disallowRules.some((rule) => {
    const normalizedRule = normalizeRoutePath(rule);
    if (normalizedRule === '/') return true;
    if (normalizedRule.endsWith('/*')) {
      const base = normalizedRule.slice(0, -2);
      return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
    }
    if (normalizedRule.endsWith('/')) {
      const base = normalizedRule.replace(/\/+$/, '');
      return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
    }
    return normalizedPath === normalizedRule || normalizedPath.startsWith(`${normalizedRule}/`);
  });
}

function isLikelyTrackableRoute(routePath) {
  const normalizedPath = normalizeRoutePath(routePath);
  if (TRACKABLE_PREFIXES.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))) {
    return false;
  }
  return !TRACKABLE_FILE_EXTENSION_PATTERN.test(normalizedPath);
}

function matchSectionRange(html, regex) {
  const match = regex.exec(html);
  if (!match) return null;

  return {
    start: match.index,
    end: match.index + match[0].length,
  };
}

function extractPatternRanges(html, pattern) {
  const ranges = [];
  const regex = new RegExp(pattern.source, pattern.flags);
  let match;

  while ((match = regex.exec(html)) !== null) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return ranges;
}

function extractSectionRanges(html) {
  return {
    header: matchSectionRange(html, /<header\b[^>]*\bid=(['"])header\1[^>]*>[\s\S]*?<\/header>/i),
    footer: matchSectionRange(html, /<footer\b[^>]*>[\s\S]*?<\/footer>/i),
    main: matchSectionRange(html, /<main\b[^>]*>[\s\S]*?<\/main>/i),
  };
}

function isInsideRange(index, ranges) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function classifyArea(index, sectionRanges) {
  for (const area of ['header', 'footer', 'main']) {
    const range = sectionRanges[area];
    if (range && index >= range.start && index < range.end) {
      return area;
    }
  }
  return 'other';
}

function resolveInternalHref(rawHref, sourceRoutePath) {
  const trimmed = String(rawHref || '').trim();
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('//') ||
    /^https?:\/\//i.test(trimmed)
  ) {
    return null;
  }

  let url;
  try {
    const basePath = sourceRoutePath === '/' ? '/' : `${sourceRoutePath}/`;
    url = new URL(trimmed, `https://local.test${basePath}`);
  } catch {
    return null;
  }

  const pathname = normalizeRoutePath(url.pathname);
  return {
    rawHref: trimmed,
    pathname,
    search: url.search || '',
    hash: url.hash || '',
    hasQueryParams: Boolean(url.search),
  };
}

function extractInternalLinks(html, sourceRoutePath) {
  const results = [];
  const sectionRanges = extractSectionRanges(html);
  const supportRanges = extractPatternRanges(
    html,
    /<(?:section|div|aside|nav|ul)\b[^>]*(?:data-support-links|support-widget|support-links|contact-city-links|city-links)[^>]*>[\s\S]*?<\/(?:section|div|aside|nav|ul)>/gi
  );
  const anchorRegex = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const resolved = resolveInternalHref(match[2], sourceRoutePath);
    if (!resolved) continue;
    if (!isLikelyTrackableRoute(resolved.pathname)) continue;

    const area = classifyArea(match.index, sectionRanges);
    const contextStart = Math.max(0, match.index - 1200);
    const contextEnd = Math.min(html.length, match.index + match[0].length + 1200);
    const contextSnippet = html.slice(contextStart, contextEnd);

    results.push({
      ...resolved,
      area,
      supportWidget:
        area === 'main' && (isInsideRange(match.index, supportRanges) || SUPPORT_WIDGET_PATTERN.test(contextSnippet)),
    });
  }

  return results;
}

function createNode(routePath, policy, overrides = {}) {
  return {
    routePath,
    isBuilt: false,
    filePath: null,
    classification: policy.classification,
    index: Boolean(policy.index),
    follow: Boolean(policy.follow),
    includeInSitemap: Boolean(policy.includeInSitemap),
    canonicalUrl: '',
    canonicalPath: policy.canonicalPath || routePath,
    inSitemap: false,
    robotsMeta: {
      directives: [],
      noindex: !policy.index,
      nofollow: !policy.follow,
    },
    blockedByRobots: false,
    schemaTypes: [],
    businessCount: 0,
    breadcrumbCount: 0,
    jsonLdBlockCount: 0,
    typedNodeCount: 0,
    articleState: null,
    linkSourcesByArea: {
      header: [],
      footer: [],
      main: [],
      other: [],
    },
    inboundEdges: [],
    outboundEdges: [],
    inboundSourceCount: 0,
    outboundTargetCount: 0,
    clickDepthFromHome: null,
    issues: [],
    discoveredFrom: [],
    ...overrides,
  };
}

function getArticleState(routePath, articleSeoState, policy) {
  const readyArticleSet = new Set(articleSeoState.readyArticlePaths || []);

  if (routePath === '/articles') {
    return policy.index ? 'article-list-ready' : 'article-list-held';
  }

  if (routePath.startsWith('/articles/')) {
    return readyArticleSet.has(routePath) ? 'ready-article' : 'held-article';
  }

  return null;
}

function addDiscoveredFrom(node, source) {
  if (!node.discoveredFrom.includes(source)) {
    node.discoveredFrom.push(source);
  }
}

function addIssue(node, severity, code, message, extra = {}) {
  node.issues.push({
    severity,
    code,
    message,
    routePath: node.routePath,
    ...extra,
  });
}

function buildAdjacency(nodes, edges) {
  const adjacency = new Map();
  for (const node of nodes.values()) {
    if (!node.isBuilt) continue;
    adjacency.set(node.routePath, new Set());
  }

  for (const edge of edges) {
    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    if (!fromNode?.isBuilt || !toNode?.isBuilt) continue;
    if (edge.from === edge.to) continue;
    adjacency.get(edge.from)?.add(edge.to);
  }

  return adjacency;
}

function computeClickDepths(nodes, edges) {
  const adjacency = buildAdjacency(nodes, edges);
  const depths = new Map();
  if (!adjacency.has('/')) {
    return depths;
  }

  depths.set('/', 0);
  const queue = ['/'];
  while (queue.length > 0) {
    const current = queue.shift();
    const currentDepth = depths.get(current) ?? 0;
    for (const next of adjacency.get(current) || []) {
      if (depths.has(next)) continue;
      depths.set(next, currentDepth + 1);
      queue.push(next);
    }
  }

  return depths;
}

function buildStronglyConnectedComponents(nodes, edges) {
  const adjacency = buildAdjacency(nodes, edges);
  const routes = [...adjacency.keys()];
  const visited = new Set();
  const order = [];

  function dfs(routePath) {
    visited.add(routePath);
    for (const next of adjacency.get(routePath) || []) {
      if (!visited.has(next)) {
        dfs(next);
      }
    }
    order.push(routePath);
  }

  for (const routePath of routes) {
    if (!visited.has(routePath)) {
      dfs(routePath);
    }
  }

  const reversed = new Map();
  for (const routePath of routes) {
    reversed.set(routePath, new Set());
  }
  for (const [from, targets] of adjacency.entries()) {
    for (const to of targets) {
      reversed.get(to)?.add(from);
    }
  }

  const components = [];
  visited.clear();

  function reverseDfs(routePath, bucket) {
    visited.add(routePath);
    bucket.push(routePath);
    for (const next of reversed.get(routePath) || []) {
      if (!visited.has(next)) {
        reverseDfs(next, bucket);
      }
    }
  }

  while (order.length > 0) {
    const routePath = order.pop();
    if (visited.has(routePath)) continue;
    const bucket = [];
    reverseDfs(routePath, bucket);
    components.push(bucket.sort());
  }

  return components;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function truncateLabel(value, maxLength = 36) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function getNodeColor(node) {
  const hasFailIssue = node.issues.some((issue) => issue.severity === 'fail');
  if (hasFailIssue || !node.isBuilt || !node.canonicalUrl) return '#fca5a5';
  if (node.classification === 'blocked') return '#cbd5e1';
  if (!node.index) return '#fcd34d';
  if (node.inSitemap) return '#86efac';
  return '#bfdbfe';
}

function buildGraphSvg(nodes, edges) {
  const builtNodes = nodes.filter((node) => node.isBuilt);
  const maxFiniteDepth = builtNodes.reduce((acc, node) => {
    if (typeof node.clickDepthFromHome !== 'number') return acc;
    return Math.max(acc, node.clickDepthFromHome);
  }, 0);

  const columns = new Map();
  for (const node of builtNodes) {
    const key = typeof node.clickDepthFromHome === 'number' ? String(node.clickDepthFromHome) : 'unreachable';
    const bucket = columns.get(key) || [];
    bucket.push(node);
    columns.set(key, bucket);
  }

  const orderedKeys = [
    ...new Set(
      [...Array.from({ length: maxFiniteDepth + 1 }, (_, index) => String(index)), 'unreachable'].filter((key) =>
        columns.has(key)
      )
    ),
  ];

  for (const [key, bucket] of columns.entries()) {
    bucket.sort((left, right) => left.routePath.localeCompare(right.routePath));
    columns.set(key, bucket);
  }

  const columnGap = 260;
  const rowGap = 86;
  const nodeWidth = 190;
  const nodeHeight = 48;
  const paddingX = 80;
  const paddingY = 90;
  const graphWidth = Math.max(orderedKeys.length, 1) * columnGap + paddingX * 2;
  const graphHeight =
    Math.max(
      1,
      ...orderedKeys.map((key) => {
        const size = columns.get(key)?.length || 0;
        return size;
      })
    ) *
      rowGap +
    paddingY * 2;

  const positionedNodes = new Map();
  orderedKeys.forEach((key, columnIndex) => {
    const bucket = columns.get(key) || [];
    bucket.forEach((node, rowIndex) => {
      const x = paddingX + columnIndex * columnGap;
      const y = paddingY + rowIndex * rowGap;
      positionedNodes.set(node.routePath, {
        x,
        y,
      });
    });
  });

  const edgeMarkup = edges
    .filter((edge) => positionedNodes.has(edge.from) && positionedNodes.has(edge.to))
    .map((edge) => {
      const from = positionedNodes.get(edge.from);
      const to = positionedNodes.get(edge.to);
      const colorByArea = {
        header: '#2563eb',
        footer: '#7c3aed',
        main: '#d97706',
        other: '#64748b',
      };
      const x1 = from.x + nodeWidth;
      const y1 = from.y + nodeHeight / 2;
      const x2 = to.x;
      const y2 = to.y + nodeHeight / 2;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colorByArea[edge.area] || '#94a3b8'}" stroke-opacity="0.28" stroke-width="1.4" />`;
    })
    .join('');

  const columnLabels = orderedKeys
    .map((key, index) => {
      const x = paddingX + index * columnGap;
      const label = key === 'unreachable' ? 'Unreachable' : `Depth ${key}`;
      return `<text x="${x}" y="48" fill="#334155" font-size="14" font-weight="700">${escapeHtml(label)}</text>`;
    })
    .join('');

  const nodeMarkup = builtNodes
    .map((node) => {
      const position = positionedNodes.get(node.routePath);
      if (!position) return '';
      const fill = getNodeColor(node);
      const textColor = fill === '#cbd5e1' ? '#0f172a' : '#111827';
      return `<g>
  <rect x="${position.x}" y="${position.y}" width="${nodeWidth}" height="${nodeHeight}" rx="12" fill="${fill}" stroke="#0f172a" stroke-opacity="0.08" />
  <text x="${position.x + 12}" y="${position.y + 22}" fill="${textColor}" font-size="13" font-weight="700">${escapeHtml(truncateLabel(node.routePath, 30))}</text>
  <text x="${position.x + 12}" y="${position.y + 38}" fill="#334155" font-size="11">${escapeHtml(node.classification)}</text>
</g>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${graphWidth} ${graphHeight}" width="100%" height="${graphHeight}" role="img" aria-label="Crawl graph">
  <rect x="0" y="0" width="${graphWidth}" height="${graphHeight}" fill="#f8fafc" />
  ${columnLabels}
  ${edgeMarkup}
  ${nodeMarkup}
</svg>`;
}

function renderIssueTable(title, rows, emptyText) {
  const body =
    rows.length > 0
      ? rows
          .map(
            (row) => `<tr>
  <td>${escapeHtml(row.routePath || 'system')}</td>
  <td>${escapeHtml(row.code)}</td>
  <td>${escapeHtml(row.message)}</td>
</tr>`
          )
          .join('')
      : `<tr><td colspan="3">${escapeHtml(emptyText)}</td></tr>`;

  return `<section class="report-card">
  <h2>${escapeHtml(title)}</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Route</th>
          <th>Check</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>
</section>`;
}

function renderMetrics(report) {
  const metrics = [
    ['Built pages', report.summary.builtPages],
    ['Indexable pages', report.summary.indexablePages],
    ['Noindex pages', report.summary.noindexPages],
    ['Blocked pages', report.summary.blockedPages],
    ['Sitemap URLs', report.summary.sitemapUrls],
    ['Internal edges', report.summary.edges],
    ['Failures', report.failures.length + report.gateResults.filter((gate) => gate.status === 'fail').length],
    ['Warnings', report.warnings.length],
  ];

  return metrics
    .map(
      ([label, value]) => `<div class="metric">
  <div class="metric-label">${escapeHtml(label)}</div>
  <div class="metric-value">${escapeHtml(String(value))}</div>
</div>`
    )
    .join('');
}

function renderGateTable(gateResults) {
  const rows = gateResults
    .map((gate) => {
      const tone = gate.status === 'pass' ? 'gate-pass' : 'gate-fail';
      return `<tr>
  <td>${escapeHtml(gate.id)}</td>
  <td><span class="${tone}">${escapeHtml(gate.status)}</span></td>
  <td>${escapeHtml(`${gate.durationMs}ms`)}</td>
  <td>${escapeHtml(gate.summary)}</td>
</tr>`;
    })
    .join('');

  return `<section class="report-card">
  <h2>Existing Gates</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Gate</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Summary</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`;
}

function renderArticleTable(report) {
  const rows = report.nodes
    .filter((node) => node.routePath === '/articles' || node.routePath.startsWith('/articles/'))
    .sort((left, right) => left.routePath.localeCompare(right.routePath))
    .map(
      (node) => `<tr>
  <td>${escapeHtml(node.routePath)}</td>
  <td>${escapeHtml(node.articleState || 'n/a')}</td>
  <td>${escapeHtml(node.index ? 'index,follow' : 'noindex,follow')}</td>
  <td>${escapeHtml(node.inSitemap ? 'yes' : 'no')}</td>
</tr>`
    )
    .join('');

  return `<section class="report-card">
  <h2>Article Rollout</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Route</th>
          <th>Article state</th>
          <th>Robots</th>
          <th>In sitemap</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="4">No article routes in build.</td></tr>'}</tbody>
    </table>
  </div>
  </section>`;
}

export async function buildSiteGraph() {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('dist directory is missing. Run `npm run build` first.');
  }

  const { getIndexabilityPolicy, getArticleSeoState } = await loadIndexabilityPolicyModule();
  const articleSeoState = typeof getArticleSeoState === 'function' ? getArticleSeoState() : { readyArticlePaths: [] };
  const readyArticlePathSet = new Set(articleSeoState.readyArticlePaths || []);
  const robotsDisallow = parseRobotsTxt();
  const sitemap = collectSitemapEntries();

  const nodes = new Map();
  const edges = [];

  function ensureNode(routePath, source) {
    const normalizedRoute = normalizeRoutePath(routePath);
    if (!nodes.has(normalizedRoute)) {
      const policy = getIndexabilityPolicy(normalizedRoute);
      const node = createNode(normalizedRoute, policy, {
        inSitemap: sitemap.paths.has(normalizedRoute),
        articleState: getArticleState(normalizedRoute, articleSeoState, policy),
        blockedByRobots: isBlockedByRobots(normalizedRoute, robotsDisallow),
      });
      nodes.set(normalizedRoute, node);
    }

    const node = nodes.get(normalizedRoute);
    if (source) addDiscoveredFrom(node, source);
    return node;
  }

  const htmlFiles = walkHtmlFiles(DIST_DIR);
  for (const filePath of htmlFiles) {
    const routePath = normalizeRoutePath(toRoutePath(filePath));
    const html = fs.readFileSync(filePath, 'utf8');
    const policy = getIndexabilityPolicy(routePath);
    const existingNode = nodes.get(routePath);
    const canonicalMatches = extractCanonicalMatches(html);
    const canonicalUrl = canonicalMatches[0] || '';
    let canonicalPath = '';
    if (canonicalUrl) {
      try {
        canonicalPath = normalizeRoutePath(new URL(canonicalUrl).pathname);
      } catch {
        canonicalPath = normalizeRoutePath(new URL(canonicalUrl, 'https://local.test').pathname);
      }
    }

    const schemaSummary = summarizeSchema(html);
    const node = createNode(routePath, policy, {
      isBuilt: true,
      filePath: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      canonicalUrl,
      canonicalPath: canonicalPath || policy.canonicalPath || routePath,
      inSitemap: sitemap.paths.has(routePath),
      robotsMeta: parseRobotsMeta(html),
      blockedByRobots: isBlockedByRobots(routePath, robotsDisallow),
      articleState: getArticleState(routePath, articleSeoState, policy),
      ...schemaSummary,
      inboundEdges: existingNode?.inboundEdges || [],
      outboundEdges: existingNode?.outboundEdges || [],
      discoveredFrom: existingNode?.discoveredFrom || [],
    });
    addDiscoveredFrom(node, 'build');
    nodes.set(routePath, node);

    const pageLinks = extractInternalLinks(html, routePath);
    for (const link of pageLinks) {
      if (!isLikelyTrackableRoute(link.pathname)) continue;
      const target = ensureNode(link.pathname, 'link');
      const edge = {
        from: routePath,
        to: target.routePath,
        area: link.area,
        rawHref: link.rawHref,
        hasQueryParams: link.hasQueryParams,
        query: link.search,
        hash: link.hash,
        supportWidget: link.supportWidget,
      };
      edges.push(edge);
      node.outboundEdges.push(edge);
      target.inboundEdges.push(edge);
    }
  }

  for (const sitemapPath of sitemap.paths) {
    ensureNode(sitemapPath, 'sitemap');
  }

  for (const node of nodes.values()) {
    node.linkSourcesByArea = {
      header: [...new Set(node.outboundEdges.filter((edge) => edge.area === 'header').map((edge) => edge.to))].sort(),
      footer: [...new Set(node.outboundEdges.filter((edge) => edge.area === 'footer').map((edge) => edge.to))].sort(),
      main: [...new Set(node.outboundEdges.filter((edge) => edge.area === 'main').map((edge) => edge.to))].sort(),
      other: [...new Set(node.outboundEdges.filter((edge) => edge.area === 'other').map((edge) => edge.to))].sort(),
    };
    node.inboundSourceCount = new Set(
      node.inboundEdges
        .map((edge) => edge.from)
        .filter((sourcePath) => nodes.get(sourcePath)?.isBuilt && sourcePath !== node.routePath)
    ).size;
    node.outboundTargetCount = new Set(
      node.outboundEdges
        .map((edge) => edge.to)
        .filter((targetPath) => nodes.get(targetPath)?.isBuilt && targetPath !== node.routePath)
    ).size;
  }

  const clickDepths = computeClickDepths(nodes, edges);
  for (const node of nodes.values()) {
    node.clickDepthFromHome = clickDepths.has(node.routePath) ? clickDepths.get(node.routePath) : null;
  }

  const failures = [];
  const warnings = [];
  const pushIssue = (node, severity, code, message, extra = {}) => {
    addIssue(node, severity, code, message, extra);
    const issue = {
      routePath: node.routePath,
      severity,
      code,
      message,
      ...extra,
    };
    if (severity === 'fail') {
      failures.push(issue);
    } else {
      warnings.push(issue);
    }
  };

  const builtNodes = [...nodes.values()].filter((node) => node.isBuilt);
  const builtRouteSet = new Set(builtNodes.map((node) => node.routePath));

  for (const node of builtNodes) {
    if (!node.canonicalUrl && node.classification !== 'blocked') {
      pushIssue(node, 'fail', 'canonical-missing', 'Built page is missing rel=canonical.');
    }

    if (node.classification !== 'blocked' && !builtRouteSet.has(node.canonicalPath)) {
      pushIssue(
        node,
        'fail',
        'canonical-route-resolves-in-build',
        `Canonical path "${node.canonicalPath}" does not resolve to a built HTML page.`
      );
    }

    if (node.index && node.blockedByRobots) {
      pushIssue(node, 'fail', 'robots-indexability-consistency', 'Indexable page is blocked by robots.txt.');
    }

    if (node.businessCount > 1) {
      pushIssue(
        node,
        'fail',
        'schema-duplication',
        `Page exposes ${node.businessCount} KitchenCabinetStore JSON-LD nodes; expected at most 1.`
      );
    }

    if (node.breadcrumbCount > 1) {
      pushIssue(
        node,
        'fail',
        'schema-duplication',
        `Page exposes ${node.breadcrumbCount} BreadcrumbList JSON-LD nodes; expected at most 1.`
      );
    }

    if (node.routePath !== '/' && node.index && node.inboundSourceCount === 0) {
      pushIssue(
        node,
        'fail',
        'graph-orphans',
        'Indexable page has zero inbound internal links from other built pages.'
      );
    }

    if (node.routePath !== '/' && node.index) {
      if (typeof node.clickDepthFromHome !== 'number') {
        pushIssue(node, 'fail', 'graph-click-depth', 'Indexable page is unreachable from the homepage crawl graph.');
      } else if (node.clickDepthFromHome > 3) {
        pushIssue(
          node,
          'fail',
          'graph-click-depth',
          `Indexable page is ${node.clickDepthFromHome} clicks from the homepage; limit is 3.`
        );
      }
    }

    if (node.routePath !== '/' && node.index && node.inboundSourceCount === 0 && !node.inSitemap) {
      pushIssue(
        node,
        'fail',
        'build-vs-link-discoverability',
        'Built indexable page is neither internally linked nor present in sitemap.'
      );
    }
  }

  const canonicalOwners = new Map();
  for (const node of builtNodes) {
    const owners = canonicalOwners.get(node.canonicalPath) || [];
    owners.push(node.routePath);
    canonicalOwners.set(node.canonicalPath, owners);
  }

  for (const [canonicalPath, owners] of canonicalOwners.entries()) {
    if (owners.length < 2) continue;
    for (const owner of owners) {
      pushIssue(
        nodes.get(owner),
        'fail',
        'route-collision',
        `Canonical path "${canonicalPath}" is claimed by multiple built pages: ${owners.join(', ')}.`
      );
    }
  }

  for (const edge of edges) {
    const sourceNode = nodes.get(edge.from);
    const targetNode = nodes.get(edge.to);
    if (!sourceNode || !targetNode || !sourceNode.isBuilt) continue;

    if (edge.hasQueryParams) {
      const queryDetail = edge.query ? ` (${edge.query})` : '';
      const message = targetNode.isBuilt
        ? `Internal link uses query params${queryDetail} and resolves to clean route "${targetNode.routePath}".`
        : `Internal link uses query params${queryDetail}, but target route "${edge.to}" is not built.`;
      pushIssue(sourceNode, 'warn', 'parameter-link-inventory', message, {
        targetPath: edge.to,
      });
    }

    if (!sourceNode.index || edge.area !== 'main' || !targetNode.isBuilt) continue;

    if (targetNode.canonicalPath !== targetNode.routePath) {
      pushIssue(
        sourceNode,
        'fail',
        'graph-noindex-link-leaks',
        `Main-content link points to "${targetNode.routePath}", which canonicalizes to "${targetNode.canonicalPath}".`,
        {
          targetPath: targetNode.routePath,
        }
      );
      continue;
    }

    if (!targetNode.index) {
      const isAllowedSupportTarget = ALLOWED_NOINDEX_TARGETS.has(targetNode.routePath);
      if (isAllowedSupportTarget && edge.supportWidget) {
        pushIssue(
          sourceNode,
          'warn',
          'parameter-link-inventory',
          `Support widget links to allowed noindex page "${targetNode.routePath}".`,
          {
            targetPath: targetNode.routePath,
          }
        );
        continue;
      }

      pushIssue(
        sourceNode,
        'fail',
        'graph-noindex-link-leaks',
        `Main-content link points to noindex page "${targetNode.routePath}".`,
        {
          targetPath: targetNode.routePath,
        }
      );
    }
  }

  const components = buildStronglyConnectedComponents(nodes, edges);
  for (const component of components) {
    if (component.length < 2) continue;
    const componentSet = new Set(component);
    const componentNodes = component.map((routePath) => nodes.get(routePath)).filter(Boolean);
    const hasIndexableNode = componentNodes.some((node) => node.index);
    if (!hasIndexableNode) continue;

    const reachableFromHome = componentNodes.some((node) => typeof node.clickDepthFromHome === 'number');
    let externalInbound = 0;
    let externalOutbound = 0;

    for (const node of componentNodes) {
      externalInbound += node.inboundEdges.filter(
        (edge) => nodes.get(edge.from)?.isBuilt && !componentSet.has(edge.from) && edge.from !== edge.to
      ).length;
      externalOutbound += node.outboundEdges.filter(
        (edge) => nodes.get(edge.to)?.isBuilt && !componentSet.has(edge.to) && edge.from !== edge.to
      ).length;
    }

    if (!reachableFromHome || (externalInbound === 0 && externalOutbound === 0)) {
      for (const node of componentNodes) {
        pushIssue(
          node,
          'fail',
          'graph-isolated-cycles',
          `Route participates in isolated crawl cycle: ${component.join(' -> ')}.`,
          {
            component,
          }
        );
      }
    }
  }

  const summary = {
    builtPages: builtNodes.length,
    indexablePages: builtNodes.filter((node) => node.index).length,
    noindexPages: builtNodes.filter((node) => !node.index && node.classification !== 'blocked').length,
    blockedPages: builtNodes.filter((node) => node.classification === 'blocked').length,
    sitemapUrls: sitemap.paths.size,
    edges: edges.length,
    readyArticles: builtNodes.filter((node) => node.articleState === 'ready-article').length,
    heldArticles: builtNodes.filter((node) => node.articleState === 'held-article').length,
    articleListIndexable: Boolean(nodes.get('/articles')?.index),
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    sitemapPaths: [...sitemap.paths].sort(),
    robotsDisallow,
    nodes: [...nodes.values()].sort((left, right) => left.routePath.localeCompare(right.routePath)),
    edges,
    failures,
    warnings,
    reportPaths: {
      json: REPORT_JSON_PATH,
      html: REPORT_HTML_PATH,
    },
    articleSeoState: {
      readyArticlePaths: [...readyArticlePathSet].sort(),
      hasReadyArticles: Boolean(articleSeoState?.hasReadyArticles),
    },
  };
}

export function writeCrawlReport(report) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const orphanRows = report.failures.filter((issue) => issue.code === 'graph-orphans');
  const depthRows = report.failures.filter((issue) => issue.code === 'graph-click-depth');
  const noindexLeakRows = report.failures.filter((issue) => issue.code === 'graph-noindex-link-leaks');
  const schemaRows = report.failures.filter((issue) => issue.code === 'schema-duplication');
  const allNodes = report.nodes;
  const graphSvg = buildGraphSvg(allNodes, report.edges);

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SEO Crawl Graph Report</title>
    <style>
      :root { color-scheme: light; --bg:#f8fafc; --card:#fff; --text:#0f172a; --muted:#475569; --border:#dbe4ee; --accent:#0f766e; --danger:#b91c1c; }
      * { box-sizing:border-box; }
      body { margin:0; font-family:"Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,sans-serif; background:var(--bg); color:var(--text); }
      main { margin:0 auto; max-width:1600px; padding:32px 24px 64px; }
      h1,h2,h3 { margin:0 0 12px; }
      p { margin:0; color:var(--muted); }
      .hero { display:grid; gap:12px; margin-bottom:24px; }
      .metrics { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); margin:24px 0; }
      .metric,.report-card { background:var(--card); border:1px solid var(--border); border-radius:18px; padding:18px; box-shadow:0 8px 24px rgba(15,23,42,.04); }
      .metric-label { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:.04em; }
      .metric-value { font-size:28px; font-weight:800; margin-top:8px; }
      .report-grid { display:grid; gap:18px; }
      .table-wrap { overflow-x:auto; }
      table { width:100%; border-collapse:collapse; }
      th,td { border-bottom:1px solid var(--border); padding:10px 12px; text-align:left; vertical-align:top; font-size:14px; }
      th { font-size:12px; color:var(--muted); letter-spacing:.04em; text-transform:uppercase; }
      .gate-pass { color:var(--accent); font-weight:700; }
      .gate-fail { color:var(--danger); font-weight:700; }
      .legend { display:flex; flex-wrap:wrap; gap:12px 18px; margin-top:12px; color:var(--muted); font-size:13px; }
      .legend span { display:inline-flex; align-items:center; gap:8px; }
      .legend-dot { display:inline-block; width:14px; height:14px; border-radius:999px; }
      .small-note { margin-top:8px; font-size:13px; color:var(--muted); }
      code { background:#eef2ff; border-radius:6px; padding:2px 6px; font-size:13px; }
      .paths { display:grid; gap:4px; margin-top:10px; }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>SEO Crawl Graph Report</h1>
        <p>Generated ${escapeHtml(report.generatedAt)} from built HTML in <code>dist/</code>.</p>
        <div class="paths">
          <p>JSON: <code>${escapeHtml(report.reportPaths.json)}</code></p>
          <p>HTML: <code>${escapeHtml(report.reportPaths.html)}</code></p>
        </div>
      </section>
      <section class="metrics">${renderMetrics(report)}</section>
      <section class="report-card">
        <h2>Crawl Graph</h2>
        <p>Layered by click depth from <code>/</code>. Red nodes have failures, amber nodes are built but noindex, gray nodes are blocked/system, green nodes are indexable and in sitemap.</p>
        <div class="legend">
          <span><i class="legend-dot" style="background:#86efac"></i> indexable + sitemap</span>
          <span><i class="legend-dot" style="background:#fcd34d"></i> built + noindex</span>
          <span><i class="legend-dot" style="background:#fca5a5"></i> conflicting or failed</span>
          <span><i class="legend-dot" style="background:#cbd5e1"></i> blocked/admin/system</span>
        </div>
        <div class="small-note">Edge colors: blue = header, purple = footer, orange = main, gray = other.</div>
        <div style="margin-top:18px; overflow:auto;">${graphSvg}</div>
      </section>
      <div class="report-grid">
        ${renderGateTable(report.gateResults)}
        ${renderIssueTable('Failures', report.failures, 'No graph failures.')}
        ${renderIssueTable('Warnings', report.warnings, 'No graph warnings.')}
        ${renderIssueTable('Orphan Indexable Pages', orphanRows, 'No orphan indexable pages.')}
        ${renderIssueTable('Click Depth Violations', depthRows, 'All indexable pages are within 3 clicks of the homepage.')}
        ${renderIssueTable('Noindex Link Leaks', noindexLeakRows, 'No forbidden main-content links to noindex or canonicalized-away pages.')}
        ${renderIssueTable('Schema Duplication', schemaRows, 'No duplicate KitchenCabinetStore or BreadcrumbList schema.')}
        ${renderArticleTable(report)}
      </div>
    </main>
    <script type="application/json" id="crawl-report-data">${safeJson(report)}</script>
  </body>
</html>
`;

  fs.writeFileSync(REPORT_HTML_PATH, html, 'utf8');

  return {
    jsonPath: REPORT_JSON_PATH,
    htmlPath: REPORT_HTML_PATH,
  };
}
