import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultProjectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const defaultVitestCli = path.join(defaultProjectRoot, 'node_modules', 'vitest', 'vitest.mjs');
const defaultTestOrigin = 'https://unit-test.mbl.invalid';
const buildMarkerName = '.mbl-unit-test-build.json';
const vitestArgs = [
  'run',
  '--exclude',
  'tests/lead-delivery-fault-injection.integration.test.ts',
  '--exclude',
  'tests/lead-delivery-process-kill.integration.test.ts',
];

/**
 * @typedef {{ status: number | null, signal: NodeJS.Signals | null, error?: Error, stdout?: Buffer | string }} CommandResult
 * @typedef {(command: string, args: string[], options: Record<string, unknown>) => CommandResult} CommandRunner
 * @typedef {{ write: (chunk: string) => unknown }} ErrorWriter
 */

export function resolveUnitTestOrigin(env = process.env) {
  const raw = String(env.MBL_UNIT_TEST_PUBLIC_SITE_URL || defaultTestOrigin);
  if (raw !== raw.trim()) throw new Error('MBL_UNIT_TEST_PUBLIC_SITE_URL must not contain surrounding whitespace.');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('MBL_UNIT_TEST_PUBLIC_SITE_URL must be a valid synthetic HTTPS origin.');
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith('.invalid') ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('MBL_UNIT_TEST_PUBLIC_SITE_URL must be an origin such as https://unit-test.mbl.invalid.');
  }
  return parsed.origin;
}

function commandFailure(result, label) {
  if (result.error) return `${label} could not start: ${result.error.message}`;
  if (typeof result.status === 'number') return `${label} failed with exit code ${result.status}.`;
  return `${label} ended without an exit code${result.signal ? ` (${result.signal})` : ''}.`;
}

function copyGitVisibleWorkspace(projectRoot, workspaceRoot) {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: projectRoot,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0 || listed.error) throw new Error(commandFailure(listed, 'git ls-files'));

  const relativePaths = Buffer.from(listed.stdout || '')
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  for (const relativePath of relativePaths) {
    if (/^(?:\.env(?:\.|$)|secrets(?:\/|$))/i.test(relativePath.replaceAll('\\', '/'))) continue;
    const source = path.resolve(projectRoot, relativePath);
    if (source !== projectRoot && !source.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to copy a path outside the project: ${relativePath}`);
    }
    const destination = path.resolve(workspaceRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  const sourceModules = path.join(projectRoot, 'node_modules');
  if (!fs.statSync(sourceModules).isDirectory()) throw new Error('node_modules is missing; run npm ci first.');
  fs.symlinkSync(
    sourceModules,
    path.join(workspaceRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
}

function createWorkspace(projectRoot) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-unit-tests-'));
  copyGitVisibleWorkspace(projectRoot, workspaceRoot);
  return workspaceRoot;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   projectRoot?: string,
 *   vitestCli?: string,
 *   npmCli?: string,
 *   runCommand?: CommandRunner,
 *   createWorkspace?: (projectRoot: string) => string,
 *   removeWorkspace?: (workspaceRoot: string) => void,
 *   stderr?: ErrorWriter
 * }} [options]
 */
export function runUnitTests({
  env = process.env,
  projectRoot = defaultProjectRoot,
  vitestCli = defaultVitestCli,
  npmCli = process.env.npm_execpath,
  runCommand = spawnSync,
  createWorkspace: createWorkspaceImpl = createWorkspace,
  removeWorkspace = (workspaceRoot) => fs.rmSync(workspaceRoot, { recursive: true, force: true }),
  stderr = process.stderr,
} = {}) {
  let origin;
  try {
    origin = resolveUnitTestOrigin(env);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!npmCli) {
    stderr.write('npm_execpath is unavailable; run this gate through npm test.\n');
    return 1;
  }

  let workspaceRoot;
  let resultStatus = 1;
  let cleanupFailed = false;
  try {
    workspaceRoot = createWorkspaceImpl(projectRoot);
    const buildResult = runCommand(process.execPath, [npmCli, 'run', 'build'], {
      cwd: workspaceRoot,
      env: { ...env, PUBLIC_SITE_URL: origin },
      stdio: 'inherit',
    });
    if (buildResult.error || buildResult.status !== 0) {
      stderr.write(`${commandFailure(buildResult, 'Hermetic unit-test build')}\n`);
      resultStatus = typeof buildResult.status === 'number' && buildResult.status !== 0 ? buildResult.status : 1;
    } else {
      const distDir = path.join(workspaceRoot, 'dist');
      const missingFile = ['index.html', 'sitemap.xml'].find((requiredFile) => {
        const requiredPath = path.join(distDir, requiredFile);
        return !fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile();
      });
      if (missingFile) {
        stderr.write(`Hermetic unit-test build is missing dist/${missingFile}; Vitest was not started.\n`);
      } else {
        fs.writeFileSync(
          path.join(distDir, buildMarkerName),
          `${JSON.stringify({ schemaVersion: 1, publicSiteUrl: origin })}\n`,
          'utf8'
        );

        const testResult = runCommand(process.execPath, [vitestCli, ...vitestArgs], {
          cwd: projectRoot,
          env: {
            ...env,
            PUBLIC_SITE_URL: origin,
            MBL_UNIT_TEST_DIST_DIR: distDir,
          },
          stdio: 'inherit',
        });
        if (testResult.error || typeof testResult.status !== 'number') {
          stderr.write(`${commandFailure(testResult, 'Vitest')}\n`);
        } else {
          resultStatus = testResult.status;
        }
      }
    }
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    if (workspaceRoot) {
      try {
        removeWorkspace(workspaceRoot);
      } catch (error) {
        stderr.write(
          `Unable to remove hermetic unit-test workspace: ${error instanceof Error ? error.message : String(error)}\n`
        );
        cleanupFailed = true;
      }
    }
  }
  return cleanupFailed ? 1 : resultStatus;
}

export const unitTestBuildContract = Object.freeze({ buildMarkerName, defaultTestOrigin, vitestArgs: [...vitestArgs] });

const isDirectRun = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) process.exitCode = runUnitTests();
