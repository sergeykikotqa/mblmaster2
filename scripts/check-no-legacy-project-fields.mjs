import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const PROJECTS_DIR = path.join(ROOT, 'src', 'content', 'projects');

const LEGACY_FIELDS = [
  'task',
  'solution',
  'process',
  'cost',
  'beforeAfter',
  'faq',
  'internalLinks',
  'imageCaptions',
];

function extractFrontmatter(rawSource) {
  const source = String(rawSource || '');
  if (!source.startsWith('---')) return null;
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? String(match[1] || '') : null;
}

function parseFrontmatter(source) {
  if (!source) return {};
  try {
    const parsed = yaml.load(source, { schema: yaml.JSON_SCHEMA });
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function main() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(`[check-no-legacy-project-fields] projects dir not found: ${PROJECTS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(PROJECTS_DIR).filter((file) => file.endsWith('.md') || file.endsWith('.mdx'));
  const violations = [];

  for (const fileName of files) {
    const fullPath = path.join(PROJECTS_DIR, fileName);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const frontmatterSource = extractFrontmatter(raw);
    if (!frontmatterSource) continue;

    const data = parseFrontmatter(frontmatterSource);
    if (!data || typeof data !== 'object') continue;

    const found = LEGACY_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(data, field));
    if (found.length > 0) {
      violations.push(`${fileName}: ${found.join(', ')}`);
    }
  }

  if (violations.length > 0) {
    console.error('[check-no-legacy-project-fields] legacy fields still present:\n' + violations.join('\n'));
    process.exit(1);
  }

  console.log('[check-no-legacy-project-fields] ok: no legacy fields found');
}

main();
