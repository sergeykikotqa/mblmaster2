import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');

// Keep the initial HTML payload strict. The runtime limit includes local scripts
// loaded later by those entrypoints, while the repository limit prevents route
// splitting from hiding unchecked growth in the complete client-side codebase.
const MAX_JS_INITIAL_PER_PAGE = 15 * 1024;
const MAX_JS_RUNTIME_PER_PAGE = 30 * 1024;
const MAX_JS_REPOSITORY = 36 * 1024;
const MAX_CSS_TOTAL = 120 * 1024;
const TOP_ASSET_COUNT = 5;

const SCRIPT_SRC_REGEX = /<script\b[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;
const MODULE_PRELOAD_REGEX = /<link\b(?=[^>]*\brel=["']modulepreload["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/gi;
const LOCAL_JS_REFERENCE_REGEX = /(["'`])((?:\/|\.\.?\/)[^"'`?#]+\.js(?:[?#][^"'`]*)?)\1/g;

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function isAdminOnlyAsset(filePath) {
  const normalized = normalizePath(filePath).toLowerCase();
  return normalized.includes('/admin/') || /\/scripts\/admin-[^/]+\.js$/.test(normalized);
}

function isAdminHtml(filePath) {
  return normalizePath(filePath).toLowerCase().includes('/admin/');
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
  return zlib.gzipSync(fs.readFileSync(filePath)).length;
}

function stripQueryAndHash(value) {
  return String(value || '').replace(/[?#].*$/, '');
}

function resolveAssetPath(assetPath, sourceDir, distDir) {
  if (!assetPath) return null;
  if (/^(https?:)?\/\//i.test(assetPath) || assetPath.startsWith('data:')) return null;
  const cleanPath = stripQueryAndHash(assetPath);
  if (cleanPath.startsWith('/')) {
    return path.resolve(distDir, cleanPath.replace(/^\/+/, ''));
  }
  return path.resolve(sourceDir, cleanPath);
}

function routeForHtml(htmlFile, distDir) {
  const relative = normalizePath(path.relative(distDir, htmlFile));
  if (relative === 'index.html') return '/';
  return `/${relative.replace(/\/index\.html$/, '/').replace(/\.html$/, '')}`;
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function collectHtmlScriptPaths(html, htmlDir, distDir) {
  const paths = new Set();
  for (const regex of [SCRIPT_SRC_REGEX, MODULE_PRELOAD_REGEX]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const assetPath = resolveAssetPath(match[1], htmlDir, distDir);
      if (assetPath) paths.add(assetPath);
    }
  }
  return paths;
}

function collectLocalJsDependencies(filePath, jsFileSet, distDir) {
  const source = fs.readFileSync(filePath, 'utf8');
  const dependencies = new Set();
  LOCAL_JS_REFERENCE_REGEX.lastIndex = 0;
  let match;

  while ((match = LOCAL_JS_REFERENCE_REGEX.exec(source)) !== null) {
    const dependency = resolveAssetPath(match[2], path.dirname(filePath), distDir);
    if (dependency && jsFileSet.has(dependency)) dependencies.add(dependency);
  }

  return dependencies;
}

function expandDependencies(initialAssets, dependencyGraph) {
  const expanded = new Set(initialAssets);
  const pending = [...expanded];

  while (pending.length > 0) {
    const asset = pending.pop();
    for (const dependency of dependencyGraph.get(asset) || []) {
      if (expanded.has(dependency)) continue;
      expanded.add(dependency);
      pending.push(dependency);
    }
  }

  return expanded;
}

function sumAssetSizes(assets, assetSizeCache) {
  let total = 0;
  for (const asset of assets) total += assetSizeCache.get(asset) || 0;
  return total;
}

export function analyzePerformanceBudgets({ distDir = DIST_DIR } = {}) {
  if (!fs.existsSync(distDir)) {
    throw new Error('Performance budget check failed: dist folder not found. Run npm run build first.');
  }

  const jsFiles = collectFiles(
    distDir,
    (filePath) => filePath.endsWith('.js') && !filePath.endsWith('.map') && !isAdminOnlyAsset(filePath)
  ).map((filePath) => path.resolve(filePath));
  const cssFiles = collectFiles(distDir, (filePath) => filePath.endsWith('.css') && !filePath.endsWith('.map'));
  const htmlFiles = collectFiles(distDir, (filePath) => filePath.endsWith('.html') && !isAdminHtml(filePath));

  if (htmlFiles.length === 0) {
    throw new Error('Performance budget check failed: no HTML files found in dist.');
  }

  const assetSizeCache = new Map(jsFiles.map((filePath) => [filePath, gzipSizeForFile(filePath)]));
  const jsFileSet = new Set(jsFiles);
  const dependencyGraph = new Map(
    jsFiles.map((filePath) => [filePath, collectLocalJsDependencies(filePath, jsFileSet, distDir)])
  );
  const referencedAssets = new Set();
  const pages = [];

  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const directAssets = new Set(
      [...collectHtmlScriptPaths(html, path.dirname(htmlFile), distDir)].filter(
        (assetPath) => jsFileSet.has(assetPath) && !isAdminOnlyAsset(assetPath)
      )
    );
    const runtimeAssets = expandDependencies(directAssets, dependencyGraph);
    runtimeAssets.forEach((assetPath) => referencedAssets.add(assetPath));

    pages.push({
      route: routeForHtml(htmlFile, distDir),
      initialSize: sumAssetSizes(directAssets, assetSizeCache),
      runtimeSize: sumAssetSizes(runtimeAssets, assetSizeCache),
      initialAssets: [...directAssets],
      runtimeAssets: [...runtimeAssets],
    });
  }

  const assets = jsFiles
    .map((filePath) => ({
      path: filePath,
      relativePath: normalizePath(path.relative(distDir, filePath)),
      rawSize: fs.statSync(filePath).size,
      gzipSize: assetSizeCache.get(filePath) || 0,
      referenced: referencedAssets.has(filePath),
    }))
    .sort((left, right) => right.gzipSize - left.gzipSize || left.relativePath.localeCompare(right.relativePath));

  return {
    totalJs: sumAssetSizes(jsFiles, assetSizeCache),
    totalCss: cssFiles.reduce((sum, filePath) => sum + gzipSizeForFile(filePath), 0),
    assets,
    pages,
    maxInitialPage: [...pages].sort(
      (left, right) => right.initialSize - left.initialSize || left.route.localeCompare(right.route)
    )[0],
    maxRuntimePage: [...pages].sort(
      (left, right) => right.runtimeSize - left.runtimeSize || left.route.localeCompare(right.route)
    )[0],
  };
}

export const PERFORMANCE_BUDGET_LIMITS = Object.freeze({
  maxJsInitialPerPage: MAX_JS_INITIAL_PER_PAGE,
  maxJsRuntimePerPage: MAX_JS_RUNTIME_PER_PAGE,
  maxJsRepository: MAX_JS_REPOSITORY,
  maxCssTotal: MAX_CSS_TOTAL,
});

export function evaluatePerformanceBudgets(analysis, limits = PERFORMANCE_BUDGET_LIMITS) {
  const errors = [];

  if (analysis.totalJs > limits.maxJsRepository) {
    errors.push(
      `Repository JS exceeds budget: ${formatBytes(analysis.totalJs)} (limit ${formatBytes(limits.maxJsRepository)})`
    );
  }
  if (analysis.totalCss > limits.maxCssTotal) {
    errors.push(
      `Total CSS exceeds budget: ${formatBytes(analysis.totalCss)} (limit ${formatBytes(limits.maxCssTotal)})`
    );
  }

  for (const page of analysis.pages) {
    if (page.initialSize > limits.maxJsInitialPerPage) {
      errors.push(
        `Initial per-page JS budget exceeded for "${page.route}": ${formatBytes(page.initialSize)} ` +
          `(limit ${formatBytes(limits.maxJsInitialPerPage)})`
      );
    }
    if (page.runtimeSize > limits.maxJsRuntimePerPage) {
      errors.push(
        `Runtime per-page JS budget exceeded for "${page.route}": ${formatBytes(page.runtimeSize)} ` +
          `(limit ${formatBytes(limits.maxJsRuntimePerPage)})`
      );
    }
  }

  return errors;
}

function printDiagnostics(analysis, writer = console.log) {
  writer('Largest public JS assets (gzip):');
  analysis.assets.slice(0, TOP_ASSET_COUNT).forEach((asset) => {
    writer(`- ${asset.relativePath}: ${formatBytes(asset.gzipSize)}`);
  });
  writer(
    `Max initial per-page JS: ${analysis.maxInitialPage.route} ${formatBytes(analysis.maxInitialPage.initialSize)} ` +
      `/ ${formatBytes(MAX_JS_INITIAL_PER_PAGE)}`
  );
  writer(
    `Max runtime per-page JS: ${analysis.maxRuntimePage.route} ${formatBytes(analysis.maxRuntimePage.runtimeSize)} ` +
      `/ ${formatBytes(MAX_JS_RUNTIME_PER_PAGE)}`
  );
}

function main() {
  const analysis = analyzePerformanceBudgets();
  const errors = evaluatePerformanceBudgets(analysis);

  if (errors.length > 0) {
    console.error('Performance budget check failed:');
    errors.forEach((message) => console.error(`- ${message}`));
    printDiagnostics(analysis, console.error);
    process.exitCode = 1;
    return;
  }

  console.log('Performance budget check passed.');
  console.log(`Repository JS (gzip): ${formatBytes(analysis.totalJs)} / ${formatBytes(MAX_JS_REPOSITORY)}`);
  console.log(`Total CSS (gzip): ${formatBytes(analysis.totalCss)} / ${formatBytes(MAX_CSS_TOTAL)}`);
  printDiagnostics(analysis);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
