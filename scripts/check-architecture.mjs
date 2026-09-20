import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PAGES_DIR = path.join(ROOT, 'src', 'pages');
const CONTENT_DIR = path.join(ROOT, 'src', 'content');

const ALLOWED_PAGE_FILES = new Set([
  'index.astro',
  '404.astro',
  '410.astro',
  'contacts.astro',
  'privacy.astro',
  'terms.astro',
  'thanks.astro',
  '[service].astro',
  'kuhni-3-metra.astro',
  'irkutsk.astro',
  'angarsk.astro',
  'shelekhov.astro',
  'o-kompanii/index.astro',
  'projects/index.astro',
  'projects/kuhnya-baykalskaya.astro',
  'projects/[slug].astro',
  'articles/index.astro',
  'articles/[slug].astro',
  'guides/index.astro',
  'guides/[slug].astro',
  'faq/index.astro',
  'faq/[slug].astro',
  'admin/index.astro',
  'admin/metrics.astro',
  'api/contact.ts',
  'api/health.ts',
  'api/leads.ts',
  'api/track.ts',
  'api/captcha/config.ts',
  'api/monitoring/health.ts',
  'api/monitoring/owner-metrics.ts',
  'health/live.ts',
  'health/ready.ts',
  'api/admin/health.ts',
  'api/admin/metrics-health.ts',
  'api/admin/metrics.ts',
  'api/admin/health/metrics.ts',
  'api/admin/health/pipeline.ts',
  'api/admin/health/system.ts',
  'api/admin/health/worker.ts',
  'api/workers/lead-delivery.ts',
  'api/workers/metrics-health-eval.ts',
  'api/workers/metrics-snapshot.ts',
]);

const ALLOWED_CONTENT_DIRS = new Set(['projects', 'articles', 'guides', 'faq', 'cities', 'services', 'keywords']);

const FORBIDDEN_DEP_NAMES = ['react', 'react-dom', 'next', 'vue', 'nuxt', 'angular', '@angular/core'];

function collectPageFiles(dir, rootDir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectPageFiles(fullPath, rootDir, results);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.astro') || entry.name.endsWith('.ts'))) {
      const rel = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      results.push(rel);
    }
  }
  return results;
}

function loadPackageJson() {
  const packagePath = path.join(ROOT, 'package.json');
  return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
}

function main() {
  const errors = [];

  const pageFiles = collectPageFiles(PAGES_DIR, PAGES_DIR);
  const unknownPages = pageFiles.filter((file) => !ALLOWED_PAGE_FILES.has(file));
  const missingPages = [...ALLOWED_PAGE_FILES].filter(
    (file) => !fs.existsSync(path.join(PAGES_DIR, file.replace(/\//g, path.sep)))
  );

  if (unknownPages.length > 0) {
    errors.push(`Found non-allowlisted routes:\n- ${unknownPages.join('\n- ')}`);
  }
  if (missingPages.length > 0) {
    errors.push(`Missing required route files:\n- ${missingPages.join('\n- ')}`);
  }

  if (fs.existsSync(CONTENT_DIR)) {
    const contentDirs = fs
      .readdirSync(CONTENT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const unknownContent = contentDirs.filter((dir) => !ALLOWED_CONTENT_DIRS.has(dir));
    if (unknownContent.length > 0) {
      errors.push(`Found non-allowlisted content dirs in src/content:\n- ${unknownContent.join('\n- ')}`);
    }
  }

  const pkg = loadPackageJson();
  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };
  const depNames = Object.keys(allDeps || {});

  const forbidden = depNames.filter((name) => FORBIDDEN_DEP_NAMES.includes(name) || name.startsWith('@angular/'));
  if (forbidden.length > 0) {
    errors.push(`Forbidden dependencies detected:\n- ${forbidden.join('\n- ')}`);
  }

  if (errors.length > 0) {
    console.error('Architecture guard failed:');
    errors.forEach((message) => console.error(message));
    process.exit(1);
  }

  console.log('Architecture guard passed.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
