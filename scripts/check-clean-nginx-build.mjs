import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-clean-nginx-'));
const archiveRoot = path.join(tempRoot, 'archive');
const sourceRoot = path.join(tempRoot, 'source');
const overlayFiles = ['Dockerfile', '.gitignore', 'package.json', 'scripts/check-clean-nginx-build.mjs'];
const imageTag = `mbl-clean-nginx-check-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const containerName = `mbl-nginx-check-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

function fail(message, details = '') {
  throw new Error(`${message}${details ? `\n${details}` : ''}`);
}

function run(command, args, options = {}) {
  const { allowFailure = false } = options;
  try {
    return execFileSync(command, args, {
      cwd: options.cwd || tempRoot,
      env: { ...process.env, ...(options.env || {}) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stdout = String(error?.stdout || '');
    const stderr = String(error?.stderr || '');
    const details = [stdout, stderr].filter(Boolean).join('\n').trim();
    if (allowFailure) {
      return details || error?.message || 'unknown error';
    }
    throw new Error(`${command} ${args.join(' ')} failed\n${details || error?.message || 'unknown error'}`);
  }
}

function extractArchive() {
  const archivePath = path.join(tempRoot, 'repo.tar');
  execFileSync('git', ['archive', '--format=tar', `--output=${archivePath}`, 'HEAD'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  fs.mkdirSync(archiveRoot, { recursive: true });
  execFileSync('tar', ['-xf', archivePath, '-C', archiveRoot], {
    cwd: tempRoot,
    stdio: 'inherit',
  });
}

function mergeArchiveIntoSource() {
  fs.mkdirSync(sourceRoot, { recursive: true });
  const archiveEntries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  for (const entry of archiveEntries) {
    const archivePath = path.join(archiveRoot, entry.name);
    const destPath = path.join(sourceRoot, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(archivePath, destPath, { recursive: true, force: true });
    } else {
      fs.copyFileSync(archivePath, destPath);
    }
  }
}

function overlayApprovedFiles() {
  for (const file of overlayFiles) {
    const src = path.join(repoRoot, file);
    const dest = path.join(sourceRoot, file);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

try {
  extractArchive();
  mergeArchiveIntoSource();
  overlayApprovedFiles();

  run('docker', [
    'build',
    '--pull=false',
    '--target',
    'nginx-runtime',
    '--build-arg',
    'PUBLIC_SITE_URL=https://example.com',
    '--tag',
    imageTag,
    sourceRoot,
  ]);

  const fileCheckOutput = run('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    imageTag,
    '-lc',
    'ls -l /etc/nginx/generated && test -f /etc/nginx/generated/public-origin.conf && echo PUBLIC_ORIGIN_PRESENT && test -f /etc/nginx/generated/proxy-common.conf && echo PROXY_COMMON_PRESENT',
  ]);
  if (
    !/PUBLIC_ORIGIN_PRESENT/.test(String(fileCheckOutput || '')) ||
    !/PROXY_COMMON_PRESENT/.test(String(fileCheckOutput || ''))
  ) {
    fail('required generated edge files were not present in the built nginx image', String(fileCheckOutput || ''));
  }

  const nginxTestOutput = run('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    imageTag,
    '-lc',
    'nginx -t -c /etc/nginx/nginx.conf > /tmp/nginx-test.log 2>&1; status=$?; cat /tmp/nginx-test.log; exit $status',
  ]);
  if (nginxTestOutput && /test is successful|syntax is okay/i.test(String(nginxTestOutput))) {
    console.log(nginxTestOutput.trim());
  } else {
    fail('nginx -t exited non-zero in the built image', String(nginxTestOutput || ''));
  }

  run('docker', ['run', '-d', '--rm', '--name', containerName, '-p', '127.0.0.1:0:8080', imageTag]);
  try {
    const portOutput = String(run('docker', ['port', containerName, '8080'])).trim();
    const hostPort = Number((portOutput.match(/:(\d+)$/) || [])[1]);
    if (!hostPort || Number.isNaN(hostPort)) {
      fail('failed to determine the ephemeral host port for the temporary nginx container', portOutput || '');
    }

    const assetOutput = run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      imageTag,
      '-lc',
      'find /usr/share/nginx/html -type f | sed "s#^/usr/share/nginx/html/##" | grep -E "\\.(svg|png|jpg|jpeg|gif|webp|avif|css|js)(\\?.*)?$" | head -n 1',
    ]);
    const asset = String(assetOutput || '').trim();
    if (!asset) {
      fail('could not locate a static asset inside the built nginx image');
    }

    const allowedHttp = run(
      'docker',
      [
        'exec',
        containerName,
        'sh',
        '-lc',
        `wget -S -O /dev/null --header="Host: localhost" "http://127.0.0.1:8080/${asset}" 2>&1`,
      ],
      { allowFailure: true }
    );
    if (!/HTTP\/1\.1\s+200\s+OK|HTTP\/1\.1\s+200/i.test(String(allowedHttp || ''))) {
      fail('expected allowed local Host to serve a static file over HTTP', String(allowedHttp || ''));
    }

    const blockedHttp = run(
      'docker',
      [
        'exec',
        containerName,
        'sh',
        '-lc',
        `wget -S -O /dev/null --header="Host: evil.example" "http://127.0.0.1:8080/${asset}" 2>&1 || true`,
      ],
      { allowFailure: true }
    );
    if (!/HTTP\/1\.1\s+421/i.test(String(blockedHttp || ''))) {
      fail('expected unknown Host to be rejected with HTTP 421', String(blockedHttp || ''));
    }

    console.log('[clean-nginx-build] static file served with allowed Host');
    console.log('[clean-nginx-build] unknown Host rejected with 421');
  } finally {
    run('docker', ['rm', '-f', containerName], { allowFailure: true });
  }

  console.log('[clean-nginx-build] PASS');
  console.log('[clean-nginx-build] public-origin.conf exists in image');
  console.log('[clean-nginx-build] proxy-common.conf exists in image');
  console.log('[clean-nginx-build] nginx -t passed');
  console.log('[clean-nginx-build] allowed local Host served static content and unknown Host was blocked');
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  try {
    run('docker', ['rmi', '-f', imageTag], { allowFailure: true });
  } catch {
    // no-op: cleanup for the temporary validation image only
  }
}
