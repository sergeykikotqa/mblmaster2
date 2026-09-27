import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildAuditRoutes } from './lib/audit-routes.mjs';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, '.lighthouserc.json');
const TEMP_DIR = path.join(ROOT, '.tmp', 'lighthouse');
const LHCI_DIR = path.join(ROOT, '.lighthouseci');
const EVIDENCE_DIR = path.join(ROOT, '.tmp', 'lighthouse-report');
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

/**
 * Copies freshly collected LHR reports out of the .lighthouseci working dir.
 *
 * Assertions run after this script, so the evidence must be captured while the
 * collected reports are still present. The copy also survives a later failure,
 * which is the only useful moment for a red Lighthouse gate.
 */
function persistCollectedEvidence() {
  if (!fs.existsSync(LHCI_DIR)) return 0;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  let copied = 0;
  for (const entry of fs.readdirSync(LHCI_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^lhr-\d+\.(json|html)$/.test(entry.name)) continue;
    fs.copyFileSync(path.join(LHCI_DIR, entry.name), path.join(EVIDENCE_DIR, entry.name));
    copied += 1;
  }
  return copied;
}

/**
 * Runs a collect step and always persists the evidence it produced.
 *
 * Error priority matters here. A single 404 on an audited route makes
 * `lhci collect` exit non-zero, and the reports gathered before that point are
 * the only way to see what did get measured. Two rules follow:
 *
 *   collect FAIL + persist PASS  -> the original collect error propagates
 *   collect FAIL + persist FAIL  -> the original collect error still propagates;
 *                                   the persistence error is only logged
 *   collect PASS + persist FAIL  -> the gate fails on the persistence error
 *
 * A bare `try/finally` would break the middle case: an error thrown from the
 * finally block replaces the in-flight exception, so the evidence failure would
 * mask the 404 that actually broke the run.
 */
export async function runCollectWithEvidence({ collect, persist, log = console.log }) {
  let collectError = null;
  try {
    await collect();
  } catch (error) {
    collectError = error;
  }

  let persistenceError = null;
  try {
    await persist();
  } catch (error) {
    persistenceError = error;
  }

  if (persistenceError) {
    if (collectError) {
      log(
        `[lighthouse] evidence persistence failed as well (secondary to the collect failure): ${
          persistenceError instanceof Error ? persistenceError.message : persistenceError
        }`
      );
    } else {
      throw persistenceError;
    }
  }

  if (collectError) throw collectError;
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
    await runCollectWithEvidence({
      collect: () => runCommand(npxCommand, ['lhci', 'collect', '--config', configPath, '--additive'], 'lhci collect'),
      persist: () => {
        const evidenceFiles = persistCollectedEvidence();
        console.log(`[lighthouse] evidence persisted: ${evidenceFiles} file(s) in ${EVIDENCE_DIR}`);
      },
    });
    if (!skipAssert) {
      runCommand(npxCommand, ['lhci', 'assert', '--config', configPath], 'lhci assert');
    }
  }
}

// Only self-execute when invoked directly, so tests can import the helpers above
// without triggering a Lighthouse batch run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[lighthouse] batch run failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
