import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import process from 'node:process';

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  await new Promise((resolve) => server.close(resolve));

  if (!address || typeof address !== 'object') {
    throw new Error('Failed to allocate a free port for admin-auth e2e check.');
  }

  return address.port;
}

async function main() {
  const port = process.env.PLAYWRIGHT_PORT || String(await getFreePort());
  const child = spawn(npxCommand, ['playwright', 'test', 'tests/e2e/admin-auth.spec.ts'], {
    env: {
      ...process.env,
      CI: 'true',
      PLAYWRIGHT_PORT: port,
      METRICS_ADMIN_TOKEN: process.env.METRICS_ADMIN_TOKEN || 'playwright-admin-token',
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const [code] = await once(child, 'exit');
  if (code !== 0) {
    process.exit(Number(code) || 1);
  }
}

main().catch((error) => {
  console.error('Admin auth e2e check failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
