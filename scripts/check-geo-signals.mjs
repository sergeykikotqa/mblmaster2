import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const LOCAL_CITY_BLOCKS_PATH = path.join(ROOT, 'data', 'local-city-blocks.json');
const CITY_HUBS = [];
const REQUIRED_SERVICE_CITIES = [{ id: 'irkutsk', label: 'Irkutsk', minCases: 1 }];
const REQUIRED_SERVICE_CITY_ALIASES = new Set(['irkutsk', 'иркутск', 'irkutsk city']);
const FORBIDDEN_SERVICE_CITY_ALIASES = new Set(['angarsk', 'ангарск', 'shelehov', 'шелехов']);
const FORBIDDEN_SERVICE_CITY_LABELS = {
  angarsk: 'Angarsk',
  ангарск: 'Angarsk',
  shelehov: 'Shelekhov',
  шелехов: 'Shelekhov',
};

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

function extractLocalCityBlocks(html) {
  const blocks = [];
  const regex = /<article\b[^>]*class=(['"])([^'"]*\bcity-block\b[^'"]*)\1[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    blocks.push({
      cityId: String(match[2] || '').trim().toLowerCase(),
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

function normalizeAreaLabel(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    const name = getField(value, 'name');
    return typeof name === 'string' ? name.trim() : '';
  }
  return '';
}

function normalizeAreaToken(value) {
  return normalizeAreaLabel(value).toLowerCase().trim();
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

function validateMoneyPages(pages, localCityBlocks) {
  const errors = [];

  for (const page of pages) {
    const htmlPath = toDistHtmlPath(page.pageSlug);
    if (!fs.existsSync(htmlPath)) {
      errors.push(`- ${page.pageSlug}: missing HTML at ${path.relative(ROOT, htmlPath).replace(/\\/g, '/')}`);
      continue;
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    const cityBlocks = extractLocalCityBlocks(html);
    if (cityBlocks.length === 0) {
      errors.push(`- ${page.pageSlug}: missing LocalCityBlock sections`);
      continue;
    }

    const irkutskBlocks = cityBlocks.filter((block) => {
      const mention = extractGeoMentionLayer(block.html) || '';
      return /irkutsk|иркутск/i.test(mention) || /irkutsk|иркутск/i.test(block.html);
    });
    if (irkutskBlocks.length === 0) {
      errors.push(`- ${page.pageSlug}: missing Irkutsk service geo block evidence`);
    }

    const geoMentionTexts = [];
    for (const block of cityBlocks) {
      const geoMention = extractGeoMentionLayer(block.html);
      if (!geoMention) {
        errors.push(`- ${page.pageSlug}: city block is missing [data-geo-mention-layer]`);
        continue;
      }
      const normalizedGeoMention = geoMention.toLowerCase();
      if (!normalizedGeoMention.includes('иркутск') && !normalizedGeoMention.includes('irkutsk')) {
        errors.push(`- ${page.pageSlug}: geo mention layer must mention the service city context`);
      }
      if (page.serviceName && !normalizedGeoMention.includes(page.serviceName.toLowerCase())) {
        errors.push(`- ${page.pageSlug}: geo mention layer must mention "${page.serviceName}"`);
      }
      geoMentionTexts.push(geoMention);
    }

    if (geoMentionTexts.length > 0 && new Set(geoMentionTexts.map((item) => item.toLowerCase())).size !== geoMentionTexts.length) {
      errors.push(`- ${page.pageSlug}: geo mention layers must be unique across city blocks`);
    }

    try {
      const typedNodes = parseTypedNodesFromHtml(html);
      const businessNode = typedNodes
        .filter((typed) => typed.typeNames.includes('LocalBusiness'))
        .map((typed) => typed.node)
        .find((node) => Array.isArray(getField(node, 'areaServed')));

      if (!businessNode) {
        errors.push(`- ${page.pageSlug}: missing LocalBusiness JSON-LD node`);
      } else {
        const areaServed = getField(businessNode, 'areaServed');
        if (!Array.isArray(areaServed) || areaServed.length === 0) {
          errors.push(`- ${page.pageSlug}: LocalBusiness.areaServed must include Irkutsk`);
        } else {
          const areaTokens = areaServed.map((item) => normalizeAreaToken(item));
          const hasIrkutsk = areaTokens.some((token) => REQUIRED_SERVICE_CITY_ALIASES.has(token));
          const hasForbidden = areaTokens.some((token) => FORBIDDEN_SERVICE_CITY_ALIASES.has(token));

          if (!hasIrkutsk) {
            errors.push(`- ${page.pageSlug}: LocalBusiness.areaServed must contain Irkutsk`);
          }
          if (hasForbidden) {
            errors.push(`- ${page.pageSlug}: LocalBusiness.areaServed must not include Angarsk or Shelkhov`);
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

    for (const city of REQUIRED_SERVICE_CITIES) {
      const block = serviceBlocks[city.id];
      if (!block || !Array.isArray(block.cases)) {
        errors.push(`- ${page.pageSlug}: missing local city block data for "${city.id}"`);
        continue;
      }
      if (block.city && block.city !== city.id) {
        errors.push(`- ${page.pageSlug}: local-city-blocks[${page.serviceId}].${city.id}.city must be "${city.label || city.id}"`);
      }
      if (block.cases.length < city.minCases) {
        errors.push(
          `- ${page.pageSlug}: "${city.label || city.id}" must contain at least ${city.minCases} cases, found ${block.cases.length}`
        );
      }
      block.cases.forEach((item, index) => {
        const caseCityValue = String(item.city || '').trim();
        const caseCityKey = caseCityValue.toLowerCase();

        if (caseCityValue !== city.id) {
          errors.push(`- ${page.pageSlug}: ${city.label || city.id}.cases[${index}] must contain explicit city="${city.id}"`);
        }
        if (FORBIDDEN_SERVICE_CITY_ALIASES.has(caseCityKey)) {
          const forbiddenLabel = FORBIDDEN_SERVICE_CITY_LABELS[caseCityKey] || caseCityValue;
          errors.push(`- ${page.pageSlug}: ${city.label || city.id}.cases[${index}] must not include ${forbiddenLabel} city data`);
        }
        if (!Array.isArray(item.photos) || item.photos.length < 2) {
          errors.push(`- ${page.pageSlug}: ${city.label || city.id}.cases[${index}] must contain photos.length >= 2`);
        }
      });
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

  const errors = validateMoneyPages(generatedPages, localCityBlocks);
  if (errors.length > 0) {
    fail(`Geo signals gate failed.\n${errors.join('\n')}`);
  }

  console.log(
    `Geo signals gate passed: money pages=${generatedPages.length}, city hubs=${CITY_HUBS.length}, Irkutsk service geo evidence verified.`
  );
}

export {
  extractGeoMentionLayer,
  extractLocalCityBlocks,
  normalizeAreaToken,
  validateMoneyPages,
};

const isDirectExecution = () => {
  const currentFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  const moduleFilePath = fileURLToPath(import.meta.url);
  return Boolean(currentFilePath) && path.resolve(currentFilePath) === path.resolve(moduleFilePath);
};

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
