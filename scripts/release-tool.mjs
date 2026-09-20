import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const MANIFEST_FILE = 'manifest.json';
const CHECKSUM_FILE = 'SHA256SUMS';
const STATE_SCHEMA = 1;
const RELEASE_SCHEMA = 1;
const FULL_SHA = /^[a-f0-9]{40}$/i;
const DEFAULT_WAIT_MS = 90_000;
const APPLICATION_SERVICES = ['mbl-web', 'mbl-worker-trigger', 'mbl-nginx'];
const diagnosticSecrets = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseBoolean(value, fallback = false) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function redactReleaseDiagnostic(value, extraSecrets = []) {
  let output = String(value || '');
  for (const secret of [...diagnosticSecrets, ...extraSecrets]) {
    if (typeof secret === 'string' && secret.length >= 6) output = output.replaceAll(secret, '[redacted]');
  }
  return output
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,"']+/gi, '$1[redacted]')
    .replace(/((?:password|secret|token|access[_-]?key)\s*[:=]\s*)[^\s,"']+/gi, '$1[redacted]')
    .replace(/redis(?:s)?:\/\/[^\s,"']+/gi, 'redis://[redacted]');
}

export function parseCliArgs(argv) {
  const [command = '', ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    assert(item.startsWith('--'), `Unexpected argument: ${item}`);
    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      index += 1;
    }
  }
  return { command, flags };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60_000,
    windowsHide: true,
    maxBuffer: 40 * 1024 * 1024,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const status = Number.isInteger(result.status) ? result.status : 1;
  if (!options.allowFailure && (result.error || status !== 0)) {
    const detail = [result.error?.message, stdout, stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed with exit ${status}${detail ? `\n${detail}` : ''}`);
  }
  return { status, stdout, stderr };
}

function runJson(command, args, options) {
  const output = run(command, args, options).stdout;
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${command} did not return valid JSON`);
  }
}

function runNpm(args, options) {
  if (process.platform !== 'win32') return run('npm', args, options);
  const npmCli = String(process.env.npm_execpath || '').trim();
  assert(npmCli && fs.existsSync(npmCli), 'On Windows, create the bundle through npm run release:bundle');
  return run(process.execPath, [npmCli, ...args], options);
}

function normalizeFullSha(value, label = 'release SHA') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  assert(FULL_SHA.test(normalized), `${label} must be a full 40-character Git SHA`);
  return normalized;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
  }
}

export function readReleasePolicy(filePath) {
  const policy = readJson(filePath, 'Release policy');
  assert(policy?.schema === 1, 'Unsupported release policy schema');
  assert(/^[a-z0-9][a-z0-9_-]+$/i.test(policy.projectName), 'Unsafe Compose project name in release policy');
  assert(
    Array.isArray(policy.applicationServices) && policy.applicationServices.length === 3,
    'Release policy must define three application services'
  );
  assert(policy.applicationServices.includes('mbl-web'), 'Release policy is missing mbl-web');
  assert(policy.applicationServices.includes('mbl-worker-trigger'), 'Release policy is missing mbl-worker-trigger');
  assert(policy.applicationServices.includes('mbl-nginx'), 'Release policy is missing mbl-nginx');
  assert(
    JSON.stringify(policy.statefulServices) === JSON.stringify(['mbl-redis']),
    'Redis must be the only stateful service'
  );
  assert(policy.dataContractVersion === 1, 'Unsupported Redis data contract version');
  assert(
    JSON.stringify([...policy.applicationServices].sort()) === JSON.stringify([...APPLICATION_SERVICES].sort()),
    'Release policy application services differ from the approved application layer'
  );
  assert(
    Array.isArray(policy.expectedServices) &&
      JSON.stringify([...policy.expectedServices].sort()) ===
        JSON.stringify([...APPLICATION_SERVICES, 'mbl-redis'].sort()),
    'Release policy expected services differ from the approved runtime envelope'
  );
  assert(policy.redisDataDestination === '/data', 'Redis data destination must remain /data');
  assert(
    Array.isArray(policy.composeFiles) &&
      JSON.stringify(policy.composeFiles) ===
        JSON.stringify(['compose.production.yml', 'compose.backup.yml', 'compose.release.yml']),
    'Release policy Compose file order is not approved'
  );
  assert(
    Array.isArray(policy.smokePaths) && policy.smokePaths.includes('/health/ready'),
    'Release policy must smoke readiness'
  );
  return policy;
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function walkBundle(root) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      assert(!stat.isSymbolicLink(), `Release bundle contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) result.push({ absolute, relative });
      else throw new Error(`Unsupported release bundle entry: ${relative}`);
    }
  }
  return result.sort((left, right) => left.relative.localeCompare(right.relative));
}

export function writeReleaseChecksums(bundleDir) {
  const files = walkBundle(bundleDir).filter((entry) => entry.relative !== CHECKSUM_FILE);
  const lines = files.map((entry) => `${sha256File(entry.absolute)}  ${entry.relative}`);
  fs.writeFileSync(path.join(bundleDir, CHECKSUM_FILE), `${lines.join('\n')}\n`, { mode: 0o600 });
}

function readChecksums(bundleDir) {
  const checksumPath = path.join(bundleDir, CHECKSUM_FILE);
  assert(fs.existsSync(checksumPath), `${CHECKSUM_FILE} is missing`);
  const entries = new Map();
  for (const line of fs.readFileSync(checksumPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64}) {2}([^\r\n]+)$/i);
    assert(match, `Malformed checksum line: ${line}`);
    assert(!entries.has(match[2]), `Duplicate checksum entry: ${match[2]}`);
    entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

function assertNoSecretLikeFiles(files) {
  for (const { relative } of files) {
    assert(
      !/(^|\/)(?:\.env|prod\.env|secrets?)(?:\/|$)/i.test(relative),
      `Secret-like path is forbidden in release bundle: ${relative}`
    );
    assert(
      !/\.(?:pem|key|crt|p12)$/i.test(relative),
      `Private key material is forbidden in release bundle: ${relative}`
    );
  }
}

export function verifyReleaseBundle(bundleDirectory) {
  const bundleDir = path.resolve(bundleDirectory);
  assert(fs.existsSync(bundleDir) && fs.statSync(bundleDir).isDirectory(), 'Release bundle directory is missing');
  const files = walkBundle(bundleDir);
  assertNoSecretLikeFiles(files);
  const checksums = readChecksums(bundleDir);
  const regular = files.filter((entry) => entry.relative !== CHECKSUM_FILE);
  assert(checksums.size === regular.length, 'Every release bundle file must be covered by SHA256SUMS');
  for (const entry of regular) {
    assert(checksums.has(entry.relative), `File is not covered by SHA256SUMS: ${entry.relative}`);
    assert(sha256File(entry.absolute) === checksums.get(entry.relative), `Checksum mismatch: ${entry.relative}`);
  }

  const manifest = readJson(path.join(bundleDir, MANIFEST_FILE), 'Release manifest');
  assert(manifest?.schema === RELEASE_SCHEMA, 'Unsupported release manifest schema');
  const releaseId = normalizeFullSha(manifest.releaseId);
  assert(normalizeFullSha(manifest.gitSha, 'manifest Git SHA') === releaseId, 'Manifest releaseId and gitSha differ');
  const policy = readReleasePolicy(path.join(bundleDir, 'config', 'release-policy.json'));
  assert(
    manifest.dataContractVersion === policy.dataContractVersion,
    'Manifest and policy data-contract versions differ'
  );
  for (const name of ['web', 'nginx', 'backup']) {
    const image = manifest.images?.[name];
    assert(image?.ref === `${policy.imageRepositories[name]}:${releaseId}`, `Unexpected ${name} image reference`);
    assert(/^sha256:[a-f0-9]{64}$/i.test(image?.id || ''), `Missing immutable ${name} image ID`);
    assert(image?.revision === releaseId, `${name} OCI revision label does not match release`);
  }
  for (const relative of [
    'images/app-images.tar',
    'images/ops-images.tar',
    'compose.production.yml',
    'compose.backup.yml',
    'compose.release.yml',
    'scripts/release-tool.mjs',
    'docs/release-and-rollback.md',
  ]) {
    assert(fs.existsSync(path.join(bundleDir, ...relative.split('/'))), `Required bundle file is missing: ${relative}`);
  }
  return { bundleDir, manifest, policy, checksums };
}

function inspectImage(reference) {
  const payload = runJson('docker', ['image', 'inspect', reference]);
  assert(Array.isArray(payload) && payload.length === 1, `Unable to inspect image ${reference}`);
  const image = payload[0];
  return {
    ref: reference,
    id: image.Id,
    revision: image?.Config?.Labels?.['org.opencontainers.image.revision'] || '',
    os: image.Os,
    architecture: image.Architecture,
  };
}

function assertBuiltImage(image, releaseId, label) {
  assert(/^sha256:[a-f0-9]{64}$/i.test(image.id), `${label} image has no immutable ID`);
  assert(image.revision === releaseId, `${label} image OCI revision label does not match release`);
  assert(image.os === 'linux', `${label} image must target Linux`);
  assert(
    ['amd64', 'arm64'].includes(image.architecture),
    `${label} image has unsupported architecture ${image.architecture}`
  );
}

function copyFileIntoBundle(source, bundleDir, relative) {
  const target = path.join(bundleDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function assertCleanReleaseCheckout(expectedSha = '') {
  const head = normalizeFullSha(run('git', ['rev-parse', 'HEAD']).stdout);
  if (expectedSha) assert(head === normalizeFullSha(expectedSha), 'Git HEAD changed during release bundle creation');
  const status = run('git', ['status', '--porcelain', '--untracked-files=all']).stdout;
  assert(!status, 'Release bundle must be built from a clean committed working tree');
  return head;
}

function createImmutableBuildContext(releaseId) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-release-source-'));
  const archivePath = path.join(temporaryRoot, 'source.tar');
  const contextDirectory = path.join(temporaryRoot, 'context');
  fs.mkdirSync(contextDirectory);
  try {
    run('git', ['archive', '--format=tar', `--output=${archivePath}`, releaseId], { timeoutMs: 10 * 60_000 });
    run('tar', ['--extract', '--file', archivePath, '--directory', contextDirectory], {
      timeoutMs: 10 * 60_000,
    });
    fs.rmSync(archivePath, { force: true });
    return { temporaryRoot, contextDirectory };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function removeImmutableBuildContext(temporaryRoot) {
  const resolved = path.resolve(temporaryRoot);
  assert(
    path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('mbl-release-source-'),
    `Refusing to remove unsafe release source directory: ${resolved}`
  );
  fs.rmSync(resolved, { recursive: true, force: true });
}

export function createReleaseBundle(options = {}) {
  const releaseId = assertCleanReleaseCheckout();
  const publicSiteUrl = String(options.publicSiteUrl || process.env.PUBLIC_SITE_URL || '').replace(/\/+$/, '');
  assert(/^https:\/\//i.test(publicSiteUrl), 'PUBLIC_SITE_URL must be the canonical HTTPS origin');
  const policyRelative = String(options.policyPath || 'config/release-policy.json').replaceAll('\\', '/');
  assert(
    !path.isAbsolute(policyRelative) && !policyRelative.split('/').includes('..'),
    'Release policy must be inside Git'
  );
  const immutableSource = createImmutableBuildContext(releaseId);
  let bundleDir = '';
  try {
    const policyPath = path.join(immutableSource.contextDirectory, ...policyRelative.split('/'));
    const policy = readReleasePolicy(policyPath);
    const outputRoot = path.resolve(ROOT, options.output || 'releases');
    bundleDir = path.join(outputRoot, releaseId);
    assert(!fs.existsSync(bundleDir), `Release bundle already exists: ${bundleDir}`);
    fs.mkdirSync(path.join(bundleDir, 'images'), { recursive: true });

    const imageRefs = {
      web: `${policy.imageRepositories.web}:${releaseId}`,
      nginx: `${policy.imageRepositories.nginx}:${releaseId}`,
      backup: `${policy.imageRepositories.backup}:${releaseId}`,
    };

    for (const [name, target] of [
      ['web', 'web-runtime'],
      ['nginx', 'nginx-runtime'],
      ['backup', 'backup-runtime'],
    ]) {
      run(
        'docker',
        [
          'build',
          '--pull=false',
          '--target',
          target,
          '--build-arg',
          `MBL_BUILD_REVISION=${releaseId}`,
          '--build-arg',
          `PUBLIC_SITE_URL=${publicSiteUrl}`,
          '--tag',
          imageRefs[name],
          immutableSource.contextDirectory,
        ],
        { timeoutMs: 30 * 60_000 }
      );
    }

    const images = {
      web: inspectImage(imageRefs.web),
      nginx: inspectImage(imageRefs.nginx),
      backup: inspectImage(imageRefs.backup),
    };
    for (const [name, image] of Object.entries(images)) assertBuiltImage(image, releaseId, name);
    assert(images.web.architecture === images.nginx.architecture, 'Web and Nginx image architectures differ');
    assert(images.web.architecture === images.backup.architecture, 'Web and backup image architectures differ');

    if (!options.skipRuntimeGate) {
      runNpm(['run', 'check:compose-runtime'], {
        env: { ...process.env, O23_IMAGE_REVISION: releaseId, O23_SKIP_BUILD: '1' },
        timeoutMs: 30 * 60_000,
      });
    } else {
      assert(
        parseBoolean(process.env.MBL_RELEASE_ALLOW_SKIP_GATE, false),
        'Skipping the runtime gate requires MBL_RELEASE_ALLOW_SKIP_GATE=true'
      );
    }

    assertCleanReleaseCheckout(releaseId);

    run(
      'docker',
      ['save', '--output', path.join(bundleDir, 'images', 'app-images.tar'), imageRefs.web, imageRefs.nginx],
      {
        timeoutMs: 20 * 60_000,
      }
    );
    run('docker', ['save', '--output', path.join(bundleDir, 'images', 'ops-images.tar'), imageRefs.backup], {
      timeoutMs: 10 * 60_000,
    });

    for (const relative of policy.composeFiles) {
      copyFileIntoBundle(path.join(immutableSource.contextDirectory, relative), bundleDir, relative);
    }
    copyFileIntoBundle(policyPath, bundleDir, 'config/release-policy.json');
    copyFileIntoBundle(
      path.join(immutableSource.contextDirectory, 'scripts', 'release-tool.mjs'),
      bundleDir,
      'scripts/release-tool.mjs'
    );
    copyFileIntoBundle(
      path.join(immutableSource.contextDirectory, 'docs', 'release-and-rollback.md'),
      bundleDir,
      'docs/release-and-rollback.md'
    );

    const manifest = {
      schema: RELEASE_SCHEMA,
      releaseId,
      gitSha: releaseId,
      createdAt: new Date().toISOString(),
      canonicalOrigin: publicSiteUrl,
      dataContractVersion: policy.dataContractVersion,
      platform: `${images.web.os}/${images.web.architecture}`,
      images,
      archives: {
        application: 'images/app-images.tar',
        operations: 'images/ops-images.tar',
      },
    };
    fs.writeFileSync(path.join(bundleDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    writeReleaseChecksums(bundleDir);
    verifyReleaseBundle(bundleDir);
    console.log(JSON.stringify({ status: 'bundle-created', releaseId, bundleDir, images }, null, 2));
    return { bundleDir, manifest, policy };
  } catch (error) {
    if (bundleDir) fs.rmSync(bundleDir, { recursive: true, force: true });
    throw error;
  } finally {
    removeImmutableBuildContext(immutableSource.temporaryRoot);
  }
}

function assertPrivateEnvFile(envFile) {
  const resolved = path.resolve(envFile);
  assert(fs.existsSync(resolved) && fs.statSync(resolved).isFile(), 'Production env file is missing');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(resolved).mode & 0o777;
    assert((mode & 0o077) === 0, `Production env file must be mode 0600 or stricter, got ${mode.toString(8)}`);
  }
  for (const line of fs.readFileSync(resolved, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const secret = trimmed
      .slice(trimmed.indexOf('=') + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    if (secret.length >= 6) diagnosticSecrets.add(secret);
  }
  return resolved;
}

function currentBootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return `platform-${process.platform}`;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockOwner(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      const [legacyPid, createdAt] = raw.split(/\r?\n/);
      return { pid: Number(legacyPid), bootId: currentBootId(), createdAt, lockId: 'legacy' };
    }
  } catch {
    return null;
  }
}

function acquireLock(runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const lockPath = path.join(runtimeRoot, '.release.lock');
  const bootId = currentBootId();
  if (fs.existsSync(lockPath)) {
    const owner = readLockOwner(lockPath);
    if (owner && owner.bootId === bootId && processIsAlive(Number(owner.pid))) {
      throw new Error(`Another release operation holds ${lockPath}`);
    }
    fs.rmSync(lockPath, { force: true });
  }

  const lock = { schema: 1, lockId: randomUUID(), pid: process.pid, bootId, createdAt: new Date().toISOString() };
  let handle;
  try {
    handle = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(lock)}\n`);
    fs.fsyncSync(handle);
  } catch {
    if (handle !== undefined) fs.closeSync(handle);
    throw new Error(`Another release operation holds ${lockPath}`);
  }
  return () => {
    try {
      fs.closeSync(handle);
    } finally {
      const owner = readLockOwner(lockPath);
      if (owner?.lockId === lock.lockId) fs.rmSync(lockPath, { force: true });
    }
  };
}

function fsyncParentDirectory(filePath) {
  if (process.platform === 'win32') return;
  let directory;
  try {
    directory = fs.openSync(path.dirname(filePath), 'r');
    fs.fsyncSync(directory);
  } finally {
    if (directory !== undefined) fs.closeSync(directory);
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  const handle = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  let lastError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fs.renameSync(temporary, filePath);
      fsyncParentDirectory(filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw lastError;
}

function readState(runtimeRoot) {
  const statePath = path.join(runtimeRoot, 'release-state.json');
  if (!fs.existsSync(statePath)) return { path: statePath, value: null };
  const value = readJson(statePath, 'Release state');
  assert(value?.schema === STATE_SCHEMA, 'Unsupported release state schema');
  return { path: statePath, value };
}

function operationJournalPath(runtimeRoot) {
  return path.join(runtimeRoot, 'release-operation.json');
}

function readOperationJournal(runtimeRoot) {
  const journalPath = operationJournalPath(runtimeRoot);
  if (!fs.existsSync(journalPath)) return { path: journalPath, value: null };
  const value = readJson(journalPath, 'Release operation journal');
  assert(value?.schema === 1 && value?.operationId, 'Unsupported release operation journal');
  return { path: journalPath, value };
}

function writeOperationJournal(runtimeRoot, value) {
  atomicWriteJson(operationJournalPath(runtimeRoot), {
    ...value,
    schema: 1,
    updatedAt: new Date().toISOString(),
  });
}

function clearOperationJournal(runtimeRoot) {
  const journalPath = operationJournalPath(runtimeRoot);
  fs.rmSync(journalPath, { force: true });
  fsyncParentDirectory(journalPath);
}

function activeReleaseLinkPath(runtimeRoot) {
  return path.join(runtimeRoot, 'current');
}

function assertReplaceableActiveReleaseLink(linkPath) {
  if (!fs.existsSync(linkPath)) return;
  const stat = fs.lstatSync(linkPath);
  assert(stat.isSymbolicLink(), `Active release path must be a symbolic link: ${linkPath}`);
}

export function syncActiveReleaseLink(runtimeRoot, releaseId) {
  const normalizedReleaseId = normalizeFullSha(releaseId, 'active release ID');
  const releasesRoot = path.join(runtimeRoot, 'releases');
  const target = path.join(releasesRoot, normalizedReleaseId);
  assert(fs.statSync(target).isDirectory(), `Active release bundle is missing: ${target}`);

  const linkPath = activeReleaseLinkPath(runtimeRoot);
  assertReplaceableActiveReleaseLink(linkPath);
  const temporary = `${linkPath}.${process.pid}.${randomUUID()}.tmp`;
  const previous = `${linkPath}.${process.pid}.${randomUUID()}.previous`;
  const linkTarget = process.platform === 'win32' ? target : path.relative(runtimeRoot, target);
  fs.symlinkSync(linkTarget, temporary, process.platform === 'win32' ? 'junction' : 'dir');

  try {
    if (process.platform === 'win32' && fs.existsSync(linkPath)) {
      fs.renameSync(linkPath, previous);
      try {
        fs.renameSync(temporary, linkPath);
      } catch (error) {
        fs.renameSync(previous, linkPath);
        throw error;
      }
      fs.rmSync(previous, { force: true });
    } else {
      fs.renameSync(temporary, linkPath);
    }
    fsyncParentDirectory(linkPath);
  } finally {
    fs.rmSync(temporary, { force: true });
    fs.rmSync(previous, { force: true });
  }

  const resolved = fs.realpathSync(linkPath);
  assert(
    path.resolve(resolved) === path.resolve(target),
    'Active release link does not resolve to the committed release'
  );
  return linkPath;
}

function clearActiveReleaseLink(runtimeRoot) {
  const linkPath = activeReleaseLinkPath(runtimeRoot);
  if (!fs.existsSync(linkPath)) return;
  assertReplaceableActiveReleaseLink(linkPath);
  fs.rmSync(linkPath, { force: true });
  fsyncParentDirectory(linkPath);
}

export function assertBundleMatchesRecord(bundle, record, label) {
  assert(record?.releaseId === bundle.manifest.releaseId, `${label} release ID does not match its stored bundle`);
  assert(
    record.dataContractVersion === bundle.manifest.dataContractVersion,
    `${label} data-contract version does not match its stored bundle`
  );
  for (const name of ['web', 'nginx', 'backup']) {
    assert(record.images?.[name]?.id === bundle.manifest.images[name].id, `${label} ${name} image ID does not match`);
    assert(
      record.images?.[name]?.ref === bundle.manifest.images[name].ref,
      `${label} ${name} image tag does not match`
    );
  }
}

function storeBundle(bundle, runtimeRoot) {
  const releasesRoot = path.join(runtimeRoot, 'releases');
  const target = path.join(releasesRoot, bundle.manifest.releaseId);
  if (path.resolve(bundle.bundleDir) === path.resolve(target)) return bundle;
  if (fs.existsSync(target)) {
    const existing = verifyReleaseBundle(target);
    assertBundleMatchesRecord(existing, bundle.manifest, 'Existing release');
    return existing;
  }
  fs.mkdirSync(releasesRoot, { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.cpSync(bundle.bundleDir, temporary, { recursive: true, errorOnExist: true });
  verifyReleaseBundle(temporary);
  fs.renameSync(temporary, target);
  return verifyReleaseBundle(target);
}

function loadBundleImages(bundle, includeOperations = false) {
  run('docker', ['load', '--input', path.join(bundle.bundleDir, bundle.manifest.archives.application)], {
    timeoutMs: 20 * 60_000,
  });
  if (includeOperations) {
    run('docker', ['load', '--input', path.join(bundle.bundleDir, bundle.manifest.archives.operations)], {
      timeoutMs: 10 * 60_000,
    });
  }
  for (const [name, expected] of Object.entries(bundle.manifest.images)) {
    if (name === 'backup' && !includeOperations) continue;
    const actual = inspectImage(expected.ref);
    assert(actual.id === expected.id, `${name} tag points to an unexpected image ID`);
    assert(actual.revision === bundle.manifest.releaseId, `${name} loaded image has an unexpected revision label`);
  }
}

function composeController(bundle, envFile) {
  const base = ['compose', '--project-name', bundle.policy.projectName, '--env-file', envFile];
  for (const relative of bundle.policy.composeFiles) base.push('--file', path.join(bundle.bundleDir, relative));
  const env = {
    ...process.env,
    MBL_IMAGE_TAG: bundle.manifest.releaseId,
    MBL_ENV_FILE: path.resolve(envFile),
  };
  return {
    invoke(args, options = {}) {
      return run('docker', [...base, ...args], { ...options, env }).stdout;
    },
    containerId(service) {
      return this.invoke(['ps', '--quiet', service]).trim();
    },
  };
}

function preflightCompose(bundle, compose) {
  const services = compose.invoke(['config', '--services']).split(/\r?\n/).filter(Boolean).sort();
  assert(
    JSON.stringify(services) === JSON.stringify([...bundle.policy.expectedServices].sort()),
    `Resolved Compose services differ from release policy: ${services.join(', ')}`
  );
  const config = JSON.parse(compose.invoke(['config', '--format', 'json']));
  for (const service of bundle.policy.applicationServices) {
    assert(!config.services?.[service]?.build, `${service} still contains a build definition on the VPS`);
    assert(config.services?.[service]?.pull_policy === 'never', `${service} must use pull_policy=never`);
  }
  assert(
    config.services?.['mbl-redis']?.pull_policy === 'never',
    'Redis must use pull_policy=never during release operations'
  );
  const expectedImages = {
    'mbl-web': bundle.manifest.images.web.ref,
    'mbl-worker-trigger': bundle.manifest.images.web.ref,
    'mbl-nginx': bundle.manifest.images.nginx.ref,
  };
  for (const [service, image] of Object.entries(expectedImages)) {
    assert(config.services?.[service]?.image === image, `${service} does not resolve to the manifest image tag`);
  }
  const backupConfig = JSON.parse(compose.invoke(['--profile', 'backup', 'config', '--format', 'json']));
  assert(
    backupConfig.services?.['mbl-backup']?.image === bundle.manifest.images.backup.ref,
    'mbl-backup does not resolve to the manifest image tag'
  );
  assert(!backupConfig.services?.['mbl-backup']?.build, 'mbl-backup still contains a build definition on the VPS');
  assert(backupConfig.services?.['mbl-backup']?.pull_policy === 'never', 'mbl-backup must use pull_policy=never');
  const redisMounts = (config.services?.['mbl-redis']?.volumes || []).filter(
    (mount) => mount.type === 'volume' && mount.target === bundle.policy.redisDataDestination
  );
  assert(redisMounts.length === 1, 'Redis must resolve exactly one named /data volume');
  assert(config.volumes?.[redisMounts[0].source]?.external === true, 'Production Redis volume must remain external');
  for (const [service, value] of Object.entries(config.services || {})) {
    const ports = Array.isArray(value.ports) ? value.ports : [];
    if (service === 'mbl-nginx') assert(ports.length === 1, 'Nginx must have exactly one public port');
    else assert(ports.length === 0, `${service} must not publish a host port`);
  }
}

function inspectContainer(containerId, label) {
  assert(containerId, `${label} container is not running`);
  const values = runJson('docker', ['inspect', containerId]);
  assert(Array.isArray(values) && values.length === 1, `Unable to inspect ${label} container`);
  return values[0];
}

function captureRedisIdentity(compose, policy) {
  const container = inspectContainer(compose.containerId('mbl-redis'), 'Redis');
  const mounts = (container.Mounts || []).filter((mount) => mount.Destination === policy.redisDataDestination);
  assert(mounts.length === 1 && mounts[0].Type === 'volume', 'Redis must have exactly one named volume at /data');
  return { containerId: container.Id, imageId: container.Image, volumeName: mounts[0].Name };
}

export function assertRedisIdentityUnchanged(before, after) {
  assert(before.containerId === after.containerId, 'Release operation recreated the Redis container');
  assert(before.imageId === after.imageId, 'Release operation changed the Redis image');
  assert(before.volumeName === after.volumeName, 'Release operation changed the Redis volume');
}

function assertRedisStateCompatible(state, current) {
  if (!state?.redisIdentity) return;
  assert(state.redisIdentity.imageId === current.imageId, 'Redis image drifted since the last successful release');
  assert(
    state.redisIdentity.volumeName === current.volumeName,
    'Redis volume drifted since the last successful release'
  );
}

export function assertSafeApplicationComposeArgs(args, policy) {
  assert(Array.isArray(args) && args.length >= 2, 'Release Compose operation is incomplete');
  assert(!args.includes('mbl-redis'), 'Application release operation must never target mbl-redis');
  const command = args[0];
  const services = args.filter((item) => policy.expectedServices.includes(item));
  assert(services.length >= 1, 'Release Compose operation must name an application service');
  for (const service of services) {
    assert(
      policy.applicationServices.includes(service),
      `Release operation targets non-application service: ${service}`
    );
  }
  if (command === 'stop') {
    assert(args.length === services.length + 1, `Unexpected option in application stop: ${args.join(' ')}`);
    return;
  }
  assert(command === 'up', `Forbidden release Compose operation: ${args.join(' ')}`);
  for (const required of ['-d', '--no-deps', '--no-build']) {
    assert(args.includes(required), `Application update is missing ${required}`);
  }
  const pullIndex = args.indexOf('--pull');
  assert(pullIndex >= 0 && args[pullIndex + 1] === 'never', 'Application update must use --pull never');
  const allowed = new Set(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', ...policy.applicationServices]);
  for (const item of args) assert(allowed.has(item), `Unexpected application update argument: ${item}`);
}

function mutateApplication(compose, policy, args, options) {
  assertSafeApplicationComposeArgs(args, policy);
  return compose.invoke(args, options);
}

async function waitForContainerHealth(compose, service, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const id = compose.containerId(service);
    if (id) {
      const container = inspectContainer(id, service);
      const state = container.State || {};
      if (state.Status === 'running' && (!state.Health || state.Health.Status === 'healthy')) return container;
      if (state.Status === 'exited' || state.Health?.Status === 'unhealthy') {
        throw new Error(`${service} became ${state.Health?.Status || state.Status}`);
      }
    }
    await delay(500);
  }
  throw new Error(`${service} did not become healthy within ${timeoutMs}ms`);
}

async function fetchOk(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function publicSmoke(baseUrl, paths, timeoutMs) {
  for (const pathname of paths) {
    const startedAt = Date.now();
    let lastStatus = 0;
    let passed = false;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await fetchOk(`${baseUrl}${pathname}`);
        lastStatus = response.status;
        if (response.status === 200) {
          if (pathname === '/health/ready') {
            const payload = await response.json();
            assert(payload?.ok === true && payload?.status === 'ready', 'Readiness payload is not ready');
          }
          passed = true;
          break;
        }
      } catch {
        // Candidate may be between Nginx and web recreation; retry boundedly.
      }
      await delay(500);
    }
    assert(passed, `Release smoke failed for ${pathname}: HTTP ${lastStatus || 'unreachable'}`);
  }
}

async function waitForWorkerHeartbeat(compose, timeoutMs, workerStartedAt) {
  const notBeforeMs = Date.parse(workerStartedAt);
  assert(Number.isFinite(notBeforeMs), 'Worker container has no valid start timestamp');
  const probe = `
    const notBeforeMs = ${JSON.stringify(notBeforeMs)};
    const token = process.env.METRICS_ADMIN_TOKEN || '';
    fetch('http://127.0.0.1:4321/api/admin/health/worker', {headers:{authorization:'Bearer '+token}})
      .then(async (response) => ({response, body: await response.json().catch(()=>({}))}))
      .then(({response, body}) => {
        const heartbeat = body && body.runtime && body.runtime.heartbeat;
        const lastCycleMs = Date.parse(heartbeat?.value?.lastCycleAt || '');
        if (!response.ok || heartbeat?.state !== 'cycling' || heartbeat?.value?.status !== 'ok' || !Number.isFinite(lastCycleMs) || lastCycleMs < notBeforeMs) process.exit(1);
      })
      .catch(() => process.exit(1));
  `;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = run(
      'docker',
      ['exec', compose.containerId('mbl-web'), 'node', '--input-type=module', '--eval', probe],
      { allowFailure: true, timeoutMs: 10_000 }
    );
    if (result.status === 0) return;
    await delay(1000);
  }
  throw new Error(`Worker heartbeat did not become healthy within ${timeoutMs}ms`);
}

function assertApplicationImages(compose, manifest) {
  const web = inspectContainer(compose.containerId('mbl-web'), 'web');
  const worker = inspectContainer(compose.containerId('mbl-worker-trigger'), 'worker');
  const nginx = inspectContainer(compose.containerId('mbl-nginx'), 'nginx');
  assert(web.Image === manifest.images.web.id, 'Web container does not use the manifest image ID');
  assert(worker.Image === manifest.images.web.id, 'Worker container does not use the manifest web image ID');
  assert(nginx.Image === manifest.images.nginx.id, 'Nginx container does not use the manifest image ID');
}

async function switchApplication(bundle, envFile, baseUrl, timeoutMs, onPhase = () => {}) {
  const compose = composeController(bundle, envFile);
  preflightCompose(bundle, compose);
  const redisBefore = captureRedisIdentity(compose, bundle.policy);
  onPhase('worker-stopping');
  mutateApplication(compose, bundle.policy, ['stop', 'mbl-worker-trigger'], { allowFailure: true });
  onPhase('web-updating');
  mutateApplication(compose, bundle.policy, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'mbl-web'], {
    timeoutMs,
  });
  await waitForContainerHealth(compose, 'mbl-web', timeoutMs);
  onPhase('web-healthy');
  onPhase('nginx-updating');
  mutateApplication(compose, bundle.policy, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'mbl-nginx'], {
    timeoutMs,
  });
  await waitForContainerHealth(compose, 'mbl-nginx', timeoutMs);
  await publicSmoke(baseUrl, bundle.policy.smokePaths, timeoutMs);
  onPhase('edge-healthy');
  onPhase('worker-updating');
  mutateApplication(
    compose,
    bundle.policy,
    ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'mbl-worker-trigger'],
    { timeoutMs }
  );
  const worker = await waitForContainerHealth(compose, 'mbl-worker-trigger', timeoutMs);
  await waitForWorkerHeartbeat(compose, timeoutMs, worker.State.StartedAt);
  onPhase('worker-cycled');
  const redisAfter = captureRedisIdentity(compose, bundle.policy);
  assertRedisIdentityUnchanged(redisBefore, redisAfter);
  assertApplicationImages(compose, bundle.manifest);
  onPhase('application-verified');
  return redisAfter;
}

function releaseRecord(bundle) {
  return {
    releaseId: bundle.manifest.releaseId,
    appliedAt: new Date().toISOString(),
    dataContractVersion: bundle.manifest.dataContractVersion,
    images: bundle.manifest.images,
  };
}

function createOperationJournal(kind, candidate, stableRecord, redisIdentity) {
  return {
    schema: 1,
    operationId: randomUUID(),
    kind,
    phase: 'prepared',
    candidateReleaseId: candidate.manifest.releaseId,
    stableReleaseId: stableRecord?.releaseId || null,
    redisIdentityBefore: redisIdentity,
    startedAt: new Date().toISOString(),
  };
}

function operationPhaseWriter(runtimeRoot, journal) {
  return (phase) => {
    journal.phase = phase;
    writeOperationJournal(runtimeRoot, journal);
  };
}

function failureRecordPath(runtimeRoot) {
  return path.join(runtimeRoot, 'last-release-failure.json');
}

function writeFailureRecord(runtimeRoot, value) {
  atomicWriteJson(failureRecordPath(runtimeRoot), {
    schema: 1,
    occurredAt: new Date().toISOString(),
    ...value,
    error: redactReleaseDiagnostic(value.error || ''),
    recoveryError: redactReleaseDiagnostic(value.recoveryError || ''),
  });
}

async function stopApplicationLayer(bundle, envFile) {
  const compose = composeController(bundle, envFile);
  preflightCompose(bundle, compose);
  const redisBefore = captureRedisIdentity(compose, bundle.policy);
  mutateApplication(compose, bundle.policy, ['stop', ...bundle.policy.applicationServices], {
    allowFailure: true,
    timeoutMs: 60_000,
  });
  const running = bundle.policy.applicationServices.filter((service) => compose.containerId(service));
  assert(running.length === 0, `Unable to stop mixed application services: ${running.join(', ')}`);
  const redisAfter = captureRedisIdentity(compose, bundle.policy);
  assertRedisIdentityUnchanged(redisBefore, redisAfter);
  return redisAfter;
}

async function recoverStableApplication({ stable, envFile, baseUrl, timeoutMs }) {
  try {
    loadBundleImages(stable, false);
    const redisIdentity = await switchApplication(stable, envFile, baseUrl, timeoutMs);
    return { containment: 'stable-application-restored', redisIdentity, recoveryError: '' };
  } catch (recoveryError) {
    try {
      const redisIdentity = await stopApplicationLayer(stable, envFile);
      return {
        containment: 'application-layer-stopped',
        redisIdentity,
        recoveryError: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      };
    } catch (containmentError) {
      throw new Error(
        `Stable application recovery failed and application-layer containment could not be proven. Recovery: ${
          recoveryError instanceof Error ? recoveryError.message : recoveryError
        }. Containment: ${containmentError instanceof Error ? containmentError.message : containmentError}`
      );
    }
  }
}

async function reconcileInterruptedOperation({ runtimeRoot, envFile, baseUrl, timeoutMs }) {
  const pending = readOperationJournal(runtimeRoot);
  if (!pending.value) return false;

  const journal = pending.value;
  const state = readState(runtimeRoot);
  let desiredRecord = null;
  if (state.value?.current?.releaseId === journal.candidateReleaseId) desiredRecord = state.value.current;
  else if (journal.stableReleaseId && state.value?.current?.releaseId === journal.stableReleaseId) {
    desiredRecord = state.value.current;
  }

  let containment;
  let redisIdentity;
  let recoveryError = '';
  if (desiredRecord) {
    const desiredDir = path.join(runtimeRoot, 'releases', desiredRecord.releaseId);
    const desired = verifyReleaseBundle(desiredDir);
    assertBundleMatchesRecord(desired, desiredRecord, 'Interrupted operation recovery');
    const recovery = await recoverStableApplication({ stable: desired, envFile, baseUrl, timeoutMs });
    containment = recovery.containment;
    redisIdentity = recovery.redisIdentity;
    recoveryError = recovery.recoveryError;
    syncActiveReleaseLink(runtimeRoot, desiredRecord.releaseId);
  } else {
    const candidateDir = path.join(runtimeRoot, 'releases', journal.candidateReleaseId);
    const candidate = verifyReleaseBundle(candidateDir);
    assert(candidate.manifest.releaseId === journal.candidateReleaseId, 'Interrupted candidate bundle is misfiled');
    redisIdentity = await stopApplicationLayer(candidate, envFile);
    containment = 'application-layer-stopped';
    recoveryError = 'Operation journal and release state did not identify a committed application release';
    clearActiveReleaseLink(runtimeRoot);
  }

  assertRedisIdentityUnchanged(journal.redisIdentityBefore, redisIdentity);
  writeFailureRecord(runtimeRoot, {
    operation: `interrupted-${journal.kind}`,
    candidateReleaseId: journal.candidateReleaseId,
    stableReleaseId: desiredRecord?.releaseId || null,
    containment,
    redisIdentity,
    error: `Recovered interrupted phase ${journal.phase}`,
    recoveryError,
  });
  clearOperationJournal(runtimeRoot);
  throw new Error(
    `Interrupted ${journal.kind} operation was reconciled with containment=${containment}; rerun the requested command`
  );
}

function restoreStateSnapshot(state) {
  if (state.value) atomicWriteJson(state.path, state.value);
  else fs.rmSync(state.path, { force: true });
}

async function containFailedTransition({
  operation,
  candidate,
  stableRecord,
  runtimeRoot,
  envFile,
  baseUrl,
  timeoutMs,
  redisIdentityBefore,
  error,
}) {
  let recovery;
  if (stableRecord?.releaseId) {
    try {
      const stableDir = path.join(runtimeRoot, 'releases', stableRecord.releaseId);
      const stable = verifyReleaseBundle(stableDir);
      assertBundleMatchesRecord(stable, stableRecord, 'Stable release');
      recovery = await recoverStableApplication({ stable, envFile, baseUrl, timeoutMs });
      syncActiveReleaseLink(runtimeRoot, stableRecord.releaseId);
    } catch (recoveryFailure) {
      const redisIdentity = await stopApplicationLayer(candidate, envFile);
      try {
        clearActiveReleaseLink(runtimeRoot);
      } catch {
        // A missing link fails systemd maintenance safely; never leave a link
        // that can point at a failed candidate after containment.
      }
      recovery = {
        containment: 'application-layer-stopped',
        redisIdentity,
        recoveryError: recoveryFailure instanceof Error ? recoveryFailure.message : String(recoveryFailure),
      };
    }
  } else {
    const redisIdentity = await stopApplicationLayer(candidate, envFile);
    recovery = { containment: 'application-layer-stopped', redisIdentity, recoveryError: '' };
    clearActiveReleaseLink(runtimeRoot);
  }

  assertRedisIdentityUnchanged(redisIdentityBefore, recovery.redisIdentity);

  writeFailureRecord(runtimeRoot, {
    operation,
    candidateReleaseId: candidate.manifest.releaseId,
    stableReleaseId: stableRecord?.releaseId || null,
    containment: recovery.containment,
    redisIdentity: recovery.redisIdentity,
    error: error instanceof Error ? error.message : String(error),
    recoveryError: recovery.recoveryError,
  });
  clearOperationJournal(runtimeRoot);
  return recovery;
}

async function applyRelease({ bundleDirectory, runtimeRoot, envFile, baseUrl, timeoutMs = DEFAULT_WAIT_MS }) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const release = acquireLock(resolvedRuntimeRoot);
  try {
    const privateEnv = assertPrivateEnvFile(envFile);
    await reconcileInterruptedOperation({
      runtimeRoot: resolvedRuntimeRoot,
      envFile: privateEnv,
      baseUrl,
      timeoutMs,
    });
    const source = verifyReleaseBundle(bundleDirectory);
    const bundle = storeBundle(source, resolvedRuntimeRoot);
    const state = readState(resolvedRuntimeRoot);
    if (state.value?.current) {
      assert(
        state.value.current.dataContractVersion === bundle.manifest.dataContractVersion,
        'Candidate changes the Redis data contract and cannot use application rollback'
      );
      assert(state.value.current.releaseId !== bundle.manifest.releaseId, 'Candidate release is already active');
      const stable = verifyReleaseBundle(path.join(resolvedRuntimeRoot, 'releases', state.value.current.releaseId));
      assertBundleMatchesRecord(stable, state.value.current, 'Current release');
      syncActiveReleaseLink(resolvedRuntimeRoot, state.value.current.releaseId);
    } else {
      assert(
        !fs.existsSync(activeReleaseLinkPath(resolvedRuntimeRoot)),
        'Active release link exists without release state'
      );
    }
    loadBundleImages(bundle, true);
    const preflight = composeController(bundle, privateEnv);
    preflightCompose(bundle, preflight);
    const redisBefore = captureRedisIdentity(preflight, bundle.policy);
    assertRedisStateCompatible(state.value, redisBefore);
    const journal = createOperationJournal('apply', bundle, state.value?.current || null, redisBefore);
    writeOperationJournal(resolvedRuntimeRoot, journal);
    const onPhase = operationPhaseWriter(resolvedRuntimeRoot, journal);
    let redisIdentity;
    try {
      redisIdentity = await switchApplication(bundle, privateEnv, baseUrl, timeoutMs, onPhase);
    } catch (candidateError) {
      const recovery = await containFailedTransition({
        operation: state.value?.current ? 'apply' : 'initial-apply',
        candidate: bundle,
        stableRecord: state.value?.current || null,
        runtimeRoot: resolvedRuntimeRoot,
        envFile: privateEnv,
        baseUrl,
        timeoutMs,
        redisIdentityBefore: redisBefore,
        error: candidateError,
      });
      throw new Error(
        `Candidate ${bundle.manifest.releaseId} failed; containment=${recovery.containment}; stable release=${
          state.value?.current?.releaseId || 'none'
        }. ${candidateError instanceof Error ? candidateError.message : candidateError}`
      );
    }

    const nextState = {
      schema: STATE_SCHEMA,
      current: releaseRecord(bundle),
      previous: state.value?.current || null,
      redisIdentity,
      updatedAt: new Date().toISOString(),
    };
    try {
      onPhase('state-committing');
      atomicWriteJson(state.path, nextState);
      onPhase('active-link-committing');
      syncActiveReleaseLink(resolvedRuntimeRoot, nextState.current.releaseId);
    } catch (stateError) {
      restoreStateSnapshot(state);
      const recovery = await containFailedTransition({
        operation: 'apply-state-commit',
        candidate: bundle,
        stableRecord: state.value?.current || null,
        runtimeRoot: resolvedRuntimeRoot,
        envFile: privateEnv,
        baseUrl,
        timeoutMs,
        redisIdentityBefore: redisBefore,
        error: stateError,
      });
      throw new Error(`Release state commit failed; containment=${recovery.containment}`);
    }
    clearOperationJournal(resolvedRuntimeRoot);
    console.log(
      JSON.stringify(
        {
          status: 'applied',
          releaseId: bundle.manifest.releaseId,
          previous: nextState.previous?.releaseId || null,
          redisIdentity,
        },
        null,
        2
      )
    );
    return nextState;
  } finally {
    release();
  }
}

async function rollbackRelease({ runtimeRoot, envFile, baseUrl, timeoutMs = DEFAULT_WAIT_MS }) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const release = acquireLock(resolvedRuntimeRoot);
  try {
    const privateEnv = assertPrivateEnvFile(envFile);
    await reconcileInterruptedOperation({
      runtimeRoot: resolvedRuntimeRoot,
      envFile: privateEnv,
      baseUrl,
      timeoutMs,
    });
    const state = readState(resolvedRuntimeRoot);
    assert(state.value?.current?.releaseId, 'No current release is recorded');
    assert(state.value?.previous?.releaseId, 'No previous release is available for rollback');
    assert(
      state.value.current.dataContractVersion === state.value.previous.dataContractVersion,
      'Current and previous releases use different Redis data contracts'
    );
    const targetDir = path.join(resolvedRuntimeRoot, 'releases', state.value.previous.releaseId);
    const target = verifyReleaseBundle(targetDir);
    assertBundleMatchesRecord(target, state.value.previous, 'Rollback target');
    const stable = verifyReleaseBundle(path.join(resolvedRuntimeRoot, 'releases', state.value.current.releaseId));
    assertBundleMatchesRecord(stable, state.value.current, 'Current release');
    syncActiveReleaseLink(resolvedRuntimeRoot, state.value.current.releaseId);
    loadBundleImages(target, false);
    const compose = composeController(target, privateEnv);
    const redisBefore = captureRedisIdentity(compose, target.policy);
    assertRedisStateCompatible(state.value, redisBefore);
    const journal = createOperationJournal('rollback', target, state.value.current, redisBefore);
    writeOperationJournal(resolvedRuntimeRoot, journal);
    const onPhase = operationPhaseWriter(resolvedRuntimeRoot, journal);
    let redisIdentity;
    try {
      redisIdentity = await switchApplication(target, privateEnv, baseUrl, timeoutMs, onPhase);
    } catch (rollbackError) {
      const recovery = await containFailedTransition({
        operation: 'rollback',
        candidate: target,
        stableRecord: state.value.current,
        runtimeRoot: resolvedRuntimeRoot,
        envFile: privateEnv,
        baseUrl,
        timeoutMs,
        redisIdentityBefore: redisBefore,
        error: rollbackError,
      });
      throw new Error(
        `Rollback to ${target.manifest.releaseId} failed; containment=${recovery.containment}; stable release=${state.value.current.releaseId}. ${
          rollbackError instanceof Error ? rollbackError.message : rollbackError
        }`
      );
    }
    const nextState = {
      schema: STATE_SCHEMA,
      current: { ...state.value.previous, appliedAt: new Date().toISOString() },
      previous: state.value.current,
      redisIdentity,
      updatedAt: new Date().toISOString(),
    };
    try {
      onPhase('state-committing');
      atomicWriteJson(state.path, nextState);
      onPhase('active-link-committing');
      syncActiveReleaseLink(resolvedRuntimeRoot, nextState.current.releaseId);
    } catch (stateError) {
      restoreStateSnapshot(state);
      const recovery = await containFailedTransition({
        operation: 'rollback-state-commit',
        candidate: target,
        stableRecord: state.value.current,
        runtimeRoot: resolvedRuntimeRoot,
        envFile: privateEnv,
        baseUrl,
        timeoutMs,
        redisIdentityBefore: redisBefore,
        error: stateError,
      });
      throw new Error(`Rollback state commit failed; containment=${recovery.containment}`);
    }
    clearOperationJournal(resolvedRuntimeRoot);
    console.log(
      JSON.stringify(
        {
          status: 'rolled-back',
          releaseId: nextState.current.releaseId,
          rollForward: nextState.previous.releaseId,
          redisIdentity,
        },
        null,
        2
      )
    );
    return nextState;
  } finally {
    release();
  }
}

function normalizeOperationOptions(flags, includeBundle) {
  const runtimeRoot = String(flags['runtime-root'] || '').trim();
  const envFile = String(flags['env-file'] || '').trim();
  const rawBaseUrl = String(flags['base-url'] || '').replace(/\/+$/, '');
  const timeoutMs = Number(flags['timeout-ms'] || DEFAULT_WAIT_MS);
  assert(runtimeRoot, '--runtime-root is required');
  assert(envFile, '--env-file is required');
  assert(/^https?:\/\/[^\s]+$/i.test(rawBaseUrl), '--base-url must be an HTTP(S) origin');
  assert(Number.isFinite(timeoutMs) && timeoutMs >= 1000, '--timeout-ms must be at least 1000');
  const result = { runtimeRoot, envFile, baseUrl: rawBaseUrl, timeoutMs };
  if (includeBundle) {
    const bundleDirectory = String(flags.bundle || '').trim();
    assert(bundleDirectory, '--bundle is required');
    result.bundleDirectory = bundleDirectory;
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseCliArgs(argv);
  if (command === 'create-bundle') {
    return createReleaseBundle({
      output: flags.output,
      publicSiteUrl: flags['public-site-url'],
      skipRuntimeGate: flags['skip-runtime-gate'] === true,
    });
  }
  if (command === 'verify-bundle') {
    const bundleDirectory = String(flags.bundle || '').trim();
    assert(bundleDirectory, '--bundle is required');
    const bundle = verifyReleaseBundle(bundleDirectory);
    console.log(
      JSON.stringify({ status: 'verified', releaseId: bundle.manifest.releaseId, bundleDir: bundle.bundleDir }, null, 2)
    );
    return bundle;
  }
  if (command === 'apply') {
    return applyRelease(normalizeOperationOptions(flags, true));
  }
  if (command === 'rollback') {
    return rollbackRelease(normalizeOperationOptions(flags, false));
  }
  throw new Error('Usage: release-tool.mjs <create-bundle|verify-bundle|apply|rollback> [options]');
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`[release] FAIL ${redactReleaseDiagnostic(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  });
}

export { applyRelease, rollbackRelease };
