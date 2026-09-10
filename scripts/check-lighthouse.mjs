import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runCommand(command, args, label, env, useShell = process.platform === 'win32') {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env,
    shell: useShell,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function main() {
  const fallbackSiteUrl =
    process.env.PUBLIC_SITE_URL ||
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_URL ||
    'https://mebel-irkutsk.ru';

  const env = {
    ...process.env,
    NETLIFY_IMAGE_CDN: 'false',
    PUBLIC_SITE_URL: fallbackSiteUrl,
  };

  if (!process.env.PUBLIC_SITE_URL) {
    console.warn(`[lighthouse] PUBLIC_SITE_URL not set, using ${fallbackSiteUrl}`);
  }
  console.log('[lighthouse] building with NETLIFY_IMAGE_CDN=false');
  runCommand(npmCommand, ['run', 'build'], 'build', env, true);

  runCommand(process.execPath, [path.join('scripts', 'run-lighthouse-batch.mjs')], 'lhci collect', env, false);
  runCommand(process.execPath, [path.join('scripts', 'lighthouse-summarize.mjs')], 'lighthouse summarize', env, false);
  runCommand(process.execPath, [path.join('scripts', 'check-lighthouse-lcp-element.mjs')], 'lighthouse LCP check', env, false);
}

main();
