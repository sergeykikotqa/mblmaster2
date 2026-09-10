import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const TARGET_DIRS = [path.join(repoRoot, 'src', 'pages', 'admin'), path.join(repoRoot, 'src', 'components', 'admin')];

const SOURCE_EXTENSIONS = new Set(['.astro', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const STORAGE_USAGE_PATTERN = /\b(?:window\.)?(sessionStorage|localStorage)\s*\./g;

function collectSourceFiles(dirPath, output) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, output);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    output.push(fullPath);
  }
}

const files = [];
for (const dirPath of TARGET_DIRS) {
  collectSourceFiles(dirPath, files);
}

if (files.length === 0) {
  throw new Error('No admin UI source files found for storage guard.');
}

const violations = [];

for (const filePath of files) {
  const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    STORAGE_USAGE_PATTERN.lastIndex = 0;
    if (!STORAGE_USAGE_PATTERN.test(line)) continue;

    violations.push({
      file: relativePath,
      line: lineIndex + 1,
      code: line.trim(),
    });
  }
}

if (violations.length > 0) {
  console.error('Admin token storage guard failed: browser storage usage found in admin UI files.');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} -> ${violation.code}`);
  }
  process.exit(1);
}

console.log(`Admin token storage guard passed: ${files.length} admin source files checked.`);
