import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const CANONICAL_ROUTES = new Set([
  '/',
  '/kuhni',
  '/shkafy',
  '/garderobnye',
  '/projects',
  '/articles',
  '/o-kompanii',
  '/contacts',
  '/guides',
  '/faq',
  '/irkutsk',
  '/privacy',
]);
const LEGACY_ALIASES = new Set([
  '/kitchens',
  '/wardrobes',
  '/kuhni-na-zakaz',
  '/shkafy-kupe',
  '/vstroennye-shkafy',
  '/shelehov',
]);

function normalizeRoutePath(routePath) {
  if (!routePath || routePath === '/') return '/';
  return routePath.replace(/\/+$/, '') || '/';
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

function extractLayoutSections(html) {
  return [
    ...(html.match(/<header\b[^>]*>[\s\S]*?<\/header>/gi) || []),
    ...(html.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi) || []),
  ];
}

function extractInternalHrefInfo(sectionHtml) {
  const regex = /href\s*=\s*(["'])(.*?)\1/gi;
  const hrefs = [];
  let match;

  while ((match = regex.exec(sectionHtml)) !== null) {
    const rawHref = String(match[2] || '').trim();
    if (
      !rawHref ||
      rawHref.startsWith('#') ||
      rawHref.startsWith('mailto:') ||
      rawHref.startsWith('tel:') ||
      rawHref.startsWith('javascript:') ||
      rawHref.startsWith('data:') ||
      /^https?:\/\//i.test(rawHref) ||
      rawHref.startsWith('//')
    ) {
      continue;
    }

    const pathPart = rawHref.split(/[?#]/)[0] || '/';
    hrefs.push({
      rawHref,
      pathPart,
      normalizedPath: normalizeRoutePath(pathPart),
    });
  }

  return hrefs;
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('Canonical nav links check failed: dist directory is missing. Run `npm run build` first.');
  process.exit(1);
}

const htmlFiles = walkHtmlFiles(DIST_DIR);
const errorSet = new Set();

for (const filePath of htmlFiles) {
  const html = fs.readFileSync(filePath, 'utf8');
  const pageRef = path.relative(ROOT, filePath).replace(/\\/g, '/');

  for (const section of extractLayoutSections(html)) {
    for (const hrefInfo of extractInternalHrefInfo(section)) {
      if (LEGACY_ALIASES.has(hrefInfo.normalizedPath)) {
        errorSet.add(
          `[${pageRef}] layout link "${hrefInfo.rawHref}" points to legacy alias "${hrefInfo.normalizedPath}"`
        );
        continue;
      }

      if (CANONICAL_ROUTES.has(hrefInfo.normalizedPath) && hrefInfo.pathPart !== hrefInfo.normalizedPath) {
        errorSet.add(
          `[${pageRef}] layout link "${hrefInfo.rawHref}" must use canonical route "${hrefInfo.normalizedPath}"`
        );
      }
    }
  }
}

const errors = [...errorSet];

if (errors.length > 0) {
  console.error(`Canonical nav links check failed (${errors.length}):\n${errors.join('\n')}`);
  process.exit(1);
}

console.log(`Canonical nav links check passed: ${htmlFiles.length} HTML files checked.`);
