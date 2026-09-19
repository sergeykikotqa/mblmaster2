import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const PREFIX = `mbl-o24-backup-gate-${randomBytes(4).toString('hex')}`;
const NETWORK = `${PREFIX}-network`;
const SOURCE_CONTAINER = `${PREFIX}-source`;
const RESTORED_CONTAINER = `${PREFIX}-restored`;
const SOURCE_VOLUME = `${PREFIX}-source-data`;
const RESTORED_VOLUME = `${PREFIX}-restored-data`;
const IMAGE = `mbl-backup:${PREFIX}`;
const REDIS_IMAGE = 'redis:7.4.7-alpine3.21';
const TIMEOUT_MS = 10 * 60_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: options.env || process.env,
    encoding: options.encoding === null ? null : 'utf8',
    timeout: options.timeoutMs || TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = options.encoding === null ? result.stdout : String(result.stdout || '').trim();
  const stderr = options.encoding === null ? result.stderr : String(result.stderr || '').trim();
  const status = Number.isInteger(result.status) ? result.status : 1;
  if (!options.allowFailure && (result.error || status !== 0)) {
    const detail = [result.error?.message, stdout, stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed with exit ${status}${detail ? `\n${detail}` : ''}`);
  }
  return { status, stdout, stderr };
}

function docker(args, options) {
  return run('docker', args, options);
}

function assertSafeResourceName(value) {
  assert(value.startsWith('mbl-o24-backup-gate-'), `Refusing to mutate unsafe Docker resource: ${value}`);
  return value;
}

function writeSecret(filePath, value) {
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
}

function bind(source, target, readOnly = false) {
  const suffix = readOnly ? ',readonly' : '';
  return `type=bind,src=${source},dst=${target}${suffix}`;
}

function backupRunArgs(paths, envPairs, commandArgs) {
  const args = [
    'run',
    '--rm',
    '--network',
    NETWORK,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,size=256m,mode=1777',
    '--mount',
    bind(paths.secrets, '/run/mbl-backup-secrets', true),
    '--mount',
    bind(paths.repository, '/repository'),
    '--mount',
    bind(paths.status, '/status'),
    '--mount',
    bind(paths.restore, '/restore'),
  ];
  const commonEnv = {
    MBL_BACKUP_REPOSITORY_FILE: '/run/mbl-backup-secrets/repository',
    MBL_BACKUP_PASSWORD_FILE: '/run/mbl-backup-secrets/password',
    MBL_BACKUP_ALLOW_LOCAL_REPOSITORY: 'true',
    MBL_BACKUP_RELEASE_SHA: paths.releaseSha,
    MBL_BACKUP_REDIS_HOST: SOURCE_CONTAINER,
    MBL_BACKUP_REDIS_PORT: '6379',
    MBL_BACKUP_HOST: PREFIX,
    MBL_BACKUP_STATUS_DIR: '/status',
    MBL_BACKUP_RESTORE_ROOT: '/restore',
    ...envPairs,
  };
  for (const [key, value] of Object.entries(commonEnv)) args.push('--env', `${key}=${value}`);
  args.push(IMAGE, ...commandArgs);
  return args;
}

function waitForRedis(container, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = docker(['exec', container, 'redis-cli', '--raw', 'PING'], { allowFailure: true });
    if (result.status === 0 && result.stdout === 'PONG') return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`Redis did not become ready: ${container}`);
}

function redis(container, ...args) {
  return docker(['exec', container, 'redis-cli', '--raw', ...args]).stdout;
}

function repositoryContains(repositoryRoot, needle) {
  const expected = Buffer.from(needle);
  const pending = [repositoryRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(resolved);
      else if (entry.isFile() && fs.readFileSync(resolved).includes(expected)) return true;
    }
  }
  return false;
}

function cleanup(tempRoot) {
  for (const container of [SOURCE_CONTAINER, RESTORED_CONTAINER]) {
    assertSafeResourceName(container);
    docker(['rm', '-f', container], { allowFailure: true, timeoutMs: 60_000 });
  }
  for (const volume of [SOURCE_VOLUME, RESTORED_VOLUME]) {
    assertSafeResourceName(volume);
    docker(['volume', 'rm', '-f', volume], { allowFailure: true, timeoutMs: 60_000 });
  }
  assertSafeResourceName(NETWORK);
  docker(['network', 'rm', NETWORK], { allowFailure: true, timeoutMs: 60_000 });
  assert(IMAGE.includes(PREFIX), `Refusing to remove unsafe image: ${IMAGE}`);
  docker(['image', 'rm', '-f', IMAGE], { allowFailure: true, timeoutMs: 120_000 });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function main() {
  docker(['version', '--format', '{{.Server.Version}}']);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}-`));
  const paths = {
    secrets: path.join(tempRoot, 'secrets'),
    repository: path.join(tempRoot, 'repository'),
    status: path.join(tempRoot, 'status'),
    restore: path.join(tempRoot, 'restore'),
    releaseSha: run('git', ['rev-parse', 'HEAD']).stdout,
  };
  for (const directory of [paths.secrets, paths.repository, paths.status, paths.restore]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const repositoryPassword = `repo-${randomBytes(32).toString('hex')}`;
  const deliveredValue = `delivered-${randomBytes(16).toString('hex')}`;
  const pendingValue = `pending-${randomBytes(16).toString('hex')}`;
  const idempotencyValue = `idempotency-${randomBytes(16).toString('hex')}`;
  writeSecret(path.join(paths.secrets, 'repository'), '/repository/restic');
  writeSecret(path.join(paths.secrets, 'password'), repositoryPassword);

  const evidence = { project: PREFIX, image: IMAGE, sourceDeletedBeforeRestore: false };
  try {
    docker(
      [
        'build',
        '--target',
        'backup-runtime',
        '--build-arg',
        `MBL_BUILD_REVISION=${paths.releaseSha}`,
        '--tag',
        IMAGE,
        '.',
      ],
      { timeoutMs: 20 * 60_000 }
    );
    docker(['network', 'create', NETWORK]);
    docker(['volume', 'create', SOURCE_VOLUME]);
    docker([
      'run',
      '-d',
      '--name',
      SOURCE_CONTAINER,
      '--network',
      NETWORK,
      '--mount',
      `type=volume,src=${SOURCE_VOLUME},dst=/data`,
      REDIS_IMAGE,
      'redis-server',
      '--appendonly',
      'yes',
      '--appendfsync',
      'everysec',
      '--dir',
      '/data',
    ]);
    waitForRedis(SOURCE_CONTAINER);

    redis(SOURCE_CONTAINER, 'SET', `${PREFIX}:lead:delivered`, deliveredValue);
    redis(SOURCE_CONTAINER, 'SET', `${PREFIX}:lead:pending`, pendingValue);
    redis(SOURCE_CONTAINER, 'SET', `${PREFIX}:idempotency`, idempotencyValue, 'EX', '3600');
    redis(SOURCE_CONTAINER, 'ZADD', `${PREFIX}:delivery:queue`, '1700000000000', 'lead-pending');
    redis(SOURCE_CONTAINER, 'HSET', `${PREFIX}:lead-state`, 'status', 'pending', 'attempts', '2');

    const init = docker(backupRunArgs(paths, { MBL_BACKUP_INIT_CONFIRM: 'INITIALIZE_EMPTY_REPOSITORY' }, ['init']));
    const backup = docker(backupRunArgs(paths, {}, ['backup']));
    const check = docker(backupRunArgs(paths, { MBL_BACKUP_CHECK_READ_ALL: 'true' }, ['check']), {
      timeoutMs: 20 * 60_000,
    });
    const list = docker(backupRunArgs(paths, {}, ['list']));
    const snapshots = JSON.parse(list.stdout);
    assert(
      Array.isArray(snapshots) && snapshots.length === 1,
      'Snapshot listing did not return exactly one Restic snapshot'
    );
    assert(fs.existsSync(path.join(paths.status, 'last-success.json')), 'Backup success checkpoint was not written');
    assert(
      !repositoryContains(paths.repository, deliveredValue),
      'Encrypted repository contains delivered lead plaintext'
    );
    assert(!repositoryContains(paths.repository, pendingValue), 'Encrypted repository contains pending lead plaintext');
    assert(
      !repositoryContains(paths.repository, idempotencyValue),
      'Encrypted repository contains idempotency plaintext'
    );
    assert(!repositoryContains(paths.repository, 'REDIS0012'), 'Encrypted repository exposes raw RDB bytes');

    docker(['rm', '-f', SOURCE_CONTAINER]);
    docker(['volume', 'rm', SOURCE_VOLUME]);
    evidence.sourceDeletedBeforeRestore = true;

    const originalPassword = fs.readFileSync(path.join(paths.secrets, 'password'), 'utf8');
    writeSecret(path.join(paths.secrets, 'password'), `wrong-${randomBytes(24).toString('hex')}`);
    const wrongPassword = docker(
      backupRunArgs(paths, { MBL_BACKUP_RESTORE_CONFIRM: 'RESTORE_TO_ISOLATED_DIRECTORY' }, [
        'restore',
        '--snapshot',
        'latest',
        '--target',
        '/restore/wrong-password',
      ]),
      { allowFailure: true }
    );
    assert(wrongPassword.status !== 0, 'Restore unexpectedly succeeded with a wrong repository password');
    assert(
      !fs.existsSync(path.join(paths.restore, 'wrong-password', 'dump.rdb')),
      'Wrong-password restore wrote an RDB'
    );
    fs.writeFileSync(path.join(paths.secrets, 'password'), originalPassword, { mode: 0o600 });

    const restoreStartedAt = Date.now();
    const restore = docker(
      backupRunArgs(paths, { MBL_BACKUP_RESTORE_CONFIRM: 'RESTORE_TO_ISOLATED_DIRECTORY' }, [
        'restore',
        '--snapshot',
        'latest',
        '--target',
        '/restore/drill',
      ]),
      { timeoutMs: 20 * 60_000 }
    );
    evidence.restoreDurationMs = Date.now() - restoreStartedAt;
    const restoredRdb = path.join(paths.restore, 'drill', 'dump.rdb');
    assert(fs.existsSync(restoredRdb), 'Restore did not produce a validated RDB');

    const corruptDir = path.join(paths.restore, 'corrupt');
    fs.mkdirSync(corruptDir);
    const corruptRdb = path.join(corruptDir, 'dump.rdb');
    const bytes = fs.readFileSync(restoredRdb);
    bytes[Math.max(16, Math.floor(bytes.length / 2))] ^= 0xff;
    fs.writeFileSync(corruptRdb, bytes);
    const corruptCheck = docker(
      [
        'run',
        '--rm',
        '--entrypoint',
        'redis-check-rdb',
        '--mount',
        bind(corruptDir, '/restore', true),
        IMAGE,
        '/restore/dump.rdb',
      ],
      { allowFailure: true }
    );
    assert(corruptCheck.status !== 0, 'Corrupted RDB unexpectedly passed redis-check-rdb');

    docker(['volume', 'create', RESTORED_VOLUME]);
    docker([
      'run',
      '--rm',
      '--mount',
      `type=volume,src=${RESTORED_VOLUME},dst=/data`,
      '--mount',
      bind(path.join(paths.restore, 'drill'), '/restore', true),
      '--entrypoint',
      'sh',
      REDIS_IMAGE,
      '-lc',
      'cp /restore/dump.rdb /data/dump.rdb && chown redis:redis /data/dump.rdb',
    ]);
    docker([
      'run',
      '-d',
      '--name',
      RESTORED_CONTAINER,
      '--network',
      NETWORK,
      '--mount',
      `type=volume,src=${RESTORED_VOLUME},dst=/data`,
      REDIS_IMAGE,
      'redis-server',
      '--appendonly',
      'no',
      '--dir',
      '/data',
      '--dbfilename',
      'dump.rdb',
    ]);
    waitForRedis(RESTORED_CONTAINER);
    assert(
      redis(RESTORED_CONTAINER, 'GET', `${PREFIX}:lead:delivered`) === deliveredValue,
      'Delivered lead was not restored'
    );
    assert(
      redis(RESTORED_CONTAINER, 'GET', `${PREFIX}:lead:pending`) === pendingValue,
      'Pending lead was not restored'
    );
    assert(
      redis(RESTORED_CONTAINER, 'GET', `${PREFIX}:idempotency`) === idempotencyValue,
      'Idempotency state was not restored'
    );
    assert(Number(redis(RESTORED_CONTAINER, 'TTL', `${PREFIX}:idempotency`)) > 0, 'Restored TTL is missing');
    assert(
      redis(RESTORED_CONTAINER, 'ZSCORE', `${PREFIX}:delivery:queue`, 'lead-pending') === '1700000000000',
      'Queue state was not restored'
    );
    assert(redis(RESTORED_CONTAINER, 'HGET', `${PREFIX}:lead-state`, 'attempts') === '2', 'Lead hash was not restored');

    for (const output of [init.stdout, backup.stdout, check.stdout, list.stdout, restore.stdout]) {
      assert(!output.includes(repositoryPassword), 'Command output leaked repository password');
      assert(!output.includes(deliveredValue), 'Command output leaked lead data');
      assert(!output.includes(pendingValue), 'Command output leaked pending lead data');
    }

    Object.assign(evidence, {
      status: 'PASS',
      resticEncrypted: true,
      wrongPasswordRejected: true,
      corruptRdbRejected: true,
      restored: {
        deliveredLead: true,
        pendingLead: true,
        idempotency: true,
        ttl: true,
        queue: true,
      },
    });
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    cleanup(tempRoot);
  }
}

try {
  main();
} catch (error) {
  console.error(`[backup-restore-gate] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
