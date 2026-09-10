import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');

const MAX_JS_TOTAL = 30 * 1024;
const MAX_JS_PER_PAGE = 15 * 1024;
const MAX_CSS_TOTAL = 120 * 1024;

const SCRIPT_SRC_REGEX = /<script\b[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;

function isAdminOnlyAsset(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/admin/') || /\/scripts\/admin-[^/]+\.js$/.test(normalized);
}

function isAdminHtml(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase().includes('/admin/');
}

function collectFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, predicate, results);
      continue;
    }
    if (entry.isFile() && predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function gzipSizeForFile(filePath) {
  const data = fs.readFileSync(filePath);
  return zlib.gzipSync(data).length;
}

function resolveAssetPath(assetPath, htmlDir) {
  if (!assetPath) return null;
  if (/^(https?:)?\/\//i.test(assetPath)) return null;
  if (assetPath.startsWith('data:')) return null;
  if (assetPath.startsWith('/')) {
    return path.join(DIST_DIR, assetPath.replace(/^\/+/, ''));
  }
  return path.resolve(htmlDir, assetPath);
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('Performance budget check failed: dist folder not found. Run npm run build first.');
  }

  const assetSizeCache = new Map();
  const getSize = (filePath) => {
    if (assetSizeCache.has(filePath)) return assetSizeCache.get(filePath);
    const size = gzipSizeForFile(filePath);
    assetSizeCache.set(filePath, size);
    return size;
  };

  const jsFiles = collectFiles(
    DIST_DIR,
    (filePath) => filePath.endsWith('.js') && !filePath.endsWith('.map') && !isAdminOnlyAsset(filePath)
  );
  const cssFiles = collectFiles(DIST_DIR, (filePath) => filePath.endsWith('.css') && !filePath.endsWith('.map'));

  const totalJs = jsFiles.reduce((sum, filePath) => sum + getSize(filePath), 0);
  const totalCss = cssFiles.reduce((sum, filePath) => sum + getSize(filePath), 0);

  const htmlFiles = collectFiles(DIST_DIR, (filePath) => filePath.endsWith('.html') && !isAdminHtml(filePath));
  if (htmlFiles.length === 0) {
    throw new Error('Performance budget check failed: no HTML files found in dist.');
  }

  const perPageViolations = [];

  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const htmlDir = path.dirname(htmlFile);
    const pageScripts = new Set();
    let match;

    SCRIPT_SRC_REGEX.lastIndex = 0;

    while ((match = SCRIPT_SRC_REGEX.exec(html)) !== null) {
      const assetPath = resolveAssetPath(match[1], htmlDir);
      if (!assetPath || !fs.existsSync(assetPath) || isAdminOnlyAsset(assetPath)) continue;
      pageScripts.add(assetPath);
    }

    let pageJsSize = 0;
    for (const assetPath of pageScripts) {
      pageJsSize += getSize(assetPath);
    }

    if (pageJsSize > MAX_JS_PER_PAGE) {
      perPageViolations.push({
        route: path
          .relative(DIST_DIR, htmlFile)
          .replace(/index\.html$/, '')
          .replace(/\\/g, '/'),
        size: pageJsSize,
      });
    }
  }

  const errors = [];
  if (totalJs > MAX_JS_TOTAL) {
    errors.push(`Total JS exceeds budget: ${formatBytes(totalJs)} (limit ${formatBytes(MAX_JS_TOTAL)})`);
  }
  if (totalCss > MAX_CSS_TOTAL) {
    errors.push(`Total CSS exceeds budget: ${formatBytes(totalCss)} (limit ${formatBytes(MAX_CSS_TOTAL)})`);
  }
  if (perPageViolations.length > 0) {
    errors.push(
      ...perPageViolations.map(
        (item) => `Per-page JS budget exceeded for "${item.route || '/'}": ${formatBytes(item.size)}`
      )
    );
  }

  if (errors.length > 0) {
    console.error('Performance budget check failed:');
    errors.forEach((message) => console.error(`- ${message}`));
    process.exit(1);
  }

  console.log('Performance budget check passed.');
  console.log(`Total JS (gzip): ${formatBytes(totalJs)} / ${formatBytes(MAX_JS_TOTAL)}`);
  console.log(`Total CSS (gzip): ${formatBytes(totalCss)} / ${formatBytes(MAX_CSS_TOTAL)}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
