import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const COMPONENTS_DIR = path.join(SRC_DIR, 'components');
const SOURCE_EXTENSIONS = new Set(['.astro', '.ts', '.tsx', '.js', '.mjs']);

function collectFiles(dirPath, matcher) {
  const result = [];
  if (!fs.existsSync(dirPath)) return result;

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.isFile() && matcher(absolute)) {
        result.push(absolute);
      }
    }
  }

  walk(dirPath);
  return result;
}

function main() {
  const sourceFiles = collectFiles(SRC_DIR, (filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const sourceContents = sourceFiles.map((filePath) => ({
    filePath,
    content: fs.readFileSync(filePath, 'utf8'),
  }));

  const componentFiles = collectFiles(
    COMPONENTS_DIR,
    (filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && !filePath.endsWith('.d.ts')
  );

  const candidates = [];

  for (const componentFile of componentFiles) {
    const relativeFromSrc = path.relative(SRC_DIR, componentFile).replace(/\\/g, '/');
    const importPath = relativeFromSrc.replace(/\.[^.]+$/, '');
    const baseName = path.basename(importPath);

    const needles = [`~/${importPath}`, `@/${importPath}`, `/${importPath}`, `'${baseName}'`, `"${baseName}"`];

    const matched = sourceContents.some(({ filePath, content }) => {
      if (filePath === componentFile) return false;
      return needles.some((needle) => content.includes(needle));
    });

    if (!matched) {
      candidates.push(relativeFromSrc);
    }
  }

  if (candidates.length === 0) {
    console.log('Orphan component scan: no obvious candidates found.');
    return;
  }

  console.log(`Orphan component scan (warning-only): ${candidates.length} candidates`);
  for (const filePath of candidates) {
    console.log(`- ${filePath}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
