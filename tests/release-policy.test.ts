import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  assertBundleMatchesRecord,
  assertProductionPublicSiteUrl,
  assertRedisIdentityUnchanged,
  assertSafeApplicationComposeArgs,
  readReleasePolicy,
  redactReleaseDiagnostic,
  resolvePublicBuildConfig,
  syncActiveReleaseLink,
  verifyReleaseBundle,
  writeReleaseChecksums,
} from '../scripts/release-tool.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE_ID = 'a'.repeat(40);
const PUBLIC_CONFIG = {
  PUBLIC_SITE_URL: 'https://mbl-release.test',
  PUBLIC_PRIMARY_SEO_CITY_ID: 'irkutsk',
  PUBLIC_ENABLE_LEAD_TRACKING: 'true',
  PUBLIC_YANDEX_METRIKA_ID: '12345678',
  PUBLIC_YANDEX_VERIFICATION: 'synthetic-verification',
  PUBLIC_GA4_ID: 'G-SYNTHETIC1',
  PUBLIC_LEAD_FORM_ABANDON_MS: '60000',
  PUBLIC_ENABLE_RUM_WEB_VITALS: 'true',
  PUBLIC_RUM_LCP_ALERT_THRESHOLD_MS: '2500',
  PUBLIC_BUSINESS_PHONE: '+7 (900) 000-00-01',
  PUBLIC_BUSINESS_EMAIL: 'release@example.invalid',
  PUBLIC_BUSINESS_ADDRESS_LOCALITY: 'Иркутск',
  PUBLIC_BUSINESS_ADDRESS_DISTRICT: 'Тестовый район',
  PUBLIC_BUSINESS_STREET_ADDRESS: 'Тестовая улица, 1',
  PUBLIC_BUSINESS_REGION: 'Иркутская область',
  PUBLIC_BUSINESS_POSTAL_CODE: '664000',
  PUBLIC_BUSINESS_OPENING_HOURS: 'Mo-Fr 09:00-18:00',
  PUBLIC_BUSINESS_OPENING_HOURS_TEXT: 'Пн–Пт: 09:00–18:00',
  PUBLIC_BUSINESS_IMAGE: 'https://assets.example.invalid/business.jpg',
  PUBLIC_BUSINESS_SAME_AS: 'https://social.example.invalid/mbl',
  PUBLIC_TELEGRAM_URL: 'https://t.me/mbl_release_test',
  PUBLIC_BUSINESS_YANDEX_MAPS_URL: 'https://yandex.example.invalid/maps/mbl',
  PUBLIC_BUSINESS_GOOGLE_MAPS_URL: 'https://google.example.invalid/maps/mbl',
  PUBLIC_BUSINESS_PRICE_RANGE: '₽₽',
  PUBLIC_BUSINESS_LAT: '52.2864',
  PUBLIC_BUSINESS_LON: '104.2808',
  PUBLIC_BUSINESS_LEGAL_NAME: 'ИП Тестовый Владелец',
  PUBLIC_BUSINESS_TAX_ID: '000000000000',
  PUBLIC_BUSINESS_REGISTRATION_ID: '000000000000000',
  PUBLIC_BUSINESS_CHECKING_ACCOUNT: '00000000000000000000',
  PUBLIC_BUSINESS_BIC: '000000000',
  PUBLIC_BUSINESS_BANK_NAME: 'Тестовый банк',
  PUBLIC_BUSINESS_REGISTERED_ADDRESS: 'Иркутск, тестовый адрес',
};

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
    'config/public-build-env.json',
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
        publicBuildConfigSha256: 'e'.repeat(64),
        dataContractVersion: 1,
        platform: 'linux/amd64',
        images: {
          web: {
            ref: `mbl-web:${RELEASE_ID}`,
            id: `sha256:${'b'.repeat(64)}`,
            revision: RELEASE_ID,
            publicBuildConfigSha256: 'e'.repeat(64),
          },
          nginx: {
            ref: `mbl-nginx:${RELEASE_ID}`,
            id: `sha256:${'c'.repeat(64)}`,
            revision: RELEASE_ID,
            publicBuildConfigSha256: 'e'.repeat(64),
          },
          backup: {
            ref: `mbl-backup:${RELEASE_ID}`,
            id: `sha256:${'d'.repeat(64)}`,
            revision: RELEASE_ID,
            publicBuildConfigSha256: 'e'.repeat(64),
          },
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
  test('validates the production origin without running a deploy', () => {
    expect(() => assertProductionPublicSiteUrl('')).toThrow(/required/i);
    expect(() => assertProductionPublicSiteUrl('https://example.com')).toThrow(/placeholder or local host/i);
    expect(() => assertProductionPublicSiteUrl('http://mebel-irkutsk.ru')).toThrow(/canonical HTTPS origin/i);
    expect(() => assertProductionPublicSiteUrl('https://localhost')).toThrow(/placeholder or local host/i);
    expect(() => assertProductionPublicSiteUrl('https://mebel-irkutsk.ru/path')).toThrow(/pathname|bare origin/i);
    expect(() => assertProductionPublicSiteUrl('https://mebel-irkutsk.ru?x=1')).toThrow(/query|string|bare origin/i);
    expect(() => assertProductionPublicSiteUrl('https://mebel-irkutsk.ru#top')).toThrow(/hash|bare origin/i);
    expect(assertProductionPublicSiteUrl('https://mebel-irkutsk.ru')).toBe('https://mebel-irkutsk.ru');
  });

  test('requires the explicit public release allowlist and ignores unlisted values', () => {
    const resolved = resolvePublicBuildConfig({ ...PUBLIC_CONFIG, PRIVATE_TOKEN: 'must-not-pass' });
    expect(resolved).toEqual(PUBLIC_CONFIG);
    expect(resolved).not.toHaveProperty('PRIVATE_TOKEN');
    expect(() => resolvePublicBuildConfig({ ...PUBLIC_CONFIG, PUBLIC_GA4_ID: '' })).toThrow(
      /PUBLIC_GA4_ID is required/
    );
    expect(() => resolvePublicBuildConfig({ ...PUBLIC_CONFIG, PUBLIC_PRIMARY_SEO_CITY_ID: 'angarsk' })).toThrow(
      /must be irkutsk/
    );
  });

  test('keeps Docker and Compose build arguments aligned with the approved allowlist', () => {
    const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/public-build-env.json'), 'utf8')) as {
      required: string[];
    };
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const compose = fs.readFileSync(path.join(ROOT, 'compose.production.yml'), 'utf8');
    const dockerArgs = [...dockerfile.matchAll(/^ARG (PUBLIC_[A-Z0-9_]+)$/gm)].map((match) => match[1]).sort();
    const composeArgs = [...compose.matchAll(/^ {2}(PUBLIC_[A-Z0-9_]+):/gm)].map((match) => match[1]).sort();
    expect(dockerArgs).toEqual([...policy.required].sort());
    expect(composeArgs).toEqual([...policy.required].sort());
  });

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

  test('passes the selected production origin into the immutable build and runtime gate', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'release-tool.mjs'), 'utf8');
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    expect(source).toContain('Object.entries(publicBuildConfig)');
    expect(source).toContain('O23_CANONICAL_ORIGIN: publicSiteUrl');
    expect(dockerfile).toContain('ARG PUBLIC_SITE_URL');
    expect(dockerfile).not.toContain('ARG PUBLIC_SITE_URL=https://example.com');
  });

  test('keeps a stable active-release link on the exact committed bundle', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-active-release-'));
    const releaseA = 'a'.repeat(40);
    const releaseB = 'b'.repeat(40);
    try {
      fs.mkdirSync(path.join(runtimeRoot, 'releases', releaseA), { recursive: true });
      fs.mkdirSync(path.join(runtimeRoot, 'releases', releaseB), { recursive: true });
      const linkPath = syncActiveReleaseLink(runtimeRoot, releaseA);
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(path.join(runtimeRoot, 'releases', releaseA)));

      syncActiveReleaseLink(runtimeRoot, releaseB);
      expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(path.join(runtimeRoot, 'releases', releaseB)));
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
