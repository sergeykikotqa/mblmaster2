import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const IMAGE_ROOT = path.join(ROOT, 'public', 'images');
const MAX_RASTER_BYTES = 500 * 1024;
const PASS_THROUGH_EXTENSIONS = new Set(['.svg', '.ico']);
const RASTER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.tiff', '.bmp']);

function collectFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, results);
      continue;
    }
    if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function main() {
  if (!fs.existsSync(IMAGE_ROOT)) {
    console.log('Image policy check: public/images not found, skipping.');
    return;
  }

  const violations = [];
  const files = collectFiles(IMAGE_ROOT);

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (PASS_THROUGH_EXTENSIONS.has(ext)) continue;
    if (!RASTER_EXTENSIONS.has(ext)) continue;

    const { size } = fs.statSync(filePath);
    if (size > MAX_RASTER_BYTES) {
      violations.push({
        file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        size,
      });
    }
  }

  if (violations.length > 0) {
    console.error('Image policy failed: raster images in public/images must be <= 500KB.');
    for (const item of violations) {
      console.error(`- ${item.file} (${formatBytes(item.size)})`);
    }
    process.exit(1);
  }

  console.log('Image policy passed: all public raster images are within 500KB.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
