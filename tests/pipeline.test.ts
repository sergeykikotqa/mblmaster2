import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

import { copyGitVisibleWorkspace } from '../scripts/run-unit-tests.mjs';

const generatedArtifacts = [
  'data/generated-pages.json',
  'data/article-seo-state.json',
  'data/funnel-public-pages.json',
];

test('build:data pipeline runs and produces 3 generated pages', () => {
  const repositoryRoot = process.cwd();
  const repositoryBefore = new Map(
    generatedArtifacts.map((relativePath) => [relativePath, fs.readFileSync(path.join(repositoryRoot, relativePath))])
  );
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-build-data-test-'));

  try {
    copyGitVisibleWorkspace(repositoryRoot, workspaceRoot);
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error('npm_execpath is unavailable; run this test through npm.');

    execFileSync(process.execPath, [npmCli, 'run', 'build:data'], {
      cwd: workspaceRoot,
      env: { ...process.env, PUBLIC_SITE_URL: 'https://pipeline-test.mbl.invalid' },
      stdio: 'pipe',
    });

    const generatedPath = path.join(workspaceRoot, 'data/generated-pages.json');
    const pages = JSON.parse(fs.readFileSync(generatedPath, 'utf8')) as unknown[];
    expect(Array.isArray(pages)).toBe(true);
    expect(pages).toHaveLength(3);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    for (const [relativePath, expectedContents] of repositoryBefore) {
      expect(fs.readFileSync(path.join(repositoryRoot, relativePath))).toEqual(expectedContents);
    }
  }
}, 120000);
