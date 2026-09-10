import fs from 'node:fs/promises';
import path from 'node:path';

import { buildAuditRoutes } from './lib/audit-routes.mjs';

const ROOT = process.cwd();
const OUTPUT_PATH = process.env.AUDIT_ROUTES_PATH
  ? path.resolve(process.env.AUDIT_ROUTES_PATH)
  : path.join(ROOT, 'artifacts', 'audit-routes.json');

async function main() {
  const { routes, meta } = await buildAuditRoutes();
  const payload = {
    ...meta,
    routes,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[audit] wrote ${routes.length} routes -> ${path.relative(ROOT, OUTPUT_PATH).replace(/\\/g, '/')}`);
}

main().catch((error) => {
  console.error('[audit] generate routes failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
