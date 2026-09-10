import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const rootRedirectsPath = path.join(rootDir, '_redirects');
const distRedirectsPath = path.join(distDir, '_redirects');
const sitemapArtifactsDir = path.resolve(process.env.BUILD_DATA_SITEMAP_DIR || path.join(rootDir, '.tmp', 'build-data', 'sitemaps'));
const SITEMAP_PATTERN = /^sitemap(?:-(?:index|\d+))?\.xml$/i;

if (!fs.existsSync(distDir)) {
  process.exit(0);
}

function copyGeneratedSitemaps() {
  if (!fs.existsSync(sitemapArtifactsDir)) {
    throw new Error(`[prepare-netlify-routing] missing sitemap artifacts directory: ${sitemapArtifactsDir}`);
  }

  const sitemapFiles = fs
    .readdirSync(sitemapArtifactsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SITEMAP_PATTERN.test(entry.name))
    .map((entry) => entry.name);

  if (sitemapFiles.length === 0) {
    throw new Error(`[prepare-netlify-routing] no generated sitemap files found in ${sitemapArtifactsDir}`);
  }

  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (entry.isFile() && SITEMAP_PATTERN.test(entry.name)) {
      fs.rmSync(path.join(distDir, entry.name), { force: true });
    }
  }

  for (const fileName of sitemapFiles) {
    fs.copyFileSync(path.join(sitemapArtifactsDir, fileName), path.join(distDir, fileName));
  }

  console.log(`[prepare-netlify-routing] copied ${sitemapFiles.length} sitemap file(s) to dist/`);
}

const baseRedirects = fs.existsSync(rootRedirectsPath) ? fs.readFileSync(rootRedirectsPath, 'utf8').trim() : '';

const sections = [];
sections.push('# AUTO-GENERATED: base redirect matrix for Netlify deploys');
if (baseRedirects) {
  sections.push(baseRedirects);
}

copyGeneratedSitemaps();
fs.writeFileSync(distRedirectsPath, `${sections.join('\n')}\n`, 'utf8');
console.log('[prepare-netlify-routing] copied base redirects to dist/_redirects');
