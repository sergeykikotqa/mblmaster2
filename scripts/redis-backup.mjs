import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = 'mbl-production';
const BACKUP_TAG = 'mbl-redis';
const DATA_CONTRACT_TAG = 'data-contract-1';
const MANIFEST_NAME = 'mbl-redis-backup.json';
const RDB_NAME = 'dump.rdb';
const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024;

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

function readTextFile(filePath, label) {
  const resolved = path.resolve(String(filePath || '').trim());
  assert(filePath && fs.existsSync(resolved), `${label} file is missing`);
  const value = fs.readFileSync(resolved, 'utf8').trim();
  assert(value, `${label} file is empty`);
  return { path: resolved, value };
}

function readOptionalSecret(filePath, label) {
  if (!String(filePath || '').trim()) return null;
  return readTextFile(filePath, label);
}

function secretValues(config) {
  return [
    config.repository?.value,
    config.password?.value,
    config.s3AccessKey?.value,
    config.s3SecretKey?.value,
    config.s3SessionToken?.value,
    config.redisPassword?.value,
  ].filter(Boolean);
}

export function redactBackupDiagnostic(value, secrets = []) {
  let result = String(value || '');
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, '[redacted]');
  }
  return result
    .replace(/s3:https?:\/\/[^\s"']+/gi, 's3:https://[repository-redacted]')
    .replace(/redis(?:s)?:\/\/[^\s"']+/gi, 'redis://[redacted]')
    .replace(/(AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)=)[^\s]+/gi, '$1[redacted]');
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60_000,
    windowsHide: true,
    maxBuffer: MAX_COMMAND_OUTPUT,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const status = Number.isInteger(result.status) ? result.status : 1;
  return { status, stdout, stderr, error: result.error };
}

function run(command, args, options = {}) {
  const result = commandResult(command, args, options);
  if (result.error || result.status !== 0) {
    const raw = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    const diagnostic = redactBackupDiagnostic(raw, options.secrets);
    throw new Error(`${command} failed with exit ${result.status}${diagnostic ? `\n${diagnostic}` : ''}`);
  }
  return result.stdout;
}

function assertSecretPathIsNotRepositoryFile(secretFile, repositoryFile, label) {
  if (!secretFile) return;
  assert(
    path.resolve(secretFile.path) !== path.resolve(repositoryFile.path),
    `${label} must not reuse repository file`
  );
}

export function validateBackupRepository(repository, allowLocal = false) {
  const value = String(repository || '').trim();
  assert(value, 'Restic repository is empty');
  if (value.startsWith('s3:https://')) return value;
  assert(allowLocal, 'Production backup repository must use S3 over HTTPS');
  assert(!value.startsWith('s3:http://'), 'Plain HTTP S3 repositories are forbidden');
  return value;
}

function resolveConfig() {
  const repository = readTextFile(process.env.MBL_BACKUP_REPOSITORY_FILE, 'backup repository');
  const password = readTextFile(process.env.MBL_BACKUP_PASSWORD_FILE, 'Restic password');
  const s3AccessKey = readOptionalSecret(process.env.MBL_BACKUP_S3_ACCESS_KEY_FILE, 'S3 access key');
  const s3SecretKey = readOptionalSecret(process.env.MBL_BACKUP_S3_SECRET_KEY_FILE, 'S3 secret key');
  const s3SessionToken = readOptionalSecret(process.env.MBL_BACKUP_S3_SESSION_TOKEN_FILE, 'S3 session token');
  const redisPassword = readOptionalSecret(process.env.MBL_BACKUP_REDIS_PASSWORD_FILE, 'Redis password');
  const allowLocal = parseBoolean(process.env.MBL_BACKUP_ALLOW_LOCAL_REPOSITORY, false);

  validateBackupRepository(repository.value, allowLocal);
  assert(Boolean(s3AccessKey) === Boolean(s3SecretKey), 'S3 access and secret key files must be configured together');
  assertSecretPathIsNotRepositoryFile(password, repository, 'Restic password');
  assertSecretPathIsNotRepositoryFile(s3SecretKey, repository, 'S3 secret key');

  const releaseSha = String(process.env.MBL_BACKUP_RELEASE_SHA || 'unknown').trim();
  assert(
    releaseSha === 'unknown' || /^[a-f0-9]{40}$/i.test(releaseSha),
    'MBL_BACKUP_RELEASE_SHA must be a full Git SHA'
  );

  return {
    repository,
    password,
    s3AccessKey,
    s3SecretKey,
    s3SessionToken,
    redisPassword,
    releaseSha,
    host: String(process.env.MBL_BACKUP_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST,
    redisHost: String(process.env.MBL_BACKUP_REDIS_HOST || 'mbl-redis').trim(),
    redisPort: String(process.env.MBL_BACKUP_REDIS_PORT || '6379').trim(),
    redisUser: String(process.env.MBL_BACKUP_REDIS_USER || '').trim(),
    statusDir: String(process.env.MBL_BACKUP_STATUS_DIR || '/status').trim(),
    restoreRoot: String(process.env.MBL_BACKUP_RESTORE_ROOT || '/restore').trim(),
    allowLocal,
  };
}

function resticEnv(config) {
  const env = {
    ...process.env,
    RESTIC_REPOSITORY_FILE: config.repository.path,
    RESTIC_PASSWORD_FILE: config.password.path,
    RESTIC_CACHE_DIR: process.env.RESTIC_CACHE_DIR || '/tmp/restic-cache',
  };
  if (config.s3AccessKey) env.AWS_ACCESS_KEY_ID = config.s3AccessKey.value;
  if (config.s3SecretKey) env.AWS_SECRET_ACCESS_KEY = config.s3SecretKey.value;
  if (config.s3SessionToken) env.AWS_SESSION_TOKEN = config.s3SessionToken.value;
  return env;
}

function redisArgs(config, extraArgs) {
  const args = ['-h', config.redisHost, '-p', config.redisPort];
  if (config.redisUser) args.push('--user', config.redisUser);
  args.push(...extraArgs);
  return args;
}

function redisEnv(config) {
  const env = { ...process.env };
  if (config.redisPassword) env.REDISCLI_AUTH = config.redisPassword.value;
  return env;
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function parseResticSummary(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value?.message_type === 'summary' && value.snapshot_id) return value;
    } catch {
      // Restic may mix informational lines with JSON on some backends.
    }
  }
  throw new Error('Restic did not return a snapshot summary');
}

function ensureRepository(config) {
  run('restic', ['snapshots', '--json', '--latest', '1'], {
    env: resticEnv(config),
    secrets: secretValues(config),
    timeoutMs: 120_000,
  });
}

function initializeRepository(config) {
  assert(
    process.env.MBL_BACKUP_INIT_CONFIRM === 'INITIALIZE_EMPTY_REPOSITORY',
    'Repository initialization confirmation is missing'
  );
  const output = run('restic', ['init'], {
    env: resticEnv(config),
    secrets: secretValues(config),
    timeoutMs: 120_000,
  });
  console.log(
    JSON.stringify({
      status: 'initialized',
      repository: 'configured',
      detail: output ? 'created' : 'created-without-output',
    })
  );
}

function createRedisSnapshot(config, workDir) {
  const rdbPath = path.join(workDir, RDB_NAME);
  run('redis-cli', redisArgs(config, ['--rdb', rdbPath]), {
    env: redisEnv(config),
    secrets: secretValues(config),
    timeoutMs: 5 * 60_000,
  });
  assert(fs.existsSync(rdbPath), 'redis-cli did not create an RDB snapshot');
  run('redis-check-rdb', [rdbPath], { secrets: secretValues(config), timeoutMs: 120_000 });
  return rdbPath;
}

function writeBackupStatus(config, status) {
  if (!config.statusDir) return;
  try {
    atomicWriteJson(path.join(config.statusDir, 'last-success.json'), status);
  } catch (error) {
    throw new Error(
      `Backup succeeded but status checkpoint failed: ${redactBackupDiagnostic(error, secretValues(config))}`
    );
  }
}

function backupRedis(config) {
  ensureRepository(config);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-redis-backup-'));
  const snapshotDir = path.join(temporaryRoot, 'snapshot');
  fs.mkdirSync(snapshotDir, { mode: 0o700 });
  try {
    const rdbPath = createRedisSnapshot(config, snapshotDir);
    const manifest = {
      schema: 1,
      createdAt: new Date().toISOString(),
      releaseSha: config.releaseSha,
      dataContractVersion: 1,
      rdb: {
        file: RDB_NAME,
        bytes: fs.statSync(rdbPath).size,
        sha256: sha256File(rdbPath),
      },
    };
    atomicWriteJson(path.join(snapshotDir, MANIFEST_NAME), manifest);

    const output = run(
      'restic',
      [
        'backup',
        snapshotDir,
        '--host',
        config.host,
        '--tag',
        BACKUP_TAG,
        '--tag',
        DATA_CONTRACT_TAG,
        '--json',
        '--no-scan',
      ],
      { env: resticEnv(config), secrets: secretValues(config), timeoutMs: 15 * 60_000 }
    );
    const summary = parseResticSummary(output);
    const status = {
      schema: 1,
      status: 'ok',
      completedAt: new Date().toISOString(),
      snapshotId: summary.snapshot_id,
      releaseSha: config.releaseSha,
      rdbBytes: manifest.rdb.bytes,
      rdbSha256: manifest.rdb.sha256,
    };
    writeBackupStatus(config, status);
    console.log(JSON.stringify(status));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function buildRetentionArgs({ hourly = 24, daily = 7, weekly = 4, host = DEFAULT_HOST } = {}) {
  for (const [label, value] of Object.entries({ hourly, daily, weekly })) {
    assert(Number.isInteger(value) && value > 0, `${label} retention must be a positive integer`);
  }
  return [
    'forget',
    '--host',
    host,
    '--tag',
    BACKUP_TAG,
    '--keep-hourly',
    String(hourly),
    '--keep-daily',
    String(daily),
    '--keep-weekly',
    String(weekly),
    '--prune',
  ];
}

function applyRetention(config) {
  assert(process.env.MBL_BACKUP_RETENTION_CONFIRM === 'APPLY_RETENTION_POLICY', 'Retention confirmation is missing');
  ensureRepository(config);
  const hourly = Number(process.env.MBL_BACKUP_KEEP_HOURLY || 24);
  const daily = Number(process.env.MBL_BACKUP_KEEP_DAILY || 7);
  const weekly = Number(process.env.MBL_BACKUP_KEEP_WEEKLY || 4);
  run('restic', buildRetentionArgs({ hourly, daily, weekly, host: config.host }), {
    env: resticEnv(config),
    secrets: secretValues(config),
    timeoutMs: 30 * 60_000,
  });
  console.log(JSON.stringify({ status: 'retention-applied', hourly, daily, weekly }));
}

function checkRepository(config) {
  ensureRepository(config);
  const args = ['check'];
  if (parseBoolean(process.env.MBL_BACKUP_CHECK_READ_ALL, false)) args.push('--read-data');
  else args.push(`--read-data-subset=${String(process.env.MBL_BACKUP_CHECK_SUBSET || '5%').trim()}`);
  run('restic', args, {
    env: resticEnv(config),
    secrets: secretValues(config),
    timeoutMs: 60 * 60_000,
  });
  console.log(JSON.stringify({ status: 'repository-ok', readData: args.at(-1) }));
}

function walkFiles(root) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const resolved = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Restore snapshot contains a symbolic link');
      if (entry.isDirectory()) pending.push(resolved);
      else if (entry.isFile()) found.push(resolved);
    }
  }
  return found;
}

export function assertSafeRestoreTarget(target, restoreRoot = '/restore') {
  const resolvedRoot = path.resolve(restoreRoot);
  const resolvedTarget = path.resolve(target);
  assert(resolvedTarget !== resolvedRoot, 'Restore target must be a dedicated child directory');
  assert(
    resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`),
    'Restore target must stay inside the isolated restore root'
  );
  assert(
    !/(^|[\\/])(data|var[\\/]lib[\\/]redis)([\\/]|$)/i.test(resolvedTarget),
    'Restore target must not be a Redis data directory'
  );
  return resolvedTarget;
}

function parseCliOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    assert(item.startsWith('--'), `Unexpected argument: ${item}`);
    const key = item.slice(2);
    const value = args[index + 1];
    assert(value && !value.startsWith('--'), `Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function restoreSnapshot(config, cliArgs) {
  assert(process.env.MBL_BACKUP_RESTORE_CONFIRM === 'RESTORE_TO_ISOLATED_DIRECTORY', 'Restore confirmation is missing');
  ensureRepository(config);
  const options = parseCliOptions(cliArgs);
  const snapshot = String(options.snapshot || '').trim();
  assert(snapshot && (snapshot === 'latest' || /^[a-f0-9]{8,64}$/i.test(snapshot)), 'A valid --snapshot is required');
  assert(String(options.target || '').trim(), 'A --target directory is required');
  const target = assertSafeRestoreTarget(options.target, config.restoreRoot);
  assert(
    !fs.existsSync(target) || fs.readdirSync(target).length === 0,
    'Restore target must not exist or must be empty'
  );

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-redis-restore-'));
  try {
    run('restic', ['restore', snapshot, '--target', temporaryRoot, '--host', config.host, '--tag', BACKUP_TAG], {
      env: resticEnv(config),
      secrets: secretValues(config),
      timeoutMs: 30 * 60_000,
    });
    const files = walkFiles(temporaryRoot);
    const rdbFiles = files.filter((file) => path.basename(file) === RDB_NAME);
    const manifestFiles = files.filter((file) => path.basename(file) === MANIFEST_NAME);
    assert(
      rdbFiles.length === 1 && manifestFiles.length === 1,
      'Restore snapshot must contain exactly one RDB and one manifest'
    );
    const manifest = JSON.parse(fs.readFileSync(manifestFiles[0], 'utf8'));
    assert(manifest?.schema === 1 && manifest?.dataContractVersion === 1, 'Unsupported backup manifest');
    assert(manifest?.rdb?.sha256 === sha256File(rdbFiles[0]), 'Restored RDB checksum does not match manifest');
    assert(manifest?.rdb?.bytes === fs.statSync(rdbFiles[0]).size, 'Restored RDB size does not match manifest');
    run('redis-check-rdb', [rdbFiles[0]], { secrets: secretValues(config), timeoutMs: 120_000 });

    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.copyFileSync(rdbFiles[0], path.join(target, RDB_NAME), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(manifestFiles[0], path.join(target, MANIFEST_NAME), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(target, RDB_NAME), 0o600);
    fs.chmodSync(path.join(target, MANIFEST_NAME), 0o600);
    console.log(
      JSON.stringify({
        status: 'restored-to-isolated-directory',
        snapshot,
        target,
        releaseSha: manifest.releaseSha,
        rdbSha256: manifest.rdb.sha256,
      })
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function listSnapshots(config) {
  const output = run('restic', ['snapshots', '--host', config.host, '--tag', BACKUP_TAG, '--json'], {
    env: resticEnv(config),
    secrets: secretValues(config),
    timeoutMs: 120_000,
  });
  process.stdout.write(`${output}\n`);
}

function printVersions() {
  const restic = run('restic', ['version']);
  const redisCli = run('redis-cli', ['--version']);
  console.log(JSON.stringify({ restic, redisCli, node: process.version }));
}

export function main(argv = process.argv.slice(2)) {
  const [command = 'backup', ...cliArgs] = argv;
  if (command === 'version') return printVersions();
  const config = resolveConfig();
  if (command === 'init') return initializeRepository(config);
  if (command === 'backup') return backupRedis(config);
  if (command === 'retention') return applyRetention(config);
  if (command === 'check') return checkRepository(config);
  if (command === 'restore') return restoreSnapshot(config, cliArgs);
  if (command === 'list') return listSnapshots(config);
  throw new Error(`Unknown backup command: ${command}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    const fallbackSecrets = [];
    for (const fileEnv of [
      'MBL_BACKUP_PASSWORD_FILE',
      'MBL_BACKUP_S3_ACCESS_KEY_FILE',
      'MBL_BACKUP_S3_SECRET_KEY_FILE',
      'MBL_BACKUP_S3_SESSION_TOKEN_FILE',
      'MBL_BACKUP_REDIS_PASSWORD_FILE',
    ]) {
      try {
        const file = process.env[fileEnv];
        if (file && fs.existsSync(file)) fallbackSecrets.push(fs.readFileSync(file, 'utf8').trim());
      } catch {
        // Diagnostics must never fail because a secret file disappeared.
      }
    }
    console.error(
      `[redis-backup] ${redactBackupDiagnostic(error instanceof Error ? error.message : error, fallbackSecrets)}`
    );
    process.exitCode = 1;
  }
}

export const BACKUP_CONSTANTS = Object.freeze({ BACKUP_TAG, DATA_CONTRACT_TAG, MANIFEST_NAME, RDB_NAME });
