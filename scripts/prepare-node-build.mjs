import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Astro cleans dist/, but our private server artifact deliberately lives outside it.
// Remove only that generated directory so deleted routes cannot survive a rebuild.
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = path.resolve(projectRoot, '.output');
const serverDir = path.resolve(outputRoot, 'server');
if (path.dirname(serverDir) !== outputRoot || path.basename(serverDir) !== 'server') {
  throw new Error('Unexpected private server build path');
}
for (const directory of [outputRoot, serverDir]) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Refusing to clean symlinked build directory: ${directory}`);
  }
}
fs.rmSync(serverDir, { recursive: true, force: true });
console.log('[prepare-node-build] private server output is clean');
