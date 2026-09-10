import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();

const COLLECTIONS = [
  { name: 'articles', base: path.join(ROOT, 'src', 'content', 'articles') },
  { name: 'guides', base: path.join(ROOT, 'src', 'content', 'guides') },
  { name: 'projects', base: path.join(ROOT, 'src', 'content', 'projects') },
  { name: 'services', base: path.join(ROOT, 'src', 'content', 'services') },
  { name: 'cities', base: path.join(ROOT, 'src', 'content', 'cities') },
  { name: 'faq', base: path.join(ROOT, 'src', 'content', 'faq') },
];

function extractFrontmatter(source) {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith('---')) return null;
  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) return null;
  return trimmed.slice(3, endIndex).trim();
}

function extractSlug(frontmatter) {
  if (!frontmatter) return null;
  const lines = frontmatter.split(/\r?\n/);
  for (const line of lines) {
    const match = line.trim().match(/^slug\s*:\s*["']?([^"'#]+)["']?/);
    if (match) return match[1].trim();
  }
  return null;
}

async function listMarkdownFiles(baseDir) {
  let entries = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.mdx?$/i.test(entry.name))
    .map((entry) => path.join(baseDir, entry.name));
}

function getEntryId(filePath, slug) {
  if (slug) return slug;
  return path.basename(filePath, path.extname(filePath));
}

async function main() {
  const errors = [];

  for (const collection of COLLECTIONS) {
    const files = await listMarkdownFiles(collection.base);
    const idMap = new Map();

    for (const filePath of files) {
      const source = await fs.readFile(filePath, 'utf8');
      const frontmatter = extractFrontmatter(source);
      const slug = extractSlug(frontmatter);
      const id = getEntryId(filePath, slug);

      if (!idMap.has(id)) {
        idMap.set(id, []);
      }
      idMap.get(id).push(filePath);
    }

    for (const [id, paths] of idMap.entries()) {
      if (paths.length > 1) {
        errors.push({ collection: collection.name, id, paths });
      }
    }
  }

  if (errors.length > 0) {
    console.error('[check-content-duplicates] Duplicate ids detected.');
    for (const error of errors) {
      console.error(`Collection: ${error.collection}`);
      console.error(`  id: ${error.id}`);
      for (const filePath of error.paths) {
        console.error(`  - ${filePath}`);
      }
    }
    process.exit(1);
  }

  console.log('[check-content-duplicates] OK: no duplicate ids.');
}

await main();
