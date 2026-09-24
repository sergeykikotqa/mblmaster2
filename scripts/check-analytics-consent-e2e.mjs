import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const npmCliPath = process.env.npm_execpath;
const playwrightCliPath = path.join(projectRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const testEnv = {
  ...process.env,
  PUBLIC_SITE_URL: 'https://mbl-r16.local.test',
  PUBLIC_GA4_ID: 'G-R16SYNTHETIC',
  PUBLIC_YANDEX_METRIKA_ID: '12345678',
  PUBLIC_ENABLE_RUM_WEB_VITALS: 'true',
};

async function runNodeScript(args) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: testEnv,
    stdio: 'inherit',
    shell: false,
  });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) {
    throw new Error(`Child process failed (code=${String(code)}, signal=${String(signal)})`);
  }
}

async function main() {
  if (!npmCliPath) {
    throw new Error('npm_execpath is unavailable; run this check through npm run check:e2e:analytics-consent');
  }

  await runNodeScript([npmCliPath, 'run', 'build']);
  await runNodeScript([playwrightCliPath, 'test', '--config=playwright.analytics-consent.config.ts']);
}

main().catch((error) => {
  console.error('Analytics consent e2e check failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
