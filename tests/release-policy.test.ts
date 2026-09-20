import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  assertBundleMatchesRecord,
  assertRedisIdentityUnchanged,
  assertSafeApplicationComposeArgs,
  readReleasePolicy,
  redactReleaseDiagnostic,
  verifyReleaseBundle,
  writeReleaseChecksums,
} from '../scripts/release-tool.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE_ID = 'a'.repeat(40);

function copy(root: string, relative: string) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(ROOT, relative), target);
}

function createBundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-release-policy-'));
  for (const relative of [
    'compose.production.yml',
    'compose.backup.yml',
    'compose.release.yml',
    'config/release-policy.json',
    'scripts/release-tool.mjs',
    'docs/release-and-rollback.md',
  ]) {
    copy(root, relative);
  }
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'images', 'app-images.tar'), 'app archive fixture');
  fs.writeFileSync(path.join(root, 'images', 'ops-images.tar'), 'ops archive fixture');
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    `${JSON.stringify(
      {
        schema: 1,
        releaseId: RELEASE_ID,
        gitSha: RELEASE_ID,
        createdAt: '2026-09-20T00:00:00.000Z',
        canonicalOrigin: 'https://mebel-irkutsk.ru',
        dataContractVersion: 1,
        platform: 'linux/amd64',
        images: {
          web: { ref: `mbl-web:${RELEASE_ID}`, id: `sha256:${'b'.repeat(64)}`, revision: RELEASE_ID },
          nginx: { ref: `mbl-nginx:${RELEASE_ID}`, id: `sha256:${'c'.repeat(64)}`, revision: RELEASE_ID },
          backup: { ref: `mbl-backup:${RELEASE_ID}`, id: `sha256:${'d'.repeat(64)}`, revision: RELEASE_ID },
        },
        archives: { application: 'images/app-images.tar', operations: 'images/ops-images.tar' },
      },
      null,
      2
    )}\n`
  );
  writeReleaseChecksums(root);
  return root;
}

describe('O2.4 application release and rollback policy', () => {
  test('limits the mutable release layer to web, worker and Nginx', () => {
    const policy = readReleasePolicy(path.join(ROOT, 'config', 'release-policy.json'));
    expect(policy.applicationServices).toEqual(['mbl-web', 'mbl-worker-trigger', 'mbl-nginx']);
    expect(policy.statefulServices).toEqual(['mbl-redis']);
    expect(policy.redisDataDestination).toBe('/data');
  });

  test('permits only bounded app-only Compose update and stop commands', () => {
    const policy = readReleasePolicy(path.join(ROOT, 'config', 'release-policy.json'));
    expect(() =>
      assertSafeApplicationComposeArgs(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'mbl-web'], policy)
    ).not.toThrow();
    expect(() =>
      assertSafeApplicationComposeArgs(['stop', 'mbl-worker-trigger', 'mbl-nginx', 'mbl-web'], policy)
    ).not.toThrow();
    expect(() => assertSafeApplicationComposeArgs(['down'], policy)).toThrow();
    expect(() =>
      assertSafeApplicationComposeArgs(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'mbl-redis'], policy)
    ).toThrow(/never target mbl-redis/i);
    expect(() =>
      assertSafeApplicationComposeArgs(['up', '-d', '--no-build', '--pull', 'never', 'mbl-web'], policy)
    ).toThrow(/--no-deps/);
    expect(() =>
      assertSafeApplicationComposeArgs(['up', '-d', '--no-deps', '--no-build', '--pull', 'always', 'mbl-web'], policy)
    ).toThrow(/--pull never/);
  });

  test('removes build definitions and forbids pulls in the VPS release overlay', () => {
    const overlay = fs.readFileSync(path.join(ROOT, 'compose.release.yml'), 'utf8');
    for (const service of ['mbl-web', 'mbl-worker-trigger', 'mbl-nginx', 'mbl-backup']) {
      expect(overlay).toMatch(new RegExp(`${service}:[\\s\\S]*?build: !reset null[\\s\\S]*?pull_policy: never`));
    }
    expect(overlay).toMatch(/mbl-redis:[\s\S]*?pull_policy: never/);
  });

  test('verifies every bundle file and rejects corruption before deployment', () => {
    const root = createBundle();
    try {
      expect(verifyReleaseBundle(root).manifest.releaseId).toBe(RELEASE_ID);
      fs.appendFileSync(path.join(root, 'compose.production.yml'), '\n# corrupted\n');
      expect(() => verifyReleaseBundle(root)).toThrow(/checksum mismatch/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('binds rollback state to the exact stored release and image IDs', () => {
    const root = createBundle();
    try {
      const bundle = verifyReleaseBundle(root);
      expect(() => assertBundleMatchesRecord(bundle, bundle.manifest, 'Fixture')).not.toThrow();
      const wrongRecord = structuredClone(bundle.manifest);
      wrongRecord.images.web.id = `sha256:${'e'.repeat(64)}`;
      expect(() => assertBundleMatchesRecord(bundle, wrongRecord, 'Fixture')).toThrow(/web image ID/i);
      wrongRecord.images.web.id = bundle.manifest.images.web.id;
      wrongRecord.releaseId = 'f'.repeat(40);
      expect(() => assertBundleMatchesRecord(bundle, wrongRecord, 'Fixture')).toThrow(/release ID/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires the exact Redis container, image and volume across release operations', () => {
    const identity = {
      containerId: `sha256:${'1'.repeat(64)}`,
      imageId: `sha256:${'2'.repeat(64)}`,
      volumeName: 'mbl_redis_data',
    };

    expect(() => assertRedisIdentityUnchanged(identity, { ...identity })).not.toThrow();
    expect(() =>
      assertRedisIdentityUnchanged(identity, { ...identity, containerId: `sha256:${'3'.repeat(64)}` })
    ).toThrow(/recreated the Redis container/i);
    expect(() => assertRedisIdentityUnchanged(identity, { ...identity, imageId: `sha256:${'4'.repeat(64)}` })).toThrow(
      /changed the Redis image/i
    );
    expect(() => assertRedisIdentityUnchanged(identity, { ...identity, volumeName: 'replacement_volume' })).toThrow(
      /changed the Redis volume/i
    );
  });

  test('rejects secret-like material even when a checksum covers it', () => {
    const root = createBundle();
    try {
      fs.writeFileSync(path.join(root, '.env'), 'METRICS_ADMIN_TOKEN=must-not-ship\n');
      writeReleaseChecksums(root);
      expect(() => verifyReleaseBundle(root)).toThrow(/secret-like path/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('redacts tokens, passwords and Redis credentials from release diagnostics', () => {
    const output = redactReleaseDiagnostic(
      'authorization=Bearer private-token password=private-password redis://user:private@redis:6379',
      ['private-token', 'private-password']
    );
    expect(output).not.toContain('private-token');
    expect(output).not.toContain('private-password');
    expect(output).not.toContain('user:private');
  });

  test('does not couple application rollback to the Redis restore mechanism', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'release-tool.mjs'), 'utf8');
    expect(source).not.toContain('redis-backup.mjs');
    expect(source).not.toContain('MBL_BACKUP_RESTORE_CONFIRM');
    expect(source).not.toMatch(/mbl-backup['"],?\s*['"]restore/i);
  });

  test('builds release images from an immutable archive of the exact clean commit', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'release-tool.mjs'), 'utf8');
    expect(source).toMatch(/git['"], \['archive'/);
    expect(source).toContain('immutableSource.contextDirectory');
    expect(source).toContain('assertCleanReleaseCheckout(releaseId)');
  });
});
