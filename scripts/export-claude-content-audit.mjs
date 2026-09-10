import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { load as loadHtml } from 'cheerio';
import yaml from 'js-yaml';

import { loadIndexabilityPolicyModule } from './lib/load-indexability-policy.mjs';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const CONTENT_DIR = path.join(ROOT, 'src', 'content');
const CONFIG_PATH = path.join(ROOT, 'src', 'config.yaml');
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const OUTPUT_DIR = path.join(ROOT, 'artifacts', 'claude-content-audit');
const BATCHES_DIR = path.join(OUTPUT_DIR, 'batches');
const PROMPTS_DIR = path.join(OUTPUT_DIR, 'prompts');
const TEMPLATE_DIR = path.join(ROOT, 'scripts', 'templates', 'claude-content-audit');
const PROMPT_TEMPLATE_DIR = path.join(TEMPLATE_DIR, 'prompts');

const MAX_BATCH_PAGES = 12;
const MAX_BATCH_WORDS = 10_000;

const EXCLUDED_ROUTE_PREFIXES = ['/admin', '/api', '/decapcms'];
const EXCLUDED_EXACT_ROUTES = new Set(['/404', '/410']);
const PROMPT_PACK_MANIFEST = [
  {
    kind: 'project-instructions',
    sourcePath: path.join(TEMPLATE_DIR, 'project-instructions.md'),
    outputPath: path.join(OUTPUT_DIR, 'project-instructions.md'),
  },
  {
    kind: 'prompt',
    sourcePath: path.join(PROMPT_TEMPLATE_DIR, 'full-content-audit.md'),
    outputPath: path.join(PROMPTS_DIR, 'full-content-audit.md'),
  },
  {
    kind: 'prompt',
    sourcePath: path.join(PROMPT_TEMPLATE_DIR, 'thin-eeat-quick-scan.md'),
    outputPath: path.join(PROMPTS_DIR, 'thin-eeat-quick-scan.md'),
  },
  {
    kind: 'prompt',
    sourcePath: path.join(PROMPT_TEMPLATE_DIR, 'deepen-weakest-pages.md'),
    outputPath: path.join(PROMPTS_DIR, 'deepen-weakest-pages.md'),
  },
  {
    kind: 'prompt',
    sourcePath: path.join(PROMPT_TEMPLATE_DIR, 'money-pages-audit.md'),
    outputPath: path.join(PROMPTS_DIR, 'money-pages-audit.md'),
  },
  {
    kind: 'prompt',
    sourcePath: path.join(PROMPT_TEMPLATE_DIR, 'faq-guides-audit.md'),
    outputPath: path.join(PROMPTS_DIR, 'faq-guides-audit.md'),
  },
];

const STATIC_ROUTE_META = new Map([
  ['/', { routeType: 'home', cluster: 'home', auditPriority: 'P1', sourceKind: 'static-template' }],
  ['/contacts', { routeType: 'contacts', cluster: 'trust', auditPriority: 'P3', sourceKind: 'static-template' }],
  ['/o-kompanii', { routeType: 'about', cluster: 'trust', auditPriority: 'P3', sourceKind: 'static-template' }],
  [
    '/projects',
    { routeType: 'projects-index', cluster: 'projects', auditPriority: 'P1', sourceKind: 'static-template' },
  ],
  [
    '/articles',
    { routeType: 'articles-index', cluster: 'articles', auditPriority: 'P2', sourceKind: 'static-template' },
  ],
  ['/guides', { routeType: 'guides-index', cluster: 'guides', auditPriority: 'P1', sourceKind: 'static-template' }],
  ['/faq', { routeType: 'faq-index', cluster: 'faq', auditPriority: 'P1', sourceKind: 'static-template' }],
  ['/privacy', { routeType: 'legal', cluster: 'legal', auditPriority: 'P3', sourceKind: 'static-template' }],
  ['/terms', { routeType: 'legal', cluster: 'legal', auditPriority: 'P3', sourceKind: 'static-template' }],
  ['/thanks', { routeType: 'thanks', cluster: 'conversion', auditPriority: 'P3', sourceKind: 'static-template' }],
  ['/kuhni-3-metra', { routeType: 'landing', cluster: 'landing', auditPriority: 'P1', sourceKind: 'static-template' }],
]);

const CONTENT_COLLECTIONS = [
  { collection: 'articles', dir: 'articles', buildPath: (slug) => `/articles/${slug}` },
  { collection: 'guides', dir: 'guides', buildPath: (slug) => `/guides/${slug}` },
  { collection: 'faq', dir: 'faq', buildPath: (slug) => `/faq/${slug}` },
  { collection: 'projects', dir: 'projects', buildPath: (slug) => `/projects/${slug}` },
  { collection: 'cities', dir: 'cities', buildPath: (slug) => `/${slug}` },
  { collection: 'services', dir: 'services', buildPath: (slug) => `/${slug}` },
];

const REMOVE_SELECTORS = [
  'header',
  'nav',
  'footer',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'picture',
  'img',
  'source',
  'iframe',
  'video',
  'audio',
  'canvas',
  'input',
  'textarea',
  'select',
  'option',
  '[hidden]',
  '[aria-hidden="true"]',
  '[style*="display:none"]',
  '[style*="display: none"]',
  '[style*="visibility:hidden"]',
  '[style*="visibility: hidden"]',
  '.sr-only',
  '.visually-hidden',
  '.skip-link',
  '.grecaptcha-badge',
  '[data-honeypot]',
  '[data-analytics]',
  '[data-metrics]',
  '[data-tracking]',
  'meta',
  'link',
];

const BLOCKISH_TAGS = new Set([
  'main',
  'section',
  'article',
  'div',
  'p',
  'li',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'dl',
  'dt',
  'dd',
  'form',
  'fieldset',
  'legend',
  'aside',
  'button',
  'label',
  'summary',
  'details',
]);

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'picture',
  'img',
  'source',
  'iframe',
  'video',
  'audio',
  'canvas',
  'input',
  'textarea',
  'select',
  'option',
]);

function normalizePath(pathname) {
  const normalized = `/${String(pathname || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMultilineText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function countWords(text) {
  return normalizeText(text).split(/\s+/).filter(Boolean).length;
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function relativePosix(filePath) {
  return toPosixPath(path.relative(ROOT, filePath));
}

function extractFrontmatter(source) {
  const raw = String(source || '');
  if (!raw.startsWith('---')) return null;
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1] : null;
}

function parseFrontmatterFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const frontmatterSource = extractFrontmatter(raw);
  if (!frontmatterSource) {
    return { frontmatter: {}, body: raw };
  }

  let frontmatter = {};
  try {
    frontmatter = (yaml.load(frontmatterSource) || {}) ?? {};
  } catch {
    frontmatter = {};
  }

  const body = raw.slice(frontmatterSource.length + 8);
  return { frontmatter, body };
}

function listFilesRecursive(dirPath, predicate) {
  if (!fs.existsSync(dirPath)) return [];
  const output = [];
  const stack = [dirPath];

  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && predicate(entry.name, fullPath)) {
        output.push(fullPath);
      }
    }
  }

  return output.sort((a, b) => a.localeCompare(b, 'ru'));
}

function slugFromFile(filePath, frontmatter) {
  const base = path.basename(filePath).replace(/\.mdx?$/i, '');
  return String(frontmatter?.slug || base).trim();
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadSiteUrl() {
  const fromEnv = String(process.env.PUBLIC_SITE_URL || '').trim();
  if (fromEnv) return validateSiteUrl(fromEnv);

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('[claude-audit] PUBLIC_SITE_URL is missing and src/config.yaml was not found.');
  }

  const config = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  const fromConfig = String(config?.site?.site || '').trim();
  if (!fromConfig) {
    throw new Error('[claude-audit] PUBLIC_SITE_URL is missing and site.site is empty in src/config.yaml.');
  }

  return validateSiteUrl(fromConfig);
}

function validateSiteUrl(value) {
  try {
    return new URL(String(value).trim());
  } catch {
    throw new Error(`[claude-audit] invalid site URL: ${String(value || '')}`);
  }
}

function buildAbsoluteUrl(pathname, siteUrl) {
  return new URL(pathname, siteUrl).toString();
}

function isAbsoluteUrl(value) {
  return /^[a-z]+:\/\//i.test(String(value || '').trim());
}

function routeFromHtmlFile(filePath) {
  const relativePath = toPosixPath(path.relative(DIST_DIR, filePath));
  if (relativePath === 'index.html') return '/';
  if (relativePath.endsWith('/index.html')) {
    return normalizePath(relativePath.slice(0, -'/index.html'.length));
  }
  if (relativePath.endsWith('.html')) {
    return normalizePath(relativePath.slice(0, -'.html'.length));
  }
  return normalizePath(relativePath);
}

function shouldExcludeRoute(routePath) {
  if (EXCLUDED_EXACT_ROUTES.has(routePath)) return true;
  return EXCLUDED_ROUTE_PREFIXES.some((prefix) => routePath === prefix || routePath.startsWith(`${prefix}/`));
}

function loadContentMetadataMap() {
  const metadataMap = new Map();

  for (const entry of CONTENT_COLLECTIONS) {
    const dirPath = path.join(CONTENT_DIR, entry.dir);
    const files = listFilesRecursive(dirPath, (name) => /\.mdx?$/i.test(name));
    for (const filePath of files) {
      const { frontmatter } = parseFrontmatterFile(filePath);
      const slug = slugFromFile(filePath, frontmatter);
      if (!slug) continue;

      const routePath = normalizePath(entry.buildPath(slug));
      metadataMap.set(routePath, {
        collection: entry.collection,
        contentFile: relativePosix(filePath),
        primaryKeyword: normalizeText(frontmatter?.mainKeyword || ''),
        sourceKind: 'content-collection',
      });
    }
  }

  return metadataMap;
}

function loadGeneratedPageMetadataMap() {
  const generatedPages = readJson(GENERATED_PAGES_PATH, []);
  const metadataMap = new Map();

  for (const page of Array.isArray(generatedPages) ? generatedPages : []) {
    const routePath = normalizePath(page?.pageSlug || '');
    if (!routePath || routePath === '/') continue;
    metadataMap.set(routePath, {
      primaryKeyword: normalizeText(page?.primaryKeyword || ''),
      sourceKind: 'generated-page',
    });
  }

  return metadataMap;
}

function discoverPublicHtmlPages() {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('[claude-audit] dist directory is missing. Run npm run build first.');
  }

  const htmlFiles = listFilesRecursive(DIST_DIR, (name) => name.toLowerCase().endsWith('.html'));
  const discovered = [];
  const seen = new Set();

  for (const filePath of htmlFiles) {
    const routePath = routeFromHtmlFile(filePath);
    if (shouldExcludeRoute(routePath)) continue;
    if (seen.has(routePath)) {
      throw new Error(`[claude-audit] duplicate public route discovered for ${routePath}`);
    }
    seen.add(routePath);
    discovered.push({ routePath, filePath });
  }

  return discovered.sort((a, b) => a.routePath.localeCompare(b.routePath, 'ru'));
}

function inferRouteType(routePath, mergedMetadata) {
  if (STATIC_ROUTE_META.has(routePath)) {
    return STATIC_ROUTE_META.get(routePath).routeType;
  }
  if (routePath.startsWith('/projects/')) return 'project';
  if (routePath.startsWith('/articles/')) return 'article';
  if (routePath.startsWith('/guides/')) return 'guide';
  if (routePath.startsWith('/faq/')) return 'faq';
  if (mergedMetadata?.collection === 'cities') return 'city';
  if (mergedMetadata?.collection === 'services' || mergedMetadata?.sourceKind === 'generated-page') return 'service';
  return 'static';
}

function inferCluster(routePath, routeType) {
  if (STATIC_ROUTE_META.has(routePath)) {
    return STATIC_ROUTE_META.get(routePath).cluster;
  }

  switch (routeType) {
    case 'service':
      return 'services';
    case 'project':
    case 'projects-index':
      return 'projects';
    case 'article':
    case 'articles-index':
      return 'articles';
    case 'guide':
    case 'guides-index':
      return 'guides';
    case 'faq':
    case 'faq-index':
      return 'faq';
    case 'city':
      return 'city-hubs';
    case 'about':
    case 'contacts':
      return 'trust';
    case 'legal':
      return 'legal';
    case 'thanks':
      return 'conversion';
    case 'landing':
      return 'landing';
    case 'home':
      return 'home';
    default:
      return 'support';
  }
}

function inferAuditPriority(routePath, routeType) {
  if (STATIC_ROUTE_META.has(routePath)) {
    return STATIC_ROUTE_META.get(routePath).auditPriority;
  }

  switch (routeType) {
    case 'service':
    case 'project':
    case 'projects-index':
    case 'guide':
    case 'guides-index':
    case 'faq':
    case 'faq-index':
    case 'city':
    case 'landing':
    case 'home':
      return 'P1';
    case 'article':
    case 'articles-index':
      return 'P2';
    default:
      return 'P3';
  }
}

function priorityRank(value) {
  return value === 'P1' ? 1 : value === 'P2' ? 2 : 3;
}

function getHtmlAttribute($doc, selector, attribute) {
  return normalizeText($doc(selector).first().attr(attribute) || '');
}

function parseRobotsMeta(rawValue) {
  const value = normalizeText(rawValue).toLowerCase();
  if (!value) return null;

  const tokens = new Set(
    value
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
  );
  return {
    raw: value,
    index: !tokens.has('noindex'),
    follow: !tokens.has('nofollow'),
  };
}

function isRedirectOnlyDocument($doc) {
  const refreshContent = normalizeText($doc('meta[http-equiv="refresh"]').attr('content') || '');
  if (!refreshContent) return false;
  return /url\s*=/.test(refreshContent.toLowerCase());
}

function deriveIndexability(routePath, robotsMeta, getIndexabilityPolicy) {
  const policy = getIndexabilityPolicy(routePath);
  const rendered = robotsMeta ?? {
    raw: '',
    index: Boolean(policy.index),
    follow: Boolean(policy.follow),
  };

  if (
    robotsMeta &&
    policy.isKnown &&
    (robotsMeta.index !== Boolean(policy.index) || robotsMeta.follow !== Boolean(policy.follow))
  ) {
    throw new Error(
      `[claude-audit] robots mismatch for ${routePath}: rendered=${robotsMeta.raw} policy=${policy.classification}`
    );
  }

  return {
    classification: String(policy.classification || 'unknown'),
    index: Boolean(rendered.index),
    follow: Boolean(rendered.follow),
    includeInSitemap: Boolean(policy.includeInSitemap),
  };
}

function removeNoise($root) {
  $root.find(REMOVE_SELECTORS.join(',')).remove();
  return $root;
}

function ensureParagraphBreak(chunks) {
  if (chunks.length === 0) return;
  const last = chunks[chunks.length - 1];
  if (/\n\n$/.test(last)) return;
  if (/\n$/.test(last)) {
    chunks[chunks.length - 1] = `${last}\n`;
    return;
  }
  chunks.push('\n\n');
}

function appendNormalizedText(chunks, rawText) {
  const text = normalizeText(rawText);
  if (!text) return;

  if (chunks.length === 0) {
    chunks.push(text);
    return;
  }

  const last = chunks[chunks.length - 1];
  if (/[ \n]$/.test(last) || last.endsWith('- ') || last.endsWith('> ') || /#+ $/.test(last)) {
    chunks.push(text);
    return;
  }

  chunks.push(` ${text}`);
}

function buildStructuredText(node) {
  const chunks = [];

  function walk(current) {
    if (!current) return;

    if (current.type === 'text') {
      appendNormalizedText(chunks, current.data || '');
      return;
    }

    if (current.type !== 'tag') return;

    const tag = String(current.name || '').toLowerCase();
    if (!tag || SKIP_TAGS.has(tag)) return;

    if (tag === 'br') {
      chunks.push('\n');
      return;
    }

    const isHeading = /^h[1-6]$/.test(tag);
    if (isHeading) {
      ensureParagraphBreak(chunks);
      chunks.push(`${'#'.repeat(Number(tag.slice(1)))} `);
    } else if (tag === 'li') {
      ensureParagraphBreak(chunks);
      chunks.push('- ');
    } else if (tag === 'blockquote') {
      ensureParagraphBreak(chunks);
      chunks.push('> ');
    } else if (tag === 'hr') {
      ensureParagraphBreak(chunks);
      chunks.push('---');
      ensureParagraphBreak(chunks);
      return;
    } else if (BLOCKISH_TAGS.has(tag)) {
      ensureParagraphBreak(chunks);
    }

    for (const child of current.children || []) {
      walk(child);
    }

    if (
      isHeading ||
      tag === 'p' ||
      tag === 'li' ||
      tag === 'blockquote' ||
      tag === 'tr' ||
      tag === 'dt' ||
      tag === 'dd' ||
      tag === 'button' ||
      tag === 'legend' ||
      tag === 'label' ||
      tag === 'summary'
    ) {
      ensureParagraphBreak(chunks);
      return;
    }

    if (tag === 'td' || tag === 'th') {
      chunks.push(' | ');
      return;
    }

    if (BLOCKISH_TAGS.has(tag)) {
      ensureParagraphBreak(chunks);
    }
  }

  walk(node);
  return normalizeMultilineText(chunks.join(''));
}

function extractAnalysisText(html) {
  const $doc = loadHtml(html);
  const $contentRoot = $doc('main').first().length > 0 ? $doc('main').first().clone() : $doc('body').first().clone();
  removeNoise($contentRoot);
  return buildStructuredText($contentRoot.get(0));
}

function buildMergedMetadata(routePath, contentMetadataMap, generatedMetadataMap) {
  const contentMetadata = contentMetadataMap.get(routePath) || null;
  const generatedMetadata = generatedMetadataMap.get(routePath) || null;
  const staticMetadata = STATIC_ROUTE_META.get(routePath) || null;

  return {
    collection: contentMetadata?.collection || null,
    contentFile: contentMetadata?.contentFile || null,
    primaryKeyword:
      normalizeText(generatedMetadata?.primaryKeyword || '') ||
      normalizeText(contentMetadata?.primaryKeyword || '') ||
      '',
    sourceKind:
      generatedMetadata?.sourceKind || contentMetadata?.sourceKind || staticMetadata?.sourceKind || 'rendered-html',
  };
}

function validateRecord(record) {
  const requiredStringFields = [
    'route_path',
    'public_url',
    'route_type',
    'cluster',
    'audit_priority',
    'title',
    'h1',
    'meta_description',
    'canonical',
    'analysis_text',
  ];

  for (const field of requiredStringFields) {
    if (!normalizeText(record[field])) {
      throw new Error(`[claude-audit] missing required field "${field}" for ${record.route_path}`);
    }
  }

  if (!record.indexability || typeof record.indexability !== 'object') {
    throw new Error(`[claude-audit] missing required field "indexability" for ${record.route_path}`);
  }

  if (!Number.isInteger(record.word_count) || record.word_count <= 0) {
    throw new Error(`[claude-audit] invalid word_count for ${record.route_path}`);
  }
}

function formatIndexability(indexability) {
  const robotsLabel = indexability.index ? 'index' : 'noindex';
  const followLabel = indexability.follow ? 'follow' : 'nofollow';
  return `${robotsLabel},${followLabel} (${indexability.classification})`;
}

function escapeCsv(value) {
  const normalized = String(value ?? '');
  const escaped = normalized.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function toCsv(records) {
  const columns = [
    'route_path',
    'public_url',
    'route_type',
    'cluster',
    'audit_priority',
    'collection',
    'source_kind',
    'content_file',
    'primary_keyword',
    'indexability',
    'title',
    'h1',
    'meta_description',
    'canonical',
    'word_count',
    'analysis_text',
  ];

  const lines = [columns.join(',')];
  for (const record of records) {
    const row = columns.map((column) => {
      if (column === 'indexability') {
        return escapeCsv(formatIndexability(record.indexability));
      }
      return escapeCsv(record[column] ?? '');
    });
    lines.push(row.join(','));
  }
  return `${lines.join('\n')}\n`;
}

function toJsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function buildBatchGroups(records) {
  const batches = [];
  let current = [];
  let currentWords = 0;

  for (const record of records) {
    const wouldExceedPageLimit = current.length >= MAX_BATCH_PAGES;
    const wouldExceedWordLimit = current.length > 0 && currentWords + record.word_count > MAX_BATCH_WORDS;

    if (wouldExceedPageLimit || wouldExceedWordLimit) {
      batches.push(current);
      current = [];
      currentWords = 0;
    }

    current.push(record);
    currentWords += record.word_count;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

function buildBatchMarkdown(batch, batchIndex, totalBatches) {
  const totalWords = batch.reduce((sum, record) => sum + record.word_count, 0);
  const prioritySummary = batch.reduce((acc, record) => {
    acc[record.audit_priority] = (acc[record.audit_priority] || 0) + 1;
    return acc;
  }, {});

  const headerLines = [
    `# Claude Content Audit Batch ${String(batchIndex + 1).padStart(2, '0')}`,
    '',
    `- Pages: ${batch.length}`,
    `- Words: ${totalWords}`,
    `- Batch: ${batchIndex + 1} of ${totalBatches}`,
    `- Priority mix: ${Object.entries(prioritySummary)
      .sort(([a], [b]) => priorityRank(a) - priorityRank(b))
      .map(([priority, count]) => `${priority}=${count}`)
      .join(', ')}`,
    '',
    'Use the generated prompts from `../prompts/` with this file in Claude Projects/Artifacts.',
    '',
  ];

  const pageSections = batch.map((record, index) => {
    const metadataLines = [
      `## Page ${index + 1}`,
      '',
      `- URL: ${record.public_url}`,
      `- Route path: ${record.route_path}`,
      `- Type: ${record.route_type}`,
      `- Cluster: ${record.cluster}`,
      `- Audit priority: ${record.audit_priority}`,
      `- Indexability: ${formatIndexability(record.indexability)}`,
      `- Collection: ${record.collection || 'n/a'}`,
      `- Source kind: ${record.source_kind || 'n/a'}`,
      `- Content file: ${record.content_file || 'n/a'}`,
      `- Primary keyword: ${record.primary_keyword || 'n/a'}`,
      `- Word count: ${record.word_count}`,
      `- Title: ${record.title}`,
      `- H1: ${record.h1}`,
      `- Meta description: ${record.meta_description}`,
      `- Canonical: ${record.canonical}`,
      '',
      '### Analysis text',
      '',
      record.analysis_text,
      '',
      '---',
      '',
    ];
    return metadataLines.join('\n');
  });

  return `${headerLines.join('\n')}${pageSections.join('')}`;
}

function buildReadme(totalPages, totalBatches) {
  return `# Claude Content Audit Export

Этот каталог генерируется командой \`npm run audit:content:claude\`.

## Что внутри

- \`pages.json\` — полный канонический корпус страниц
- \`pages.jsonl\` — одна страница в строке
- \`pages.csv\` — плоский экспорт для сортировки
- \`project-instructions.md\` — текст для Claude Project Instructions
- \`batches/\` — батчи для ручной загрузки в Claude Projects/Artifacts
- \`prompts/\` — полный prompt pack под этот формат

## Корпус

- Страниц: ${totalPages}
- Батчей: ${totalBatches}
- Источник текста: очищенный рендер из \`dist/**/*.html\`

## Рекомендуемый поток

1. Запусти сборку и экспорт:
   - PowerShell: \`$env:PUBLIC_SITE_URL='https://mebel-irkutsk.ru'; npm run audit:content:claude\`
2. Открой один файл из \`batches/\`, начиная с первого батча, и загрузи его в Claude Projects/Artifacts.
3. Вставь \`project-instructions.md\` в Claude Project Instructions.
4. Запусти \`prompts/full-content-audit.md\`.
5. Затем запусти \`prompts/deepen-weakest-pages.md\`.
6. Затем запусти \`prompts/money-pages-audit.md\`.
7. Затем запусти \`prompts/faq-guides-audit.md\`.
8. При необходимости запусти \`prompts/thin-eeat-quick-scan.md\`.

## Примечания

- В корпус входят все публичные user-facing HTML-страницы, включая noindex/support pages.
- \`/admin/*\`, \`/api/*\`, \`/404\` и \`/410\` исключены.
- Для Claude v1 используется только manual Projects/chunks flow: без API и без обратного импорта оценок.`;
}

function validatePromptPackManifest() {
  const seenOutputs = new Set();

  for (const entry of PROMPT_PACK_MANIFEST) {
    if (!fs.existsSync(entry.sourcePath)) {
      throw new Error(`[claude-audit] required ${entry.kind} template is missing: ${relativePosix(entry.sourcePath)}`);
    }

    const normalizedOutput = toPosixPath(entry.outputPath);
    if (seenOutputs.has(normalizedOutput)) {
      throw new Error(`[claude-audit] duplicate prompt-pack output path: ${normalizedOutput}`);
    }
    seenOutputs.add(normalizedOutput);
  }
}

async function copyPromptPack() {
  await Promise.all(
    PROMPT_PACK_MANIFEST.map(async (entry) => {
      await fsp.mkdir(path.dirname(entry.outputPath), { recursive: true });
      await fsp.copyFile(entry.sourcePath, entry.outputPath);
    })
  );
}

async function main() {
  validatePromptPackManifest();

  const siteUrl = loadSiteUrl();
  const contentMetadataMap = loadContentMetadataMap();
  const generatedMetadataMap = loadGeneratedPageMetadataMap();
  const discoveredRoutes = discoverPublicHtmlPages();
  const { getIndexabilityPolicy } = await loadIndexabilityPolicyModule();

  const records = [];
  let skippedRedirectRoutes = 0;

  for (const discovered of discoveredRoutes) {
    const html = await fsp.readFile(discovered.filePath, 'utf8');
    const $doc = loadHtml(html);
    if (isRedirectOnlyDocument($doc)) {
      skippedRedirectRoutes += 1;
      continue;
    }

    const mergedMetadata = buildMergedMetadata(discovered.routePath, contentMetadataMap, generatedMetadataMap);
    const routeType = inferRouteType(discovered.routePath, mergedMetadata);
    const cluster = inferCluster(discovered.routePath, routeType);
    const auditPriority = inferAuditPriority(discovered.routePath, routeType);
    const title = normalizeText($doc('title').first().text());
    const h1 = normalizeText($doc('h1').first().text());
    const metaDescription =
      getHtmlAttribute($doc, 'meta[name="description"]', 'content') ||
      getHtmlAttribute($doc, 'meta[property="og:description"]', 'content');
    const rawCanonical = getHtmlAttribute($doc, 'link[rel="canonical"]', 'href');
    const canonical = rawCanonical
      ? isAbsoluteUrl(rawCanonical)
        ? rawCanonical
        : buildAbsoluteUrl(rawCanonical, siteUrl)
      : '';
    const robotsMeta =
      parseRobotsMeta(getHtmlAttribute($doc, 'meta[name="robots"]', 'content')) ||
      parseRobotsMeta(getHtmlAttribute($doc, 'meta[name="googlebot"]', 'content'));
    const indexability = deriveIndexability(discovered.routePath, robotsMeta, getIndexabilityPolicy);
    const analysisText = extractAnalysisText(html);
    const wordCount = countWords(analysisText);

    const record = {
      route_path: discovered.routePath,
      public_url: buildAbsoluteUrl(discovered.routePath, siteUrl),
      route_type: routeType,
      cluster,
      audit_priority: auditPriority,
      indexability,
      title,
      h1,
      meta_description: metaDescription,
      canonical,
      word_count: wordCount,
      analysis_text: analysisText,
      content_file: mergedMetadata.contentFile || undefined,
      primary_keyword: mergedMetadata.primaryKeyword || undefined,
      collection: mergedMetadata.collection || undefined,
      source_kind: mergedMetadata.sourceKind || undefined,
    };

    validateRecord(record);
    records.push(record);
  }

  records.sort((a, b) => {
    const priorityDiff = priorityRank(a.audit_priority) - priorityRank(b.audit_priority);
    if (priorityDiff !== 0) return priorityDiff;
    const typeDiff = a.route_type.localeCompare(b.route_type, 'ru');
    if (typeDiff !== 0) return typeDiff;
    return a.route_path.localeCompare(b.route_path, 'ru');
  });

  if (records.length + skippedRedirectRoutes !== discoveredRoutes.length) {
    throw new Error(
      `[claude-audit] exported ${records.length} pages, skipped ${skippedRedirectRoutes} redirects, but discovered ${discoveredRoutes.length} public HTML pages`
    );
  }

  const batches = buildBatchGroups(records);
  const seenRoutes = new Set();
  for (const batch of batches) {
    for (const record of batch) {
      if (seenRoutes.has(record.route_path)) {
        throw new Error(`[claude-audit] duplicate route in batches: ${record.route_path}`);
      }
      seenRoutes.add(record.route_path);
    }
  }
  if (seenRoutes.size !== records.length) {
    throw new Error(`[claude-audit] batch coverage mismatch: batched=${seenRoutes.size}, exported=${records.length}`);
  }

  await fsp.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fsp.mkdir(BATCHES_DIR, { recursive: true });
  await fsp.mkdir(PROMPTS_DIR, { recursive: true });

  await Promise.all([
    fsp.writeFile(path.join(OUTPUT_DIR, 'pages.json'), `${JSON.stringify(records, null, 2)}\n`, 'utf8'),
    fsp.writeFile(path.join(OUTPUT_DIR, 'pages.jsonl'), toJsonl(records), 'utf8'),
    fsp.writeFile(path.join(OUTPUT_DIR, 'pages.csv'), toCsv(records), 'utf8'),
  ]);

  await Promise.all(
    batches.map((batch, index) =>
      fsp.writeFile(
        path.join(BATCHES_DIR, `batch-${String(index + 1).padStart(2, '0')}.md`),
        buildBatchMarkdown(batch, index, batches.length),
        'utf8'
      )
    )
  );

  await copyPromptPack();

  await Promise.all([
    fsp.writeFile(path.join(OUTPUT_DIR, 'README.md'), `${buildReadme(records.length, batches.length)}\n`, 'utf8'),
  ]);

  console.log(
    `[claude-audit] exported ${records.length} pages into ${batches.length} batches (skipped redirects: ${skippedRedirectRoutes}) -> ${relativePosix(OUTPUT_DIR)}`
  );
}

main().catch((error) => {
  console.error('[claude-audit] export failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
