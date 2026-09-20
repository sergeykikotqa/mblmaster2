import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

const metricsToken = String(process.env.METRICS_ADMIN_TOKEN || '').trim();
const monitoringToken = String(process.env.MBL_MONITORING_TOKEN || '').trim();
if (!metricsToken) {
  console.error(
    'METRICS_ADMIN_TOKEN is required for the admin token leak check. Set METRICS_ADMIN_TOKEN=__SENTINEL__ when running this check.'
  );
  process.exit(1);
}

if (!fs.existsSync(distDir)) {
  console.error('dist not found. Run the build before running the token leak check.');
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

collectFiles(distDir);

if (files.length === 0) {
  console.error('Token leak check failed: no public build files found to scan.');
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

  if (contents.includes(metricsToken) || (monitoringToken && contents.includes(monitoringToken))) {
    violations.push(path.relative(repoRoot, filePath).replace(/\\/g, '/'));
  }
}

if (violations.length > 0) {
  console.error('Token leak check failed: a private admin/monitoring token value was detected in public build output.');
  violations.forEach((file) => console.error(`- ${file}`));
  process.exit(1);
}

console.log('Token leak check passed: no admin/monitoring token value found in public dist output.');
