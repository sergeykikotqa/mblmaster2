import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const STRICT_MODE = String(process.env.SEO_JARGON_STRICT || '').toLowerCase() === 'true';
const TARGET_ROUTES = new Set([
  '/',
  '/contacts',
  '/o-kompanii',
  '/kuhni',
  '/shkafy',
  '/garderobnye',
  '/irkutsk',
]);
const FORBIDDEN_PATTERNS = [
  /\b(?:для\s+)?SEO\b/gi,
  /SEO-?текст/gi,
  /под\s+запрос(?:ам|ы|ов)?/gi,
  /по\s+запрос(?:ам|ы|ов)?/gi,
  /поисков(?:ого|ый)\s+интента?/gi,
  /поискового\s+продвижения/gi,
  /коммерческ(?:ий|ое)\s+SEO/gi,
  /SEO-сценар(?:ий|ия)/gi,
  /для\s+SEO\s+и\s+реального\s+поиска/gi,
  /в\s+SEO-тексте/gi,
  /быстро\s+работает\s+в\s+коммерческом\s+SEO/gi,
];

export function normalizeRoutePath(routePath) {
  if (!routePath || routePath === '/') return '/';
  return routePath.replace(/\/+$/, '') || '/';
}

export function toRoutePath(filePath) {
  const relative = path.relative(DIST_DIR, filePath).replace(/\\/g, '/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'/index.html'.length)}`;
  if (relative.endsWith('.html')) return `/${relative.slice(0, -'.html'.length)}`;
  return `/${relative}`;
}

export function walkHtmlFiles(dirPath) {
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

export function extractMainPublishedText(html) {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');

  const mainMatch = withoutScripts.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const mainHtml = mainMatch ? mainMatch[1] : withoutScripts;

  return mainHtml
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, ' ')
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findForbiddenSeoJargon(visibleText) {
  const matches = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    const found = visibleText.match(pattern);
    if (found?.length) {
      matches.push({ pattern: pattern.toString(), count: found.length });
    }
  }
  return matches;
}

export function scanSeoJargonHtml(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const visibleText = extractMainPublishedText(html);
  const route = normalizeRoutePath(toRoutePath(filePath));
  const matches = findForbiddenSeoJargon(visibleText);
  return { route, filePath, matches };
}

export function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error('SEO jargon check failed: dist directory is missing. Run `npm run build` first.');
    process.exit(1);
  }

  const warnings = [];
  const htmlFiles = walkHtmlFiles(DIST_DIR);

  for (const filePath of htmlFiles) {
    const routePath = normalizeRoutePath(toRoutePath(filePath));
    const isProjectPage = routePath.startsWith('/projects/');
    if (!TARGET_ROUTES.has(routePath) && !isProjectPage) continue;

    const { matches } = scanSeoJargonHtml(filePath);
    const pageRef = path.relative(ROOT, filePath).replace(/\\/g, '/');

    for (const match of matches) {
      warnings.push(`[${pageRef}] forbidden SEO jargon matched pattern "${match.pattern}" (${match.count}x)`);
    }
  }

  if (warnings.length > 0) {
    const header = `SEO jargon check found ${warnings.length} issue(s).`;
    if (STRICT_MODE) {
      console.error(`${header}\n${warnings.join('\n')}`);
      process.exit(1);
    }

    console.warn(`${header}\n${warnings.join('\n')}`);
  } else {
    const scannedRoutes = new Set();
    for (const filePath of htmlFiles) {
      const routePath = normalizeRoutePath(toRoutePath(filePath));
      if (TARGET_ROUTES.has(routePath) || routePath.startsWith('/projects/')) {
        scannedRoutes.add(routePath);
      }
    }
    console.log(`SEO jargon check passed: ${scannedRoutes.size} route groups scanned.`);
  }
}

const isDirectExecution = () => {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentArgvPath = process.argv[1] ? fileURLToPath(pathToFileURL(process.argv[1]).href) : '';
  return currentArgvPath && currentFilePath === currentArgvPath;
};

if (isDirectExecution()) {
  main();
}
