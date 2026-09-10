import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const RESERVED_SLUGS = new Set(['test', 'new', 'project']);
const COLLECTION_DIRS = [
  { name: 'projects', dir: path.join(ROOT, 'src', 'content', 'projects') },
  { name: 'guides', dir: path.join(ROOT, 'src', 'content', 'guides') },
  { name: 'services', dir: path.join(ROOT, 'src', 'content', 'services') },
];

function fail(message) {
  throw new Error(message);
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

function collectFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|mdx)$/i.test(entry.name))
    .map((entry) => path.join(dirPath, entry.name));
}

function main() {
  const bySlug = new Map();
  const reservedHits = [];

  for (const collection of COLLECTION_DIRS) {
    const files = collectFiles(collection.dir);

    for (const absolutePath of files) {
      const content = fs.readFileSync(absolutePath, 'utf8');
      const frontmatterSlug = extractFrontmatterSlug(content);
      const fallback = path.basename(absolutePath).replace(/\.(md|mdx)$/i, '');
      const slug = normalizeSlug(frontmatterSlug || fallback);

      if (!slug) {
        fail(`Slug is empty in ${path.relative(ROOT, absolutePath).replace(/\\/g, '/')}`);
      }

      const relativePath = path.relative(ROOT, absolutePath).replace(/\\/g, '/');
      if (RESERVED_SLUGS.has(slug)) {
        reservedHits.push({ slug, file: relativePath });
      }

      const bucket = bySlug.get(slug) || [];
      bucket.push({ collection: collection.name, file: relativePath });
      bySlug.set(slug, bucket);
    }
  }

  const duplicateEntries = Array.from(bySlug.entries()).filter(([, items]) => items.length > 1);
  if (duplicateEntries.length > 0) {
    const details = duplicateEntries
      .map(([slug, items]) => `- ${slug}: ${items.map((item) => `${item.collection}:${item.file}`).join(', ')}`)
      .join('\n');
    fail(`Slug collision detected between projects/guides/services:\n${details}`);
  }

  if (reservedHits.length > 0) {
    const details = reservedHits.map((item) => `- ${item.slug}: ${item.file}`).join('\n');
    fail(`Reserved slugs are not allowed:\n${details}`);
  }

  const totalFiles = Array.from(bySlug.values()).reduce((sum, items) => sum + items.length, 0);
  console.log(`Slug guard passed: ${totalFiles} files checked across projects, guides and services.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
