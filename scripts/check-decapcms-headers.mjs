import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HEADERS_PATH = path.join(ROOT, 'dist', '_headers');

if (!fs.existsSync(HEADERS_PATH)) {
  console.error('Decap CMS headers check failed: dist/_headers is missing. Run `npm run build` first.');
  process.exit(1);
}

const headersSource = fs.readFileSync(HEADERS_PATH, 'utf8');
const hasDecapRule = /(?:^|\n)\/decapcms\/\*(?:\r?\n)+\s*X-Robots-Tag:\s*noindex,\s*nofollow\b/i.test(headersSource);

if (!hasDecapRule) {
  console.error(
    'Decap CMS headers check failed: dist/_headers must include `/decapcms/*` with `X-Robots-Tag: noindex, nofollow`.'
  );
  process.exit(1);
}

console.log('Decap CMS headers check passed: X-Robots-Tag is configured for /decapcms/*.');
