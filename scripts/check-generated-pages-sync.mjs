import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GENERATED_ARTIFACTS = ['data/generated-pages.json', 'data/article-seo-state.json'];
const gitCommand = 'git';
const nodeCommand = process.execPath;

function fail(message) {
  throw new Error(message);
}

function run(command, args, label, envOverride = process.env) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
    env: envOverride,
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    const details = [stderr, stdout].filter(Boolean).join('\n');
    fail(`${label} failed (exit ${result.status}).${details ? `\n${details}` : ''}`);
  }

  return { stdout: String(result.stdout || '') };
}

function ensureGeneratedFileExists(relativePath) {
  if (!fs.existsSync(path.join(ROOT, relativePath))) {
    fail(`Missing ${relativePath}. Run "npm run build:data" and commit the artifact.`);
  }
}

function ensureGeneratedFileTracked(relativePath) {
  run(gitCommand, ['ls-files', '--error-unmatch', relativePath], 'git ls-files');
}

function ensureNotUntracked(relativePath) {
  const result = run(
    gitCommand,
    ['ls-files', '--others', '--exclude-standard', '--', relativePath],
    'git ls-files --others'
  );
  if (String(result.stdout || '').trim()) {
    fail(`${relativePath} is untracked. Commit generated artifacts policy requires this file in git.`);
  }
}

function readRelativeFile(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`Missing ${relativePath}. Run "npm run build:data" and commit the artifact.`);
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function ensureNoDiffAfterBuildData() {
  const generatedBefore = new Map(
    GENERATED_ARTIFACTS.map((relativePath) => [relativePath, readRelativeFile(relativePath)])
  );
  const buildEnv = { ...process.env };
  if (!buildEnv.PUBLIC_SITE_URL) {
    buildEnv.PUBLIC_SITE_URL = 'http://localhost';
  }
  run(nodeCommand, ['scripts/build-data.mjs'], 'node scripts/build-data.mjs', buildEnv);
  for (const relativePath of GENERATED_ARTIFACTS) {
    const generatedAfter = readRelativeFile(relativePath);
    if (generatedAfter !== generatedBefore.get(relativePath)) {
      fail(
        `${relativePath} changed after regeneration. Run "npm run build:data" and commit updated generated artifacts.`
      );
    }
  }
}

function main() {
  for (const relativePath of GENERATED_ARTIFACTS) {
    ensureGeneratedFileExists(relativePath);
    ensureGeneratedFileTracked(relativePath);
    ensureNotUntracked(relativePath);
  }
  ensureNoDiffAfterBuildData();
  console.log(`Generated artifact sync check passed: ${GENERATED_ARTIFACTS.join(', ')}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
