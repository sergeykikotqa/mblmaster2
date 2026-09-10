import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const CONTENT_DIR = path.join(ROOT, 'src', 'content');
const OUTPUT_PATH = path.join(ROOT, 'artifacts', 'content-audit.json');

const COLLECTIONS = [
  { name: 'articles', dir: 'articles', prefix: '/articles/' },
  { name: 'guides', dir: 'guides', prefix: '/guides/' },
  { name: 'faq', dir: 'faq', prefix: '/faq/' },
  { name: 'projects', dir: 'projects', prefix: '/projects/' },
  { name: 'services', dir: 'services', prefix: '/' },
  { name: 'cities', dir: 'cities', prefix: '/' },
];

function normalizePath(pathname) {
  const normalized = `/${String(pathname || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function extractFrontmatter(raw) {
  if (!raw.startsWith('---')) return null;
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match ? match[1] : null;
}

function parseMarkdownFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const frontmatterSource = extractFrontmatter(raw);
  const frontmatter = frontmatterSource ? (yaml.load(frontmatterSource) || {}) : {};
  const body = frontmatterSource ? raw.slice(frontmatterSource.length + 8) : raw;
  return { frontmatter, body };
}

function countWords(text) {
  return String(text || '')
    .replace(/[#>*`_~]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

function listMarkdownFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const output = [];
  const stack = [dirPath];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
        output.push(fullPath);
      }
    }
  }
  return output.sort();
}

function slugFromFile(filePath, frontmatter) {
  const base = path.basename(filePath).replace(/\.mdx?$/i, '');
  return String(frontmatter?.slug || base).trim();
}

function buildEntrySummary(collection, filePath) {
  const { frontmatter, body } = parseMarkdownFile(filePath);
  const slug = slugFromFile(filePath, frontmatter);
  const pathValue = collection.prefix === '/' ? normalizePath(`/${slug}`) : normalizePath(`${collection.prefix}${slug}`);
  return {
    collection: collection.name,
    file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
    slug,
    path: pathValue,
    title: frontmatter?.title || '',
    description: frontmatter?.description || '',
    draft: Boolean(frontmatter?.draft),
    seoReady: frontmatter?.seoReady === true,
    isArchived: frontmatter?.isArchived === true,
    noindex: frontmatter?.noindex === true,
    wordCount: countWords(body),
  };
}

function main() {
  const results = [];

  for (const collection of COLLECTIONS) {
    const dirPath = path.join(CONTENT_DIR, collection.dir);
    const files = listMarkdownFiles(dirPath);
    for (const filePath of files) {
      results.push(buildEntrySummary(collection, filePath));
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    total: results.length,
    entries: results,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[content] audit summary saved to ${path.relative(ROOT, OUTPUT_PATH).replace(/\\/g, '/')}`);
}

main();
