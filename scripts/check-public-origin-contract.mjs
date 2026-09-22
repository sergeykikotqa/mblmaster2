import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

function normalizeOrigin(value) {
  const parsed = new URL(String(value || '').trim());
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('PUBLIC_SITE_URL must be a bare origin');
  }
  return parsed.origin;
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

export function validateOriginSignals({ expectedOrigin, htmlDocuments, sitemapXml, robots, redirects, originConfig, nginx }) {
  const issues = [];
  const expectUrlOrigin = (value, label) => {
    if (originOf(value) !== expectedOrigin) issues.push(`${label} uses ${value || '(missing)'}, expected ${expectedOrigin}`);
  };

  for (const [file, html] of htmlDocuments) {
    const canonical = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] || '';
    const ogUrl = html.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1] || '';
    const robots = html.match(/<meta\b[^>]*name=["']robots["'][^>]*content=["']([^"']+)["']/i)?.[1] || '';
    const isNoindex = /(?:^|[\s,])noindex(?:[\s,]|$)/i.test(robots);

    if (isNoindex) {
      if (canonical) expectUrlOrigin(canonical, `${file} canonical`);
      if (ogUrl) expectUrlOrigin(ogUrl, `${file} og:url`);
      continue;
    }

    expectUrlOrigin(canonical, `${file} canonical`);
    expectUrlOrigin(ogUrl, `${file} og:url`);
  }

  for (const match of sitemapXml.matchAll(/<(?:loc|sitemap)>\s*([^<]+)\s*<\/(?:loc|sitemap)>/gi)) {
    expectUrlOrigin(match[1], 'sitemap URL');
  }
  const sitemapDirective = robots.match(/^Sitemap:\s*(\S+)\s*$/im)?.[1] || '';
  if (sitemapDirective !== `${expectedOrigin}/sitemap-index.xml`) {
    issues.push(`robots Sitemap uses ${sitemapDirective || '(missing)'}, expected ${expectedOrigin}/sitemap-index.xml`);
  }

  for (const rawLine of redirects.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [source, target] = line.split(/\s+/);
    if (/^https?:\/\//i.test(source) && /^https?:\/\//i.test(target)) {
      expectUrlOrigin(target.replace('/:splat', '/'), `redirect target for ${source}`);
    }
  }

  if (!originConfig.includes(`default "${expectedOrigin}";`)) {
    issues.push('generated Nginx public origin does not match PUBLIC_SITE_URL');
  }
  const expectedHost = new URL(expectedOrigin).hostname;
  if (!originConfig.includes(`"${expectedHost}" 1;`)) {
    issues.push(`generated Nginx host allowlist is missing ${expectedHost}`);
  }
  if (!nginx.includes('return 301 $mbl_public_origin$request_uri;')) {
    issues.push('Nginx canonical redirect is not wired to the generated public origin');
  }
  if (!nginx.includes('if ($mbl_public_host_allowed = 0)')) {
    issues.push('Nginx does not reject unknown public Host values');
  }
  if (/return\s+30[1278]\s+https?:\/\//i.test(nginx)) {
    issues.push('Nginx contains a hard-coded absolute redirect origin');
  }

  return issues;
}

function walkHtml(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkHtml(target));
    else if (entry.isFile() && entry.name.endsWith('.html')) result.push(target);
  }
  return result;
}

function read(root, file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

export function collectPublicOriginIssues(root = ROOT, publicSiteUrl = process.env.PUBLIC_SITE_URL || 'https://example.com') {
  const expectedOrigin = normalizeOrigin(publicSiteUrl);
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist)) return ['dist is missing; run the production build first'];
  const htmlDocuments = walkHtml(dist).map((file) => [path.relative(root, file).replaceAll('\\', '/'), fs.readFileSync(file, 'utf8')]);
  const sitemapXml = fs
    .readdirSync(dist)
    .filter((name) => /^sitemap.*\.xml$/i.test(name))
    .map((name) => fs.readFileSync(path.join(dist, name), 'utf8'))
    .join('\n');
  return validateOriginSignals({
    expectedOrigin,
    htmlDocuments,
    sitemapXml,
    robots: read(root, 'dist/robots.txt'),
    redirects: read(root, '_redirects'),
    originConfig: read(root, 'nginx/generated/public-origin.conf'),
    nginx: read(root, 'nginx/nginx.conf'),
  });
}

function main() {
  const issues = collectPublicOriginIssues();
  if (issues.length) {
    console.error(`Public origin contract failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[public-origin] PASS: all build and edge signals use ${normalizeOrigin(process.env.PUBLIC_SITE_URL || 'https://example.com')}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
