import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadIndexabilityPolicyModule } from './lib/load-indexability-policy.mjs';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const CITIES_PATH = path.join(ROOT, 'data', 'cities.json');
const ANCHOR_MAP_PATH = path.join(ROOT, 'src', 'utils', 'anchor-map.js');

const MAX_REPEAT = Number(process.env.MAX_ANCHOR_REPEAT || 2);
const MAX_EXACT = Number(process.env.MAX_EXACT_ANCHORS || 1);
const MAX_LINKS = Number(process.env.MAX_PAGE_LINKS || 10);

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function toRoutePath(filePath) {
  const relative = path.relative(DIST_DIR, filePath).replace(/\\/g, '/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'/index.html'.length)}`;
  if (relative.endsWith('.html')) return `/${relative.slice(0, -'.html'.length)}`;
  return `/${relative}`;
}

function extractMain(html) {
  const match = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return match ? match[1] : html;
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function normalizeAnchorText(value) {
  const stripped = stripTags(value);
  const decoded = decodeEntities(stripped);
  return decoded.replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseTagAttributes(raw) {
  const attrs = {};
  const attrRegex = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = attrRegex.exec(raw)) !== null) {
    const key = String(match[1] || '').toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = String(value);
  }
  return attrs;
}

function shouldSkipAnchor(attrs) {
  if (!attrs) return false;
  if (attrs['data-anchor-spam'] === 'ignore') return true;
  if ('data-cta' in attrs || 'data-cta-type' in attrs) return true;
  const href = String(attrs.href || '').trim();
  if (!href) return true;
  if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
    return true;
  }
  if (href.startsWith('http://') || href.startsWith('https://')) return true;
  return false;
}

function extractAnchors(html) {
  const anchors = [];
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const attrs = parseTagAttributes(match[1] || '');
    if (shouldSkipAnchor(attrs)) continue;
    const text = normalizeAnchorText(match[2]);
    if (text) anchors.push(text);
  }
  return anchors;
}

function expandTemplate(text, cityName, cityIn) {
  return text
    .replace('{city}', cityName)
    .replace('{cityIn}', cityIn)
    .replace(/\s+/g, ' ')
    .trim();
}

function buildExactAnchorSet(anchorMap, cities) {
  const exactSet = new Set();
  const services = Object.values(anchorMap || {});
  for (const service of services) {
    const exactTemplates = Array.isArray(service?.exact) ? service.exact : [];
    for (const template of exactTemplates) {
      const text = String(template?.text || '').trim();
      if (!text) continue;
      if (template?.needsCity) {
        for (const city of cities) {
          const cityName = String(city?.name || '').trim();
          if (!cityName) continue;
          exactSet.add(normalizeAnchorText(expandTemplate(text, cityName, cityName)));
        }
        continue;
      }
      if (template?.needsCityIn) {
        for (const city of cities) {
          const cityIn = String(city?.nameIn || '').trim();
          if (!cityIn) continue;
          exactSet.add(normalizeAnchorText(expandTemplate(text, cityIn, cityIn)));
        }
        continue;
      }
      exactSet.add(normalizeAnchorText(text));
    }
  }
  return exactSet;
}

async function loadAnchorMap() {
  const url = pathToFileURL(ANCHOR_MAP_PATH).href;
  const module = await import(url);
  return {
    serviceAnchors: module?.SERVICE_ANCHORS || {},
    contextAnchors: module?.SERVICE_CONTEXT_ANCHORS || {},
  };
}

async function main() {
  assert(fs.existsSync(DIST_DIR), 'dist is missing. Run "npm run build" first.');
  assert(fs.existsSync(CITIES_PATH), 'cities.json is missing.');

  const { getIndexabilityPolicy } = await loadIndexabilityPolicyModule();
  const { serviceAnchors, contextAnchors } = await loadAnchorMap();
  const cities = JSON.parse(fs.readFileSync(CITIES_PATH, 'utf8'));
  const exactAnchorSet = new Set([
    ...buildExactAnchorSet(serviceAnchors, cities),
    ...buildExactAnchorSet(contextAnchors, cities),
  ]);

  const pages = walkHtmlFiles(DIST_DIR);
  assert(pages.length > 0, 'No built HTML pages found in dist/.');

  const errors = [];
  const warnings = [];
  const siteCounts = new Map();
  let analyzedPages = 0;

  for (const htmlPath of pages) {
    const slug = toRoutePath(htmlPath);
    const policy = getIndexabilityPolicy(slug);
    if (!policy.index) continue;

    const html = fs.readFileSync(htmlPath, 'utf8');
    const anchors = extractAnchors(extractMain(html));
    if (anchors.length === 0) {
      analyzedPages += 1;
      continue;
    }

    analyzedPages += 1;
    const counts = new Map();
    let exactCount = 0;

    for (const text of anchors) {
      counts.set(text, (counts.get(text) || 0) + 1);
      siteCounts.set(text, (siteCounts.get(text) || 0) + 1);
      if (exactAnchorSet.has(text)) exactCount += 1;
    }

    const pageErrors = [];
    const pageWarnings = [];

    for (const [text, count] of counts.entries()) {
      if (count > MAX_REPEAT) {
        pageWarnings.push(`- "${text}" ×${count} (limit ${MAX_REPEAT})`);
      }
    }

    if (exactCount > MAX_EXACT) {
      pageErrors.push(`- exact anchors: ${exactCount} (limit ${MAX_EXACT})`);
    }

    if (anchors.length > MAX_LINKS) {
      pageWarnings.push(`- total links: ${anchors.length} (limit ${MAX_LINKS})`);
    }

    if (pageErrors.length > 0) {
      errors.push(`[anchor-spam] ${slug}\n${pageErrors.join('\n')}`);
    }
    if (pageWarnings.length > 0) {
      warnings.push(`[anchor-spam] ${slug}\n${pageWarnings.join('\n')}`);
    }
  }

  if (warnings.length > 0) {
    console.warn(`Anchor spam warnings (${warnings.length}):\n${warnings.join('\n')}`);
  }

  const topAnchors = [...siteCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([text, count]) => `"${text}" ×${count}`);

  if (errors.length > 0) {
    const topLine = topAnchors.length > 0 ? `\nTop anchors: ${topAnchors.join(', ')}` : '';
    throw new Error(`Anchor spam check failed (${errors.length}):\n${errors.join('\n')}${topLine}`);
  }

  const topSummary = topAnchors.length > 0 ? ` Top anchors: ${topAnchors.join(', ')}.` : '';
  console.log(`Anchor spam check passed: pages=${analyzedPages}.${topSummary}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
