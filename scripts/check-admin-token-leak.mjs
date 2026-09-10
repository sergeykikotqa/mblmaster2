import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distAdminDir = path.join(repoRoot, 'dist', 'admin');

const token = String(process.env.METRICS_ADMIN_TOKEN || '').trim();
if (!token) {
  console.error(
    'METRICS_ADMIN_TOKEN is required for the admin token leak check. Set METRICS_ADMIN_TOKEN=__SENTINEL__ when running this check.'
  );
  process.exit(1);
}

if (!fs.existsSync(distAdminDir)) {
  console.error('dist/admin not found. Run the build before running the admin token leak check.');
  process.exit(1);
}

const TEXT_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.txt', '.map']);
const files = [];

function collectFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
}

collectFiles(distAdminDir);

if (files.length === 0) {
  console.error('Admin token leak check failed: no admin build files found to scan.');
  process.exit(1);
}

const violations = [];

for (const filePath of files) {
  let contents = '';
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    continue;
  }

  if (contents.includes(token)) {
    violations.push(path.relative(repoRoot, filePath).replace(/\\/g, '/'));
  }
}

if (violations.length > 0) {
  console.error('Admin token leak check failed: METRICS_ADMIN_TOKEN value detected in build output.');
  violations.forEach((file) => console.error(`- ${file}`));
  process.exit(1);
}

console.log('Admin token leak check passed: no METRICS_ADMIN_TOKEN found in dist/admin output.');
