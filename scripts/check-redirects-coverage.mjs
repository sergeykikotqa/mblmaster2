import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REDIRECTS_PATH = path.join(ROOT, '_redirects');
const PROJECTS_DIR = path.join(ROOT, 'src', 'content', 'projects');
const VALID_STATUSES = new Set([301, 302, 308]);

const LEGACY_PROJECT_REDIRECTS = [
  { from: '/projects/kuhnya-irkutsk-baykalskaya', to: '/projects/mebel-pod-lestnitsey' },
  { from: '/projects/kuhnya-irkutsk-grafitovaya-dalnevostochnaya', to: '/projects/kuhnya-grafitovaya' },
  { from: '/projects/kuhnya-irkutsk-uglovaya-piskunova', to: '/projects/kuhnya-piskunova' },
  { from: '/projects/kuhnya-irkutsk-belaya-uglovaya-trilissera', to: '/projects/kuhnya-trilissera' },
  { from: '/projects/kuhnya-irkutsk-uglovaya-krasnokazachya', to: '/projects/kuhnya-krasnokazachya' },
  { from: '/projects/kuhnya-irkutsk-belaya-uglovaya-baykalskiy-trakt', to: '/projects/kuhnya-baykalskiy-trakt' },
  { from: '/projects/kuhnya-irkutsk-biryuzovaya-uglovaya-bogdana', to: '/projects/kuhnya-bogdana' },
  { from: '/projects/kuhnya-irkutsk-belaya-s-barom-dzerzhinskogo', to: '/projects/kuhnya-dzerzhinskogo' },
  { from: '/projects/shkaf-irkutsk-rabochaya-zona-deputatskaya', to: '/projects/shkaf-deputatskaya' },
  { from: '/projects/kuhnya-irkutsk-verkhnyaya-naberezhnaya', to: '/projects/kuhnya-verkhnyaya-naberezhnaya' },
];

function fail(message) {
  throw new Error(message);
}

function normalizePathname(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/')) return '';
  const normalized = `/${raw.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

function extractFrontmatterSlug(fileContent) {
  const match = fileContent.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return '';
  const body = match[1] || '';
  const slugMatch = body.match(/^\s*slug\s*:\s*(.+)\s*$/m);
  if (!slugMatch) return '';
  return normalizeSlug(slugMatch[1] || '');
}

function collectProjectSlugs() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    fail('Projects directory is missing.');
  }

  const slugs = new Set();
  const files = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|mdx)$/i.test(entry.name))
    .map((entry) => path.join(PROJECTS_DIR, entry.name));

  for (const absolutePath of files) {
    const content = fs.readFileSync(absolutePath, 'utf8');
    const frontmatterSlug = extractFrontmatterSlug(content);
    const fallback = path.basename(absolutePath).replace(/\.(md|mdx)$/i, '');
    const slug = normalizeSlug(frontmatterSlug || fallback);
    if (slug) slugs.add(slug);
  }

  return slugs;
}

function parseRedirects(content) {
  const redirects = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutComment = line.split('#')[0]?.trim() || '';
    if (!withoutComment) continue;

    const parts = withoutComment.split(/\s+/);
    if (parts.length < 3) continue;

    const source = normalizePathname(parts[0]);
    const target = normalizePathname(parts[1]);
    const statusRaw = parts[2]?.replace(/!$/, '') || '';
    const status = Number(statusRaw);

    if (!source || !target) continue;
    if (source.includes('*') || source.includes(':')) continue;
    if (!Number.isFinite(status) || !VALID_STATUSES.has(status)) continue;

    redirects.set(source, { target, status });
  }
  return redirects;
}

function toSlug(pathname) {
  const normalized = normalizePathname(pathname);
  if (!normalized) return '';
  return normalized.split('/').filter(Boolean).pop() || '';
}

function main() {
  if (!fs.existsSync(REDIRECTS_PATH)) {
    fail('Missing root _redirects file.');
  }

  const redirects = parseRedirects(fs.readFileSync(REDIRECTS_PATH, 'utf8'));
  const projectSlugs = collectProjectSlugs();

  if (projectSlugs.size === 0) {
    fail('No project slugs found.');
  }

  const missingRedirects = [];
  const mismatchedTargets = [];
  const missingTargets = [];
  const lingeringLegacySlugs = [];

  for (const mapping of LEGACY_PROJECT_REDIRECTS) {
    const from = normalizePathname(mapping.from);
    const to = normalizePathname(mapping.to);
    if (!from || !to) continue;

    const entry = redirects.get(from);
    if (!entry) {
      missingRedirects.push(`${from} -> ${to}`);
    } else if (normalizePathname(entry.target) !== to) {
      mismatchedTargets.push(`${from} -> ${entry.target} (expected ${to})`);
    }

    const targetSlug = toSlug(to);
    if (targetSlug && !projectSlugs.has(targetSlug)) {
      missingTargets.push(`${to} (missing slug "${targetSlug}")`);
    }

    const legacySlug = toSlug(from);
    if (legacySlug && projectSlugs.has(legacySlug)) {
      lingeringLegacySlugs.push(legacySlug);
    }
  }

  if (
    missingRedirects.length > 0 ||
    mismatchedTargets.length > 0 ||
    missingTargets.length > 0 ||
    lingeringLegacySlugs.length > 0
  ) {
    const lines = ['Redirect coverage check failed:'];
    if (missingRedirects.length > 0) {
      lines.push('Missing redirects:');
      for (const item of missingRedirects) lines.push(`- ${item}`);
    }
    if (mismatchedTargets.length > 0) {
      lines.push('Redirect targets mismatch:');
      for (const item of mismatchedTargets) lines.push(`- ${item}`);
    }
    if (missingTargets.length > 0) {
      lines.push('Redirect targets missing in projects collection:');
      for (const item of missingTargets) lines.push(`- ${item}`);
    }
    if (lingeringLegacySlugs.length > 0) {
      lines.push('Legacy slugs still present in projects:');
      for (const slug of lingeringLegacySlugs) lines.push(`- ${slug}`);
    }
    fail(lines.join('\n'));
  }

  console.log(`Redirect coverage check passed: ${LEGACY_PROJECT_REDIRECTS.length} legacy slugs verified.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
