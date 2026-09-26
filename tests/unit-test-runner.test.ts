import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { runUnitTests, unitTestBuildContract } from '../scripts/run-unit-tests.mjs';

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' }
) => { status: number | null; signal: NodeJS.Signals | null; error?: Error };

const ownedRoots: string[] = [];

function makeRoot(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mbl-${label}-`));
  ownedRoots.push(root);
  return root;
}

function successfulHarness(projectRoot: string, origin: string) {
  const workspaces: string[] = [];
  const testEnvironments: NodeJS.ProcessEnv[] = [];
  const createWorkspace = vi.fn(() => {
    const workspace = makeRoot('unit-workspace');
    workspaces.push(workspace);
    return workspace;
  });
  const runCommand = vi.fn<CommandRunner>((_command, args, options) => {
    if (args[1] === 'run' && args[2] === 'build') {
      fs.mkdirSync(path.join(options.cwd, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(options.cwd, 'dist', 'index.html'), `<link rel="canonical" href="${origin}/">`);
      fs.writeFileSync(path.join(options.cwd, 'dist', 'sitemap.xml'), `<loc>${origin}/</loc>`);
      return { status: 0, signal: null };
    }
    testEnvironments.push(options.env);
    return { status: 0, signal: null };
  });
  const removeWorkspace = vi.fn((workspace: string) => fs.rmSync(workspace, { recursive: true, force: true }));

  const status = runUnitTests({
    env: { MBL_UNIT_TEST_PUBLIC_SITE_URL: origin },
    projectRoot,
    vitestCli: path.join(projectRoot, 'fake-vitest.mjs'),
    npmCli: path.join(projectRoot, 'fake-npm-cli.js'),
    runCommand,
    createWorkspace,
    removeWorkspace,
  });
  return { createWorkspace, removeWorkspace, runCommand, status, testEnvironments, workspaces };
}

afterEach(() => {
  for (const root of ownedRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('hermetic npm test runner', () => {
  test('uses a fresh workspace instead of a stale project dist', () => {
    const projectRoot = makeRoot('stale-project');
    fs.mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'dist', 'index.html'), 'https://stale-origin.invalid');

    const result = successfulHarness(projectRoot, 'https://fresh-origin.invalid');

    expect(result.status).toBe(0);
    expect(result.testEnvironments).toHaveLength(1);
    expect(result.testEnvironments[0].MBL_UNIT_TEST_DIST_DIR).not.toBe(path.join(projectRoot, 'dist'));
    expect(result.testEnvironments[0].PUBLIC_SITE_URL).toBe('https://fresh-origin.invalid');
    expect(fs.readFileSync(path.join(projectRoot, 'dist', 'index.html'), 'utf8')).toContain('stale-origin.invalid');
    expect(result.removeWorkspace).toHaveBeenCalledOnce();
  });

  test('builds successfully when the project has no dist', () => {
    const projectRoot = makeRoot('no-dist-project');
    const result = successfulHarness(projectRoot, 'https://no-dist.invalid');

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(projectRoot, 'dist'))).toBe(false);
    expect(result.runCommand).toHaveBeenCalledTimes(2);
  });

  test('isolates consecutive runs with different synthetic origins', () => {
    const projectRoot = makeRoot('repeat-project');
    const first = successfulHarness(projectRoot, 'https://first-run.invalid');
    const second = successfulHarness(projectRoot, 'https://second-run.invalid');

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.workspaces[0]).not.toBe(second.workspaces[0]);
    expect(first.testEnvironments[0].PUBLIC_SITE_URL).toBe('https://first-run.invalid');
    expect(second.testEnvironments[0].PUBLIC_SITE_URL).toBe('https://second-run.invalid');
  });

  test('does not start Vitest when the required build fails', () => {
    const projectRoot = makeRoot('failed-build-project');
    fs.mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'dist', 'index.html'), 'stale');
    const workspace = makeRoot('failed-build-workspace');
    const runCommand = vi.fn<CommandRunner>(() => ({ status: 9, signal: null }));
    const removeWorkspace = vi.fn((target: string) => fs.rmSync(target, { recursive: true, force: true }));

    const status = runUnitTests({
      env: {},
      projectRoot,
      npmCli: 'fake-npm-cli.js',
      runCommand,
      createWorkspace: () => workspace,
      removeWorkspace,
      stderr: { write: () => true },
    });

    expect(status).toBe(9);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(removeWorkspace).toHaveBeenCalledOnce();
  });

  test('rejects a real or malformed origin before creating a workspace', () => {
    for (const origin of ['https://mebel-irkutsk.ru', 'http://unit-test.mbl.invalid', 'https://unit.invalid/path']) {
      const createWorkspace = vi.fn();
      expect(
        runUnitTests({
          env: { MBL_UNIT_TEST_PUBLIC_SITE_URL: origin },
          npmCli: 'fake-npm-cli.js',
          createWorkspace,
          stderr: { write: () => true },
        })
      ).toBe(1);
      expect(createWorkspace).not.toHaveBeenCalled();
    }
  });

  test('writes build provenance before starting Vitest', () => {
    const projectRoot = makeRoot('marker-project');
    const origin = 'https://marker.invalid';
    let marker: unknown;
    const workspace = makeRoot('marker-workspace');
    const runCommand = vi.fn<CommandRunner>((_command, args, options) => {
      if (args[1] === 'run' && args[2] === 'build') {
        fs.mkdirSync(path.join(options.cwd, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, 'dist', 'index.html'), 'ok');
        fs.writeFileSync(path.join(options.cwd, 'dist', 'sitemap.xml'), 'ok');
      } else {
        marker = JSON.parse(
          fs.readFileSync(path.join(options.env.MBL_UNIT_TEST_DIST_DIR!, unitTestBuildContract.buildMarkerName), 'utf8')
        );
      }
      return { status: 0, signal: null };
    });

    expect(
      runUnitTests({
        env: { MBL_UNIT_TEST_PUBLIC_SITE_URL: origin },
        projectRoot,
        npmCli: 'fake-npm-cli.js',
        runCommand,
        createWorkspace: () => workspace,
        removeWorkspace: (target) => fs.rmSync(target, { recursive: true, force: true }),
      })
    ).toBe(0);
    expect(marker).toEqual({ schemaVersion: 1, publicSiteUrl: origin });
  });
});
