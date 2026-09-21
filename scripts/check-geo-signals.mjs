import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const LOCAL_CITY_BLOCKS_PATH = path.join(ROOT, 'data', 'local-city-blocks.json');
const REQUIRED_CITIES = [{ id: 'irkutsk', label: 'Иркутск', href: '/irkutsk', minCases: 2 }];
const REQUIRED_CITY_IDS = new Set(REQUIRED_CITIES.map((city) => city.id));
const REQUIRED_CITY_HREFS = new Set(REQUIRED_CITIES.map((city) => city.href));
const REQUIRED_CITY_LABELS = new Set(REQUIRED_CITIES.map((city) => city.label));
const FORBIDDEN_HUB_SCHEMA_TYPES = new Set(['Service', 'Offer', 'OfferCatalog', 'Product']);

function fail(message) {
  throw new Error(message);
}

function normalizePathname(value) {
  const normalized = `/${String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function toDistHtmlPath(routePath) {
  const normalized = normalizePathname(routePath);
  if (normalized === '/') return path.join(DIST_DIR, 'index.html');
  return path.join(DIST_DIR, normalized.slice(1), 'index.html');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTagAttributes(tag) {
  const attrs = {};
  const attrRegex = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = attrRegex.exec(tag)) !== null) {
    attrs[String(match[1] || '').toLowerCase()] = String(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function parseRobotsMeta(html) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const attrs = parseTagAttributes(tag);
    if ((attrs.name || '').toLowerCase() !== 'robots') continue;
    return String(attrs.content || '')
      .toLowerCase()
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function extractSectionByClass(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `<section\\b[^>]*class=(["'])[^"']*\\b${escaped}\\b[^"']*\\1[^>]*>([\\s\\S]*?)<\\/section>`,
    'i'
  );
  const match = html.match(regex);
  return match ? match[2] : '';
}

function extractAnchorTags(html) {
  const anchors = [];
  const regex = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    anchors.push({
      href: normalizePathname(match[2]),
      text: stripHtml(match[3]),
    });
  }
  return anchors;
}

function extractLocalCityBlocks(html) {
  const blocks = [];
  const regex = /<article\b[^>]*data-local-city-block=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    blocks.push({
      cityId: String(match[2] || '')
        .trim()
        .toLowerCase(),
      html: match[3],
    });
  }
  return blocks;
}

function extractGeoMentionLayer(html) {
  const match = html.match(/<([a-z0-9:-]+)\b[^>]*data-geo-mention-layer\b[^>]*>([\s\S]*?)<\/\1>/i);
  return match ? stripHtml(match[2]) : '';
}

function extractJsonLdBlocks(html) {
  const blocks = [];
  const regex = /<script\b[^>]*type=(['"])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    blocks.push((match[2] || '').trim());
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

function getField(record, fieldName) {
  if (!record || typeof record !== 'object') return undefined;
  return record[fieldName];
}

function collectTypedNodes(value, bucket, visited) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectTypedNodes(item, bucket, visited));
    return;
  }
  if (typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);

  const typeNames = normalizeTypeNames(value['@type']);
  if (typeNames.length > 0) {
    bucket.push({ node: value, typeNames });
  }

  Object.values(value).forEach((child) => collectTypedNodes(child, bucket, visited));
}

function parseTypedNodesFromHtml(html) {
  const blocks = extractJsonLdBlocks(html);
  const typedNodes = [];

  for (const block of blocks) {
    const payload = JSON.parse(block);
    collectTypedNodes(payload, typedNodes, new WeakSet());
  }

  return typedNodes;
}

function normalizeAreaLabel(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    const name = getField(value, 'name');
    return typeof name === 'string' ? name.trim() : '';
  }
  return '';
}

function validateMoneyPages(pages, localCityBlocks) {
  const errors = [];

  for (const page of pages) {
    const htmlPath = toDistHtmlPath(page.pageSlug);
    if (!fs.existsSync(htmlPath)) {
      errors.push(`- ${page.pageSlug}: missing HTML at ${path.relative(ROOT, htmlPath).replace(/\\/g, '/')}`);
      continue;
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    const geoAnchorHtml = extractSectionByClass(html, 'geo-anchor-block');
    if (!geoAnchorHtml) {
      errors.push(`- ${page.pageSlug}: missing section.geo-anchor-block`);
    } else {
      const anchors = extractAnchorTags(geoAnchorHtml);
      const expectedAnchorCount = REQUIRED_CITIES.length;
      if (anchors.length !== expectedAnchorCount) {
        errors.push(
          `- ${page.pageSlug}: geo-anchor-block must contain exactly ${expectedAnchorCount} link(s), found ${anchors.length}`
        );
      }

      const hrefs = new Set(anchors.map((anchor) => anchor.href));
      const missingHrefs = [...REQUIRED_CITY_HREFS].filter((href) => !hrefs.has(href));
      const extraHrefs = [...hrefs].filter((href) => !REQUIRED_CITY_HREFS.has(href));
      if (missingHrefs.length > 0 || extraHrefs.length > 0) {
        errors.push(
          `- ${page.pageSlug}: geo-anchor-block hrefs must match city hubs. Missing [${missingHrefs.join(', ')}], extra [${extraHrefs.join(', ')}]`
        );
      }

      for (const city of REQUIRED_CITIES) {
        const anchor = anchors.find((item) => item.href === city.href);
        if (!anchor) continue;
        const normalizedText = anchor.text.toLowerCase();
        if (
          !normalizedText.includes(city.label.toLowerCase()) ||
          !normalizedText.includes(page.serviceName.toLowerCase())
        ) {
          errors.push(
            `- ${page.pageSlug}: anchor "${anchor.text}" must contain both city "${city.label}" and service "${page.serviceName}"`
          );
        }
      }
    }

    const cityBlocks = extractLocalCityBlocks(html);
    const geoMentionTexts = [];
    for (const block of cityBlocks) {
      const city = REQUIRED_CITIES.find((item) => item.id === block.cityId);
      const geoMention = extractGeoMentionLayer(block.html);
      if (!city) {
        errors.push(`- ${page.pageSlug}: unexpected data-local-city-block "${block.cityId}"`);
        continue;
      }
      if (!geoMention) {
        errors.push(`- ${page.pageSlug}: city block "${block.cityId}" is missing [data-geo-mention-layer]`);
        continue;
      }
      const normalizedGeoMention = geoMention.toLowerCase();
      if (
        !normalizedGeoMention.includes(city.label.toLowerCase()) ||
        !normalizedGeoMention.includes(page.serviceName.toLowerCase())
      ) {
        errors.push(
          `- ${page.pageSlug}: geo mention layer for "${block.cityId}" must mention "${city.label}" and "${page.serviceName}"`
        );
      }
      geoMentionTexts.push(geoMention);
    }

    if (new Set(geoMentionTexts.map((item) => item.toLowerCase())).size !== geoMentionTexts.length) {
      errors.push(`- ${page.pageSlug}: geo mention layers must be unique across city blocks`);
    }

    try {
      const typedNodes = parseTypedNodesFromHtml(html);
      const businessNode = typedNodes
        .filter((typed) => typed.typeNames.includes('KitchenCabinetStore'))
        .map((typed) => typed.node)
        .find((node) => Array.isArray(getField(node, 'areaServed')));

      if (!businessNode) {
        errors.push(`- ${page.pageSlug}: missing KitchenCabinetStore JSON-LD node`);
      } else {
        const areaServed = getField(businessNode, 'areaServed');
        const expectedAreaCount = REQUIRED_CITIES.length;
        if (!Array.isArray(areaServed) || areaServed.length < expectedAreaCount) {
          errors.push(
            `- ${page.pageSlug}: KitchenCabinetStore.areaServed must contain at least ${expectedAreaCount} city entry(ies)`
          );
        } else {
          const areaNames = new Set(areaServed.map((item) => normalizeAreaLabel(item)).filter(Boolean));
          const missingNames = [...REQUIRED_CITY_LABELS].filter((name) => !areaNames.has(name));
          if (missingNames.length > 0) {
            errors.push(`- ${page.pageSlug}: KitchenCabinetStore.areaServed is missing [${missingNames.join(', ')}]`);
          }
        }
      }
    } catch (error) {
      errors.push(`- ${page.pageSlug}: failed to parse JSON-LD (${error instanceof Error ? error.message : error})`);
    }

    const serviceBlocks = localCityBlocks[page.serviceId];
    if (!serviceBlocks || typeof serviceBlocks !== 'object') {
      errors.push(`- ${page.pageSlug}: missing local-city-blocks data for service "${page.serviceId}"`);
      continue;
    }

    for (const city of REQUIRED_CITIES) {
      const block = serviceBlocks[city.id];
      if (!block || !Array.isArray(block.cases)) {
        errors.push(`- ${page.pageSlug}: missing local city block data for "${city.id}"`);
        continue;
      }
      if (block.cases.length < city.minCases) {
        errors.push(
          `- ${page.pageSlug}: "${city.id}" must contain at least ${city.minCases} cases, found ${block.cases.length}`
        );
      }
      block.cases.forEach((item, index) => {
        if (!REQUIRED_CITY_IDS.has(item.city) || item.city !== city.id) {
          errors.push(`- ${page.pageSlug}: ${city.id}.cases[${index}] must contain explicit city="${city.id}"`);
        }
        if (!Array.isArray(item.photos) || item.photos.length < 2) {
          errors.push(`- ${page.pageSlug}: ${city.id}.cases[${index}] must contain photos.length >= 2`);
        }
      });
    }
  }

  return errors;
}

function validateCityHubs() {
  const errors = [];

  for (const city of REQUIRED_CITIES) {
    const htmlPath = toDistHtmlPath(city.href);
    if (!fs.existsSync(htmlPath)) {
      errors.push(`- ${city.href}: missing HTML at ${path.relative(ROOT, htmlPath).replace(/\\/g, '/')}`);
      continue;
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    const robots = parseRobotsMeta(html);
    const robotsSet = new Set(robots);
    if (robots.length !== 2 || !robotsSet.has('index') || !robotsSet.has('follow')) {
      errors.push(`- ${city.href}: robots must be exactly "index,follow", got "${robots.join(',') || '(missing)'}"`);
    }

    try {
      const typedNodes = parseTypedNodesFromHtml(html);
      const foundTypes = new Set(typedNodes.flatMap((typed) => typed.typeNames));
      const forbidden = [...FORBIDDEN_HUB_SCHEMA_TYPES].filter((typeName) => foundTypes.has(typeName));
      if (forbidden.length > 0) {
        errors.push(`- ${city.href}: city hub must not contain schema types [${forbidden.join(', ')}]`);
      }
    } catch (error) {
      errors.push(`- ${city.href}: failed to parse JSON-LD (${error instanceof Error ? error.message : error})`);
    }
  }

  return errors;
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    fail('Geo signals gate failed: dist directory is missing. Run `npm run build` first.');
  }
  if (!fs.existsSync(GENERATED_PAGES_PATH)) {
    fail('Geo signals gate failed: generated-pages.json is missing. Run `npm run build:data` first.');
  }
  if (!fs.existsSync(LOCAL_CITY_BLOCKS_PATH)) {
    fail('Geo signals gate failed: local-city-blocks.json is missing.');
  }

  const generatedPages = JSON.parse(fs.readFileSync(GENERATED_PAGES_PATH, 'utf8')).filter(
    (page) => String(page?.pageType || '') === 'service-money'
  );
  const localCityBlocks = JSON.parse(fs.readFileSync(LOCAL_CITY_BLOCKS_PATH, 'utf8'));

  const errors = [...validateMoneyPages(generatedPages, localCityBlocks), ...validateCityHubs()];
  if (errors.length > 0) {
    fail(`Geo signals gate failed.\n${errors.join('\n')}`);
  }

  console.log(
    `Geo signals gate passed: money pages=${generatedPages.length}, city hubs=${REQUIRED_CITIES.length}, anchors/schema/proof signals verified.`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
