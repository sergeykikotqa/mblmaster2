import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const nodeCommand = process.execPath;

const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const SERVICES_PATH = path.join(ROOT, 'data', 'services.json');

function fail(message) {
  throw new Error(message);
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
    env: process.env,
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    const details = [stderr, stdout].filter(Boolean).join('\n');
    fail(`${label} failed (exit ${result.status}).${details ? `\n${details}` : ''}`);
  }
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing file: ${path.relative(ROOT, filePath).replace(/\\/g, '/')}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizePath(value) {
  const normalized = `/${String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function normalizeSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '');
}

function buildExpectedSlugs(services) {
  return services
    .filter((service) => service?.moneyPage === true)
    .map((service) => normalizePath(`/${normalizeSegment(service.pathSegment || service.id)}`));
}

function main() {
  run(nodeCommand, ['scripts/build-data.mjs'], 'node scripts/build-data.mjs');

  const pages = readJson(GENERATED_PAGES_PATH);
  const services = readJson(SERVICES_PATH);

  if (!Array.isArray(pages) || pages.length === 0) {
    fail('generated-pages must contain at least one page');
  }

  const expectedSlugs = buildExpectedSlugs(services);
  const actualSlugs = pages.map((page) => normalizePath(page?.pageSlug || ''));

  if (actualSlugs.length !== expectedSlugs.length) {
    fail(`generated-pages length mismatch: expected ${expectedSlugs.length}, got ${actualSlugs.length}`);
  }

  const expectedSet = new Set(expectedSlugs);
  const seen = new Set();

  for (const page of pages) {
    const slug = normalizePath(page?.pageSlug || '');

    if (!expectedSet.has(slug)) {
      fail(`generated-pages contains unexpected slug: ${slug}`);
    }
    if (seen.has(slug)) {
      fail(`generated-pages has duplicate slug: ${slug}`);
    }
    seen.add(slug);

    if (String(page?.pageType || '') !== 'service-money') {
      fail(`only service-money is allowed, got "${String(page?.pageType || '')}" for ${slug}`);
    }
    if (String(page?.indexabilityPolicy || '') !== 'index') {
      fail(`indexabilityPolicy must be "index" for ${slug}`);
    }
    if (String(page?.releaseStage || '') !== 'index_stable') {
      fail(`releaseStage must be "index_stable" for ${slug}`);
    }
    if (String(page?.priorityTier || '') !== 'A') {
      fail(`priorityTier must be "A" for ${slug}`);
    }
  }

  console.log(`Architecture check passed: ${pages.length} service-money pages.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
