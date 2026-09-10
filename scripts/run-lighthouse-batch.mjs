import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildAuditRoutes } from './lib/audit-routes.mjs';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, '.lighthouserc.json');
const TEMP_DIR = path.join(ROOT, '.tmp', 'lighthouse');
const LHCI_DIR = path.join(ROOT, '.lighthouseci');
const DEFAULT_BATCH_SIZE = 25;

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('.lighthouserc.json is missing.');
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function parseBatchSize() {
  const parsed = Number(process.env.LHCI_BATCH_SIZE);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.floor(parsed));
}

function parseNumberOfRuns() {
  const parsed = Number(process.env.LHCI_NUMBER_OF_RUNS);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.floor(parsed));
}

function parseExplicitRoutes() {
  const raw = String(process.env.LHCI_ROUTES || '').trim();
  if (!raw) return null;
  const routes = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (value.startsWith('/') ? value : `/${value}`));
  return routes.length > 0 ? routes : null;
}

function canonicalizeRoutePath(routePath) {
  const trimmed = String(routePath || '').trim();
  if (!trimmed) return '/';

  const parsed = new URL(trimmed, 'http://localhost');
  if (parsed.pathname !== '/' && !parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`;
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function chunkArray(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

async function main() {
  const explicitRoutes = parseExplicitRoutes();
  const routes = explicitRoutes ? explicitRoutes.map((path) => ({ path })) : (await buildAuditRoutes()).routes;
  if (!routes.length) {
    throw new Error('No audit routes resolved for Lighthouse.');
  }

  if (fs.existsSync(LHCI_DIR)) {
    fs.rmSync(LHCI_DIR, { recursive: true, force: true });
  }

  const baseUrl = String(process.env.LHCI_BASE_URL || 'http://localhost').trim();
  const skipAssert = String(process.env.LHCI_SKIP_ASSERT || '').toLowerCase() === 'true';
  const urls = routes.map((route) => new URL(canonicalizeRoutePath(route.path), baseUrl).toString());
  const batchSize = parseBatchSize();
  const numberOfRunsOverride = parseNumberOfRuns();
  const batches = chunkArray(urls, batchSize);

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const baseConfig = readConfig();

  console.log(`[lighthouse] total urls=${urls.length}, batchSize=${batchSize}, batches=${batches.length}`);

  for (let i = 0; i < batches.length; i += 1) {
    const batchUrls = batches[i];
    const batchConfig = {
      ...baseConfig,
      ci: {
        ...baseConfig.ci,
        collect: {
          ...baseConfig.ci?.collect,
          url: batchUrls,
          ...(numberOfRunsOverride ? { numberOfRuns: numberOfRunsOverride } : {}),
        },
      },
    };

    const configPath = path.join(TEMP_DIR, `lighthouserc-batch-${i + 1}.json`);
    fs.writeFileSync(configPath, `${JSON.stringify(batchConfig, null, 2)}\n`, 'utf8');

    console.log(`[lighthouse] batch ${i + 1}/${batches.length}: ${batchUrls.length} urls`);
    runCommand(npxCommand, ['lhci', 'collect', '--config', configPath, '--additive'], 'lhci collect');
    if (!skipAssert) {
      runCommand(npxCommand, ['lhci', 'assert', '--config', configPath], 'lhci assert');
    }
  }
}

main().catch((error) => {
  console.error('[lighthouse] batch run failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
