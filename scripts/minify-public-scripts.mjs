import fs from 'node:fs/promises';
import path from 'node:path';

import { transform } from 'esbuild';

const PUBLIC_SCRIPTS_DIR = path.join(process.cwd(), 'public', 'scripts');
const DIST_SCRIPTS_DIR = path.join(process.cwd(), 'dist', 'scripts');

async function minifyPublicScripts() {
  // Only scripts owned by this project are eligible. Never sweep generated or
  // third-party files that might appear in dist/scripts in a future build.
  const entries = await fs.readdir(PUBLIC_SCRIPTS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(DIST_SCRIPTS_DIR, entry.name))
    .sort();

  await Promise.all(
    files.map(async (filePath) => {
      const source = await fs.readFile(filePath, 'utf8');
      const result = await transform(source, {
        legalComments: 'none',
        loader: 'js',
        minify: true,
        target: 'es2020',
      });

      await fs.writeFile(filePath, result.code, 'utf8');
    })
  );

  console.log(`[minify-public-scripts] minified ${files.length} production script(s)`);
}

try {
  await minifyPublicScripts();
} catch (error) {
  console.error('[minify-public-scripts] failed');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
