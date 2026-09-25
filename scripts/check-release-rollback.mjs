import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID, writeReleaseChecksums } from './release-tool.mjs';

const ROOT = process.cwd();
const PREFIX = `mbl-o24-release-gate-${randomBytes(4).toString('hex')}`;
const REDIS_IMAGE = 'redis:7.4.7-alpine3.21';
const RELEASE_A = 'a'.repeat(40);
const RELEASE_B = 'b'.repeat(40);
const RELEASE_BAD = 'c'.repeat(40);
const RELEASE_UNSAFE_LEGACY = '8c34c97a5fed70db90184966fd5868a39aa4f292';
const TIMEOUT_MS = 10 * 60_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 30 * 1024 * 1024,
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

function docker(args, options) {
  return run('docker', args, options);
}

function assertSafeName(value) {
  assert(value.startsWith('mbl-o24-release-gate-'), `Refusing to mutate unsafe fixture resource: ${value}`);
  return value;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Unable to reserve a local release-gate port');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function imageRepositories() {
  return {
    web: `${PREFIX}-web`,
    nginx: `${PREFIX}-nginx`,
    backup: `${PREFIX}-backup`,
  };
}

function imageRefs(releaseId) {
  const repositories = imageRepositories();
  return Object.fromEntries(
    Object.entries(repositories).map(([name, repository]) => [name, `${repository}:${releaseId}`])
  );
}

function inspectImage(reference) {
  const payload = JSON.parse(docker(['image', 'inspect', reference]).stdout);
  assert(Array.isArray(payload) && payload.length === 1, `Unable to inspect fixture image ${reference}`);
  const image = payload[0];
  return {
    ref: reference,
    id: image.Id,
    revision: image?.Config?.Labels?.['org.opencontainers.image.revision'] || '',
    os: image.Os,
    architecture: image.Architecture,
  };
}

function writeFixtureContext(contextDirectory) {
  fs.mkdirSync(contextDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(contextDirectory, 'Dockerfile'),
    `FROM node:22.22.0-alpine3.23\nARG RELEASE_ID\nARG BROKEN=false\nLABEL org.opencontainers.image.revision="\${RELEASE_ID}"\nENV RELEASE_ID=\${RELEASE_ID} BROKEN=\${BROKEN}\nWORKDIR /app\nCOPY server.mjs worker.mjs ./\nCMD ["node", "server.mjs"]\n`
  );
  fs.writeFileSync(
    path.join(contextDirectory, 'server.mjs'),
    `import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const releaseId = process.env.RELEASE_ID || 'unknown';
const broken = process.env.BROKEN === 'true';
const port = Number(process.env.PORT || 4321);
const server = createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://fixture.test').pathname;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (pathname === '/health/live' || pathname === '/health/ready') {
    response.statusCode = broken ? 503 : 200;
    response.end(JSON.stringify({ ok: !broken, status: broken ? 'failed' : pathname.endsWith('ready') ? 'ready' : 'live', releaseId }));
    return;
  }
  if (pathname === '/api/admin/health/worker') {
    let heartbeat = null;
    try { heartbeat = JSON.parse(readFileSync('/heartbeat/last-cycle.json', 'utf8')); } catch {}
    response.statusCode = heartbeat ? 200 : 503;
    response.end(JSON.stringify({ runtime: { heartbeat: heartbeat ? { state: 'cycling', value: heartbeat } : { state: 'missing', value: null } } }));
    return;
  }
  response.statusCode = broken ? 503 : 200;
  response.end(JSON.stringify({ ok: !broken, releaseId, pathname }));
});
server.listen(port, '0.0.0.0');
`
  );
  fs.writeFileSync(
    path.join(contextDirectory, 'worker.mjs'),
    `import { writeFileSync } from 'node:fs';
const writeHeartbeat = () => writeFileSync('/heartbeat/last-cycle.json', JSON.stringify({ status: 'ok', releaseId: process.env.RELEASE_ID, lastCycleAt: new Date().toISOString() }));
writeHeartbeat();
const timer = setInterval(writeHeartbeat, 250);
process.once('SIGTERM', () => { clearInterval(timer); process.exit(0); });
`
  );
}

function buildReleaseImage(contextDirectory, releaseId, broken) {
  const refs = imageRefs(releaseId);
  docker(
    [
      'build',
      '--pull=false',
      '--build-arg',
      `RELEASE_ID=${releaseId}`,
      '--build-arg',
      `BROKEN=${broken ? 'true' : 'false'}`,
      '--tag',
      refs.web,
      contextDirectory,
    ],
    { timeoutMs: 20 * 60_000 }
  );
  docker(['tag', refs.web, refs.nginx]);
  docker(['tag', refs.web, refs.backup]);
  const images = {
    web: inspectImage(refs.web),
    nginx: inspectImage(refs.nginx),
    backup: inspectImage(refs.backup),
  };
  for (const image of Object.values(images)) {
    assert(image.revision === releaseId, `Fixture image revision does not match ${releaseId}`);
  }
  return images;
}

function fixtureProductionCompose(repositories) {
  return `name: ${PREFIX}

services:
  mbl-nginx:
    image: ${repositories.nginx}:\${MBL_IMAGE_TAG:?Set MBL_IMAGE_TAG}
    pull_policy: build
    build:
      context: .
    command: ['node', 'server.mjs']
    environment:
      PORT: '8080'
    healthcheck:
      test: ['CMD', 'node', '--input-type=module', '--eval', "fetch('http://127.0.0.1:8080/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 1s
      timeout: 1s
      retries: 3
    ports:
      - '127.0.0.1:\${MBL_HTTP_PORT:?Set MBL_HTTP_PORT}:8080'
    networks: [mbl-edge]

  mbl-web:
    image: ${repositories.web}:\${MBL_IMAGE_TAG:?Set MBL_IMAGE_TAG}
    pull_policy: build
    build:
      context: .
    env_file:
      - \${MBL_ENV_FILE:?Set MBL_ENV_FILE}
    command: ['node', 'server.mjs']
    environment:
      PORT: '4321'
      METRICS_ADMIN_TOKEN: \${METRICS_ADMIN_TOKEN:?Set METRICS_ADMIN_TOKEN}
    volumes:
      - mbl-heartbeat-data:/heartbeat:ro
    healthcheck:
      test: ['CMD', 'node', '--input-type=module', '--eval', "fetch('http://127.0.0.1:4321/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 1s
      timeout: 1s
      retries: 3
    networks: [mbl-backend]

  mbl-worker-trigger:
    image: ${repositories.web}:\${MBL_IMAGE_TAG:?Set MBL_IMAGE_TAG}
    pull_policy: build
    build:
      context: .
    env_file:
      - \${MBL_ENV_FILE:?Set MBL_ENV_FILE}
    command: ['node', 'worker.mjs']
    healthcheck:
      disable: true
    volumes:
      - mbl-heartbeat-data:/heartbeat
    networks: [mbl-backend]

  mbl-redis:
    image: ${REDIS_IMAGE}
    pull_policy: missing
    command: ['redis-server', '--appendonly', 'yes', '--appendfsync', 'everysec', '--dir', '/data']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 1s
      timeout: 1s
      retries: 20
    volumes:
      - mbl-redis-data:/data
    networks: [mbl-backend]

networks:
  mbl-edge:
  mbl-backend:
    internal: true

volumes:
  mbl-redis-data:
    name: \${MBL_REDIS_VOLUME_NAME:?Set MBL_REDIS_VOLUME_NAME}
    external: true
  mbl-heartbeat-data:
`;
}

function fixtureBackupCompose(repositories) {
  return `services:
  mbl-backup:
    profiles: [backup]
    image: ${repositories.backup}:\${MBL_IMAGE_TAG:?Set MBL_IMAGE_TAG}
    pull_policy: build
    build:
      context: .
    command: ['node', '--version']
    networks: [mbl-backup-egress]

networks:
  mbl-backup-egress:
`;
}

function fixturePolicy(repositories) {
  return {
    schema: 1,
    projectName: PREFIX,
    dataContractVersion: 1,
    metricsRuntimeGeneration: 2,
    applicationServices: ['mbl-web', 'mbl-worker-trigger', 'mbl-nginx'],
    statefulServices: ['mbl-redis'],
    expectedServices: ['mbl-web', 'mbl-worker-trigger', 'mbl-nginx', 'mbl-redis'],
    redisDataDestination: '/data',
    imageRepositories: repositories,
    composeFiles: ['compose.production.yml', 'compose.backup.yml', 'compose.release.yml'],
    smokePaths: ['/health/live', '/health/ready', '/', '/projects', '/robots.txt', '/sitemap-index.xml'],
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createBundle(root, releaseId, images, repositories) {
  const bundle = path.join(root, 'incoming', releaseId);
  fs.mkdirSync(path.join(bundle, 'images'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'config'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'compose.production.yml'), fixtureProductionCompose(repositories));
  fs.writeFileSync(path.join(bundle, 'compose.backup.yml'), fixtureBackupCompose(repositories));
  fs.copyFileSync(path.join(ROOT, 'compose.release.yml'), path.join(bundle, 'compose.release.yml'));
  writeJson(path.join(bundle, 'config', 'release-policy.json'), fixturePolicy(repositories));
  fs.copyFileSync(
    path.join(ROOT, 'config', 'public-build-env.json'),
    path.join(bundle, 'config', 'public-build-env.json')
  );
  fs.copyFileSync(path.join(ROOT, 'scripts', 'release-tool.mjs'), path.join(bundle, 'scripts', 'release-tool.mjs'));
  fs.writeFileSync(path.join(bundle, 'docs', 'release-and-rollback.md'), '# Fixture release runbook\n');

  docker(['save', '--output', path.join(bundle, 'images', 'app-images.tar'), images.web.ref, images.nginx.ref], {
    timeoutMs: 10 * 60_000,
  });
  docker(['save', '--output', path.join(bundle, 'images', 'ops-images.tar'), images.backup.ref], {
    timeoutMs: 10 * 60_000,
  });
  writeJson(path.join(bundle, 'manifest.json'), {
    schema: 1,
    releaseId,
    gitSha: releaseId,
    createdAt: new Date().toISOString(),
    canonicalOrigin: 'https://fixture.mbl.invalid',
    dataContractVersion: 1,
    metricsRuntimeGeneration: 2,
    platform: `${images.web.os}/${images.web.architecture}`,
    images,
    archives: { application: 'images/app-images.tar', operations: 'images/ops-images.tar' },
  });
  writeReleaseChecksums(bundle);
  return bundle;
}

function composeBase(bundle, envFile, releaseId) {
  return {
    args: [
      'compose',
      '--project-name',
      PREFIX,
      '--env-file',
      envFile,
      '--file',
      path.join(bundle, 'compose.production.yml'),
      '--file',
      path.join(bundle, 'compose.backup.yml'),
      '--file',
      path.join(bundle, 'compose.release.yml'),
    ],
    env: { ...process.env, MBL_IMAGE_TAG: releaseId, MBL_ENV_FILE: path.resolve(envFile) },
  };
}

function compose(bundle, envFile, releaseId, args, options = {}) {
  const base = composeBase(bundle, envFile, releaseId);
  return docker([...base.args, ...args], { ...options, env: base.env });
}

function waitForRedis(bundle, envFile, releaseId, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = compose(bundle, envFile, releaseId, ['exec', '-T', 'mbl-redis', 'redis-cli', '--raw', 'PING'], {
      allowFailure: true,
      timeoutMs: 5000,
    });
    if (result.status === 0 && result.stdout === 'PONG') return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error('Fixture Redis did not become ready');
}

function redis(bundle, envFile, releaseId, ...args) {
  return compose(bundle, envFile, releaseId, ['exec', '-T', 'mbl-redis', 'redis-cli', '--raw', ...args]).stdout;
}

function inspectService(bundle, envFile, releaseId, service) {
  const containerId = compose(bundle, envFile, releaseId, ['ps', '--quiet', service]).stdout;
  assert(containerId, `${service} is not running`);
  return JSON.parse(docker(['inspect', containerId]).stdout)[0];
}

function redisIdentity(bundle, envFile, releaseId, volumeName) {
  const container = inspectService(bundle, envFile, releaseId, 'mbl-redis');
  const mount = (container.Mounts || []).find((item) => item.Destination === '/data');
  assert(mount?.Name === volumeName, 'Fixture Redis is not using the expected external volume');
  return { containerId: container.Id, imageId: container.Image, volumeName: mount.Name };
}

function assertRedisIdentity(actual, expected) {
  assert(actual.containerId === expected.containerId, 'Redis container changed during app release/rollback');
  assert(actual.imageId === expected.imageId, 'Redis image changed during app release/rollback');
  assert(actual.volumeName === expected.volumeName, 'Redis volume changed during app release/rollback');
}

function assertApplicationRelease(bundle, envFile, releaseId, manifest) {
  const web = inspectService(bundle, envFile, releaseId, 'mbl-web');
  const worker = inspectService(bundle, envFile, releaseId, 'mbl-worker-trigger');
  const nginx = inspectService(bundle, envFile, releaseId, 'mbl-nginx');
  assert(web.Image === manifest.images.web.id, `Web is not running ${releaseId}`);
  assert(worker.Image === manifest.images.web.id, `Worker is not running ${releaseId}`);
  assert(nginx.Image === manifest.images.nginx.id, `Nginx is not running ${releaseId}`);
}

function assertQueuedLead(bundle, envFile, releaseId, leadId, marker) {
  assert(redis(bundle, envFile, releaseId, 'ZSCORE', `${PREFIX}:delivery:queue`, leadId), 'Queued lead disappeared');
  assert(
    redis(bundle, envFile, releaseId, 'HGET', `${PREFIX}:lead:${leadId}`, 'marker') === marker,
    'Queued lead payload changed'
  );
}

function releaseCommandArgs(command, options) {
  const args = [path.join(ROOT, 'scripts', 'release-tool.mjs'), command];
  if (options.bundle) args.push('--bundle', options.bundle);
  args.push(
    '--runtime-root',
    options.runtimeRoot,
    '--env-file',
    options.envFile,
    '--base-url',
    options.baseUrl,
    '--timeout-ms',
    String(options.timeoutMs || 30_000)
  );
  return args;
}

function assertSecretFreeOutput(output, secretMarker) {
  assert(!output.includes(secretMarker), 'Release log exposed the environment secret marker');
  assert(!output.includes('queued-private-marker'), 'Release log exposed queued lead data');
}

function runRelease(command, options, secretMarker, allowFailure = false) {
  const args = releaseCommandArgs(command, options);
  const result = run(process.execPath, args, { allowFailure, timeoutMs: 5 * 60_000 });
  const combined = `${result.stdout}\n${result.stderr}`;
  assertSecretFreeOutput(combined, secretMarker);
  return result;
}

async function interruptReleaseAtPhase(command, options, phase, secretMarker) {
  const child = spawn(process.execPath, releaseCommandArgs(command, options), {
    cwd: ROOT,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const journalPath = path.join(options.runtimeRoot, 'release-operation.json');
  const deadline = Date.now() + 45_000;
  let observed = '';
  while (Date.now() < deadline) {
    if (fs.existsSync(journalPath)) {
      try {
        observed = JSON.parse(fs.readFileSync(journalPath, 'utf8')).phase || '';
      } catch {
        observed = '';
      }
      if (observed === phase) break;
    }
    assert(child.exitCode === null, `Release exited before interruption phase ${phase}: ${stdout}\n${stderr}`);
    await delay(50);
  }
  assert(observed === phase, `Did not observe interruption phase ${phase}; last phase was ${observed || 'none'}`);

  if (process.platform === 'win32') {
    run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { allowFailure: true, timeoutMs: 30_000 });
  } else {
    child.kill('SIGKILL');
  }
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(15_000).then(() => {
        throw new Error(`Interrupted release process did not exit at phase ${phase}`);
      }),
    ]);
  }
  assert(fs.existsSync(journalPath), `Interrupted release lost its operation journal at phase ${phase}`);
  assertSecretFreeOutput(`${stdout}\n${stderr}`, secretMarker);
}

async function assertPublicRelease(baseUrl, releaseId) {
  const response = await fetch(`${baseUrl}/`);
  const payload = await response.json();
  assert(response.status === 200 && payload.releaseId === releaseId, `Public fixture is not serving ${releaseId}`);
}

async function assertRejectedRollbackUnchanged({
  runtimeRoot,
  expectedState,
  bundle,
  envFile,
  releaseId,
  manifest,
  redisBefore,
  volumeName,
  queuedLeadId,
  queuedMarker,
  baseUrl,
}) {
  assert(
    JSON.stringify(readState(runtimeRoot)) === JSON.stringify(expectedState),
    'Rejected rollback changed release state'
  );
  assert(
    !fs.existsSync(path.join(runtimeRoot, 'release-operation.json')),
    'Rejected rollback left an operation journal'
  );
  assert(!fs.existsSync(path.join(runtimeRoot, '.release.lock')), 'Rejected rollback left its process lock');
  assertActiveRelease(runtimeRoot, releaseId);
  assertApplicationRelease(bundle, envFile, releaseId, manifest);
  assertRedisIdentity(redisIdentity(bundle, envFile, releaseId, volumeName), redisBefore);
  assertQueuedLead(bundle, envFile, releaseId, queuedLeadId, queuedMarker);
  await assertPublicRelease(baseUrl, releaseId);
}

function readState(runtimeRoot) {
  return JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'release-state.json'), 'utf8'));
}

function assertActiveRelease(runtimeRoot, releaseId) {
  const linkPath = path.join(runtimeRoot, 'current');
  assert(fs.lstatSync(linkPath).isSymbolicLink(), 'Active release path is not a symbolic link');
  assert(
    fs.realpathSync(linkPath) === fs.realpathSync(path.join(runtimeRoot, 'releases', releaseId)),
    `Active release link does not point to ${releaseId}`
  );
}

function assertNoBackupContainer() {
  const ids = docker([
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${PREFIX}`,
    '--filter',
    'label=com.docker.compose.service=mbl-backup',
  ]).stdout;
  assert(!ids, 'Release or rollback started the backup service');
}

function cleanup(tempRoot, volumeName, references) {
  assertSafeName(PREFIX);
  const containers = docker(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${PREFIX}`], {
    allowFailure: true,
  })
    .stdout.split(/\r?\n/)
    .filter(Boolean);
  if (containers.length > 0) docker(['rm', '--force', ...containers], { allowFailure: true, timeoutMs: 120_000 });
  const networks = docker(['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${PREFIX}`], {
    allowFailure: true,
  })
    .stdout.split(/\r?\n/)
    .filter(Boolean);
  for (const network of networks) docker(['network', 'rm', network], { allowFailure: true, timeoutMs: 60_000 });
  const projectVolumes = docker(['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${PREFIX}`], {
    allowFailure: true,
  })
    .stdout.split(/\r?\n/)
    .filter(Boolean);
  for (const projectVolume of projectVolumes) {
    assertSafeName(projectVolume);
    docker(['volume', 'rm', '--force', projectVolume], { allowFailure: true, timeoutMs: 60_000 });
  }
  assertSafeName(volumeName);
  docker(['volume', 'rm', '--force', volumeName], { allowFailure: true, timeoutMs: 60_000 });
  for (const reference of references) {
    assert(reference.startsWith(`${PREFIX}-`), `Refusing to remove unsafe fixture image: ${reference}`);
    docker(['image', 'rm', '--force', reference], { allowFailure: true, timeoutMs: 120_000 });
  }
  const resolvedTemp = path.resolve(tempRoot);
  assert(
    path.basename(resolvedTemp).startsWith(PREFIX),
    `Refusing to remove unsafe fixture directory: ${resolvedTemp}`
  );
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
}

async function main() {
  docker(['version', '--format', '{{.Server.Version}}']);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}-`));
  const contextDirectory = path.join(tempRoot, 'context');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const envFile = path.join(tempRoot, 'deploy.env');
  const volumeName = `${PREFIX}-redis-data`;
  const secretMarker = `release-secret-${randomBytes(24).toString('hex')}`;
  const queuedLeadId = `lead-${randomBytes(12).toString('hex')}`;
  const queuedMarker = 'queued-private-marker';
  const repositories = imageRepositories();
  const allRefs = [RELEASE_A, RELEASE_B, RELEASE_BAD].flatMap((releaseId) => Object.values(imageRefs(releaseId)));
  const evidence = { project: PREFIX, releaseA: RELEASE_A, releaseB: RELEASE_B, failedCandidate: RELEASE_BAD };

  try {
    const redisAvailable = docker(['image', 'inspect', REDIS_IMAGE], { allowFailure: true });
    if (redisAvailable.status !== 0) docker(['pull', REDIS_IMAGE], { timeoutMs: 10 * 60_000 });
    writeFixtureContext(contextDirectory);
    const imagesA = buildReleaseImage(contextDirectory, RELEASE_A, false);
    const imagesB = buildReleaseImage(contextDirectory, RELEASE_B, false);
    const imagesBad = buildReleaseImage(contextDirectory, RELEASE_BAD, true);
    const bundleA = createBundle(tempRoot, RELEASE_A, imagesA, repositories);
    const bundleB = createBundle(tempRoot, RELEASE_B, imagesB, repositories);
    const bundleBad = createBundle(tempRoot, RELEASE_BAD, imagesBad, repositories);
    const manifestA = JSON.parse(fs.readFileSync(path.join(bundleA, 'manifest.json'), 'utf8'));
    const manifestB = JSON.parse(fs.readFileSync(path.join(bundleB, 'manifest.json'), 'utf8'));

    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    fs.writeFileSync(
      envFile,
      `MBL_HTTP_PORT=${port}\nMBL_REDIS_VOLUME_NAME=${volumeName}\nMETRICS_ADMIN_TOKEN=${secretMarker}\n`,
      { mode: 0o600 }
    );
    fs.mkdirSync(runtimeRoot, { recursive: true });
    docker(['volume', 'create', volumeName]);
    compose(bundleA, envFile, RELEASE_A, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'mbl-redis'], {
      timeoutMs: 120_000,
    });
    waitForRedis(bundleA, envFile, RELEASE_A);
    redis(
      bundleA,
      envFile,
      RELEASE_A,
      'HSET',
      `${PREFIX}:lead:${queuedLeadId}`,
      'status',
      'pending',
      'marker',
      queuedMarker
    );
    redis(bundleA, envFile, RELEASE_A, 'ZADD', `${PREFIX}:delivery:queue`, String(Date.now()), queuedLeadId);
    redis(bundleA, envFile, RELEASE_A, 'SET', `${PREFIX}:idempotency:${queuedLeadId}`, '1', 'EX', '3600');
    const redisBefore = redisIdentity(bundleA, envFile, RELEASE_A, volumeName);

    const common = { runtimeRoot, envFile, baseUrl, timeoutMs: 30_000 };
    runRelease('apply', { ...common, bundle: bundleA }, secretMarker);
    assertActiveRelease(runtimeRoot, RELEASE_A);
    assertApplicationRelease(bundleA, envFile, RELEASE_A, manifestA);
    assertRedisIdentity(redisIdentity(bundleA, envFile, RELEASE_A, volumeName), redisBefore);
    assertQueuedLead(bundleA, envFile, RELEASE_A, queuedLeadId, queuedMarker);
    await assertPublicRelease(baseUrl, RELEASE_A);

    const interruptedPhases = [];
    for (const phase of ['web-updating', 'worker-updating']) {
      await interruptReleaseAtPhase('apply', { ...common, bundle: bundleB }, phase, secretMarker);
      const reconciled = runRelease('apply', { ...common, bundle: bundleB }, secretMarker, true);
      assert(reconciled.status !== 0, `Interrupted phase ${phase} did not force an explicit retry`);
      assert(
        /interrupted apply operation was reconciled/i.test(`${reconciled.stdout}\n${reconciled.stderr}`),
        `Interrupted phase ${phase} was not reconciled`
      );
      assert(!fs.existsSync(path.join(runtimeRoot, 'release-operation.json')), 'Reconciled operation journal remains');
      assert(!fs.existsSync(path.join(runtimeRoot, '.release.lock')), 'Reconciled operation lock remains');
      assertApplicationRelease(bundleA, envFile, RELEASE_A, manifestA);
      assertActiveRelease(runtimeRoot, RELEASE_A);
      assertRedisIdentity(redisIdentity(bundleA, envFile, RELEASE_A, volumeName), redisBefore);
      assertQueuedLead(bundleA, envFile, RELEASE_A, queuedLeadId, queuedMarker);
      await assertPublicRelease(baseUrl, RELEASE_A);
      interruptedPhases.push(phase);
    }

    runRelease('apply', { ...common, bundle: bundleB }, secretMarker);
    assertActiveRelease(runtimeRoot, RELEASE_B);
    assertApplicationRelease(bundleB, envFile, RELEASE_B, manifestB);
    assertRedisIdentity(redisIdentity(bundleB, envFile, RELEASE_B, volumeName), redisBefore);
    assertQueuedLead(bundleB, envFile, RELEASE_B, queuedLeadId, queuedMarker);
    await assertPublicRelease(baseUrl, RELEASE_B);
    let state = readState(runtimeRoot);
    assert(state.current.releaseId === RELEASE_B && state.previous.releaseId === RELEASE_A, 'A → B state is incorrect');

    const compatibleState = structuredClone(state);
    const statePath = path.join(runtimeRoot, 'release-state.json');

    const incompatibleState = structuredClone(state);
    incompatibleState.previous.releaseId = RELEASE_UNSAFE_LEGACY;
    delete incompatibleState.previous.metricsRuntimeGeneration;
    writeJson(statePath, incompatibleState);
    const rejectedRollback = runRelease('rollback', common, secretMarker, true);
    assert(
      rejectedRollback.status !== 0 &&
        /ROLLBACK_TARGET_METRICS_RUNTIME_INCOMPATIBLE/.test(`${rejectedRollback.stdout}\n${rejectedRollback.stderr}`),
      'Incompatible legacy rollback target was not rejected by the metrics generation guard'
    );
    await assertRejectedRollbackUnchanged({
      runtimeRoot,
      expectedState: incompatibleState,
      bundle: bundleB,
      envFile,
      releaseId: RELEASE_B,
      manifest: manifestB,
      redisBefore,
      volumeName,
      queuedLeadId,
      queuedMarker,
      baseUrl,
    });
    writeJson(statePath, compatibleState);

    const storedBundleA = path.join(runtimeRoot, 'releases', RELEASE_A);
    const storedManifestAPath = path.join(storedBundleA, 'manifest.json');
    const storedPolicyAPath = path.join(storedBundleA, 'config', 'release-policy.json');
    const storedManifestA = JSON.parse(fs.readFileSync(storedManifestAPath, 'utf8'));
    const storedPolicyA = JSON.parse(fs.readFileSync(storedPolicyAPath, 'utf8'));
    const legacyManifestA = structuredClone(storedManifestA);
    const legacyPolicyA = structuredClone(storedPolicyA);
    delete legacyManifestA.metricsRuntimeGeneration;
    delete legacyPolicyA.metricsRuntimeGeneration;
    writeJson(storedManifestAPath, legacyManifestA);
    writeJson(storedPolicyAPath, legacyPolicyA);
    writeReleaseChecksums(storedBundleA);
    const stateGen2BundleLegacy = readState(runtimeRoot);
    const rejectedGen2Legacy = runRelease('rollback', common, secretMarker, true);
    assert(
      rejectedGen2Legacy.status !== 0 &&
        /metrics runtime generation does not match its stored bundle/i.test(
          `${rejectedGen2Legacy.stdout}\n${rejectedGen2Legacy.stderr}`
        ),
      'Generation 2 state was not rejected against a verified legacy target bundle'
    );
    await assertRejectedRollbackUnchanged({
      runtimeRoot,
      expectedState: stateGen2BundleLegacy,
      bundle: bundleB,
      envFile,
      releaseId: RELEASE_B,
      manifest: manifestB,
      redisBefore,
      volumeName,
      queuedLeadId,
      queuedMarker,
      baseUrl,
    });
    writeJson(storedManifestAPath, storedManifestA);
    writeJson(storedPolicyAPath, storedPolicyA);
    writeReleaseChecksums(storedBundleA);

    const bootstrapBundle = path.join(runtimeRoot, 'releases', METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID);
    fs.cpSync(storedBundleA, bootstrapBundle, { recursive: true, errorOnExist: true });
    const bootstrapManifestPath = path.join(bootstrapBundle, 'manifest.json');
    const bootstrapManifest = JSON.parse(fs.readFileSync(bootstrapManifestPath, 'utf8'));
    bootstrapManifest.releaseId = METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID;
    bootstrapManifest.gitSha = METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID;
    for (const [name, image] of Object.entries(bootstrapManifest.images)) {
      image.ref = `${repositories[name]}:${METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID}`;
      image.revision = METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID;
    }
    writeJson(bootstrapManifestPath, bootstrapManifest);
    writeReleaseChecksums(bootstrapBundle);
    const stateLegacyBundleGen2 = structuredClone(compatibleState);
    stateLegacyBundleGen2.previous = {
      ...stateLegacyBundleGen2.previous,
      releaseId: METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID,
      images: bootstrapManifest.images,
    };
    delete stateLegacyBundleGen2.previous.metricsRuntimeGeneration;
    writeJson(statePath, stateLegacyBundleGen2);
    const rejectedLegacyGen2 = runRelease('rollback', common, secretMarker, true);
    assert(
      rejectedLegacyGen2.status !== 0 &&
        /metrics runtime generation does not match its stored bundle/i.test(
          `${rejectedLegacyGen2.stdout}\n${rejectedLegacyGen2.stderr}`
        ),
      'Legacy state was not rejected against a verified generation 2 target bundle'
    );
    await assertRejectedRollbackUnchanged({
      runtimeRoot,
      expectedState: stateLegacyBundleGen2,
      bundle: bundleB,
      envFile,
      releaseId: RELEASE_B,
      manifest: manifestB,
      redisBefore,
      volumeName,
      queuedLeadId,
      queuedMarker,
      baseUrl,
    });
    writeJson(statePath, compatibleState);
    fs.rmSync(bootstrapBundle, { recursive: true, force: true });

    await interruptReleaseAtPhase('rollback', common, 'nginx-updating', secretMarker);
    const reconciledRollback = runRelease('rollback', common, secretMarker, true);
    assert(reconciledRollback.status !== 0, 'Interrupted rollback did not force an explicit retry');
    assert(
      /interrupted rollback operation was reconciled/i.test(
        `${reconciledRollback.stdout}\n${reconciledRollback.stderr}`
      ),
      'Interrupted rollback was not reconciled'
    );
    assertApplicationRelease(bundleB, envFile, RELEASE_B, manifestB);
    assertRedisIdentity(redisIdentity(bundleB, envFile, RELEASE_B, volumeName), redisBefore);
    assertQueuedLead(bundleB, envFile, RELEASE_B, queuedLeadId, queuedMarker);
    await assertPublicRelease(baseUrl, RELEASE_B);

    runRelease('rollback', common, secretMarker);
    assertActiveRelease(runtimeRoot, RELEASE_A);
    assertApplicationRelease(bundleA, envFile, RELEASE_A, manifestA);
    assertRedisIdentity(redisIdentity(bundleA, envFile, RELEASE_A, volumeName), redisBefore);
    assertQueuedLead(bundleA, envFile, RELEASE_A, queuedLeadId, queuedMarker);
    await assertPublicRelease(baseUrl, RELEASE_A);
    state = readState(runtimeRoot);
    assert(state.current.releaseId === RELEASE_A && state.previous.releaseId === RELEASE_B, 'B → A state is incorrect');

    const corruptBundle = path.join(tempRoot, 'corrupt-bundle');
    fs.cpSync(bundleBad, corruptBundle, { recursive: true });
    fs.appendFileSync(path.join(corruptBundle, 'compose.production.yml'), '\n# checksum corruption\n');
    const corrupt = runRelease('apply', { ...common, bundle: corruptBundle }, secretMarker, true);
    assert(
      corrupt.status !== 0 && /checksum mismatch/i.test(`${corrupt.stdout}\n${corrupt.stderr}`),
      'Corrupt bundle was not rejected'
    );
    assertApplicationRelease(bundleA, envFile, RELEASE_A, manifestA);
    assertRedisIdentity(redisIdentity(bundleA, envFile, RELEASE_A, volumeName), redisBefore);

    const failed = runRelease('apply', { ...common, bundle: bundleBad }, secretMarker, true);
    assert(failed.status !== 0, 'Unhealthy candidate unexpectedly passed');
    assert(
      /stable-application-restored/i.test(`${failed.stdout}\n${failed.stderr}`),
      'Failed candidate did not report app-layer recovery'
    );
    assertApplicationRelease(bundleA, envFile, RELEASE_A, manifestA);
    assertRedisIdentity(redisIdentity(bundleA, envFile, RELEASE_A, volumeName), redisBefore);
    assertQueuedLead(bundleA, envFile, RELEASE_A, queuedLeadId, queuedMarker);
    await assertPublicRelease(baseUrl, RELEASE_A);
    state = readState(runtimeRoot);
    assert(
      state.current.releaseId === RELEASE_A && state.previous.releaseId === RELEASE_B,
      'Failed candidate changed release state'
    );
    const failure = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'last-release-failure.json'), 'utf8'));
    assert(failure.containment === 'stable-application-restored', 'Failure record does not prove stable recovery');
    assert(!JSON.stringify(failure).includes(secretMarker), 'Failure record exposed the environment secret');
    assertNoBackupContainer();

    Object.assign(evidence, {
      status: 'PASS',
      redisIdentityUnchanged: true,
      queuedLeadSurvived: true,
      rollbackDidNotRestoreBackup: true,
      corruptBundleRejectedBeforeMutation: true,
      failedCandidateRecovered: true,
      interruptedPhasesRecovered: interruptedPhases,
      interruptedRollbackPhasesRecovered: ['nginx-updating'],
      newWorkerCycleRequired: true,
      activeReleaseLinkVerified: true,
      compatibleMetricsGenerationRollbackPassed: true,
      incompatibleLegacyRollbackRejectedBeforeMutation: true,
      stateGen2BundleLegacyRejectedBeforeMutation: true,
      stateLegacyBundleGen2RejectedBeforeMutation: true,
      logsSecretFree: true,
      finalRelease: state.current.releaseId,
    });
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    cleanup(tempRoot, volumeName, allRefs);
  }
}

main().catch((error) => {
  console.error(`[release-rollback-gate] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
