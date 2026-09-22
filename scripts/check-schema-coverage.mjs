import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const SKIP_PATHS = new Set(['/404', '/decapcms', '/projects/kuhnya-baykalskaya']);
const MONEY_SERVICE_ROUTES = new Set(['/kuhni', '/shkafy', '/garderobnye']);
const SCHEMA_CONTEXT_SUBSTRING = 'schema.org';

function shouldSkipRoute(routePath) {
  if (SKIP_PATHS.has(routePath)) return true;
  if (routePath === '/admin' || routePath.startsWith('/admin/')) return true;
  if (routePath === '/api' || routePath.startsWith('/api/')) return true;
  return false;
}

function normalizeRoutePath(routePath) {
  if (!routePath || routePath === '/') return '/';
  return routePath.replace(/\/+$/, '') || '/';
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

function isNonEmptyObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
    bucket.push({
      node: record,
      typeNames,
    });
  }

  for (const child of Object.values(record)) {
    collectTypedNodes(child, bucket, visited);
  }
}

function hasSchemaContext(value) {
  if (!value || typeof value !== 'object') return false;
  const context = value['@context'];
  if (typeof context === 'string') {
    return context.toLowerCase().includes(SCHEMA_CONTEXT_SUBSTRING);
  }
  if (Array.isArray(context)) {
    return context.some((item) => typeof item === 'string' && item.toLowerCase().includes(SCHEMA_CONTEXT_SUBSTRING));
  }
  return false;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function getField(record, fieldName) {
  if (!record || typeof record !== 'object') return undefined;
  return record[fieldName];
}

function validateTypeNode(typeName, node) {
  const missing = [];

  if (typeName === 'LocalBusiness') {
    if (!isNonEmptyString(getField(node, 'name'))) missing.push('name');
    if (!isNonEmptyString(getField(node, 'url'))) missing.push('url');
    if (!isNonEmptyString(getField(node, 'telephone'))) missing.push('telephone');
    if (!isNonEmptyArray(getField(node, 'areaServed'))) missing.push('areaServed');
    const address = getField(node, 'address');
    if (!isNonEmptyObject(address)) {
      missing.push('address');
    } else {
      if (!isNonEmptyString(getField(address, 'addressLocality'))) missing.push('address.addressLocality');
      if (!isNonEmptyString(getField(address, 'streetAddress'))) missing.push('address.streetAddress');
    }
    return missing;
  }

  if (typeName === 'FAQPage') {
    const entities = getField(node, 'mainEntity');
    if (!isNonEmptyArray(entities)) {
      missing.push('mainEntity');
    } else {
      const hasQuestionShape = entities.some(
        (item) =>
          item &&
          typeof item === 'object' &&
          normalizeTypeNames(item['@type']).includes('Question') &&
          isNonEmptyString(getField(item, 'name'))
      );
      if (!hasQuestionShape) missing.push('mainEntity[].Question');
    }
    return missing;
  }

  if (typeName === 'BreadcrumbList') {
    const items = getField(node, 'itemListElement');
    if (!isNonEmptyArray(items)) {
      missing.push('itemListElement');
    } else {
      const hasListItemShape = items.some(
        (item) =>
          item &&
          typeof item === 'object' &&
          normalizeTypeNames(item['@type']).includes('ListItem') &&
          isNonEmptyString(getField(item, 'name')) &&
          isNonEmptyString(getField(item, 'item'))
      );
      if (!hasListItemShape) missing.push('itemListElement[].ListItem');
    }
    return missing;
  }

  return missing;
}

function expectedTypesForRoute(routePath) {
  const expected = ['LocalBusiness', 'BreadcrumbList'];
  if (MONEY_SERVICE_ROUTES.has(routePath)) {
    expected.push('FAQPage');
  }
  return expected;
}

function validateMoneyPageBusinessNodes(routePath, typedNodes) {
  const businessNodes = typedNodes
    .filter((typed) => typed.typeNames.includes('LocalBusiness'))
    .map((typed) => typed.node);
  if (businessNodes.length === 0) {
    return [`[${routePath}] money page must expose a LocalBusiness JSON-LD node`];
  }

  const hasCatalogNode = businessNodes.some((node) => {
    const offerCatalog = getField(node, 'hasOfferCatalog');
    return (
      isNonEmptyObject(offerCatalog) &&
      Array.isArray(getField(offerCatalog, 'itemListElement')) &&
      getField(offerCatalog, 'itemListElement').length === 3
    );
  });

  if (!hasCatalogNode) {
    return [
      `[${routePath}] LocalBusiness JSON-LD on money pages must expose hasOfferCatalog.itemListElement with 3 services`,
    ];
  }

  return [];
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('Schema coverage gate failed: dist directory is missing. Run `npm run build` first.');
  process.exit(1);
}

const errors = [];
const htmlFiles = walkHtmlFiles(DIST_DIR);

for (const filePath of htmlFiles) {
  const routePath = normalizeRoutePath(toRoutePath(filePath));
  if (shouldSkipRoute(routePath)) continue;

  const html = fs.readFileSync(filePath, 'utf8');
  const blocks = extractJsonLdBlocks(html);
  const pageRef = path.relative(ROOT, filePath).replace(/\\/g, '/');
  if (blocks.length === 0) {
    errors.push(`[${pageRef}] missing JSON-LD scripts`);
    continue;
  }

  const parsedBlocks = [];
  for (const block of blocks) {
    try {
      parsedBlocks.push(JSON.parse(block));
    } catch {
      errors.push(`[${pageRef}] invalid JSON-LD payload`);
    }
  }

  if (parsedBlocks.length === 0) {
    continue;
  }

  const hasContext = parsedBlocks.some((item) => hasSchemaContext(item));
  if (!hasContext) {
    errors.push(`[${pageRef}] JSON-LD must include @context with schema.org`);
  }

  const typedNodes = [];
  for (const payload of parsedBlocks) {
    collectTypedNodes(payload, typedNodes, new WeakSet());
  }

  const foundTypes = new Set();
  for (const typed of typedNodes) {
    for (const typeName of typed.typeNames) {
      foundTypes.add(typeName);
    }
  }

  const expectedTypes = expectedTypesForRoute(routePath);
  for (const typeName of expectedTypes) {
    if (!foundTypes.has(typeName)) {
      errors.push(`[${pageRef}] missing JSON-LD type: ${typeName}`);
      continue;
    }

    const nodesByType = typedNodes.filter((typed) => typed.typeNames.includes(typeName)).map((typed) => typed.node);
    if (nodesByType.length === 0) {
      errors.push(`[${pageRef}] missing JSON-LD node for type: ${typeName}`);
      continue;
    }

    const validationResults = nodesByType.map((node) => validateTypeNode(typeName, node));
    const passing = validationResults.some((missing) => missing.length === 0);
    if (!passing) {
      const best = validationResults.sort((a, b) => a.length - b.length)[0] || [];
      errors.push(
        `[${pageRef}] JSON-LD ${typeName} missing required fields: ${best.join(', ') || '(unknown requirements)'}`
      );
    }
  }

  if (MONEY_SERVICE_ROUTES.has(routePath)) {
    errors.push(...validateMoneyPageBusinessNodes(routePath, typedNodes));
  }
}

if (errors.length > 0) {
  console.error(`Schema coverage gate failed (${errors.length}):\n${errors.join('\n')}`);
  process.exit(1);
}

console.log(`Schema coverage gate passed: ${htmlFiles.length} HTML files checked.`);
