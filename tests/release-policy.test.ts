import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

const externalCommand = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('TEST_EXTERNAL_COMMAND_BOUNDARY');
  })
);
vi.mock('node:child_process', () => ({ spawnSync: externalCommand }));

import {
  METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID,
  SUPPORTED_METRICS_RUNTIME_GENERATION,
  assertBundleMatchesRecord,
  assertCurrentBundleCompatibleForApply,
  assertMetricsApplyCompatible,
  assertMetricsRollbackCompatible,
  assertProductionPublicSiteUrl,
  assertRedisIdentityUnchanged,
  assertSafeApplicationComposeArgs,
  readReleasePolicy,
  redactReleaseDiagnostic,
  releaseRecord,
  resolvePublicBuildConfig,
  syncActiveReleaseLink,
  verifyReleaseBundle,
  applyRelease,
  rollbackRelease,
  validateApplyDataContract,
  validateRollbackDataContract,
  validateRecoveryDataContract,
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

function createBundle(
  options: {
    releaseId?: string;
    legacyPolicy?: boolean;
    legacyManifest?: boolean;
    policyGeneration?: unknown;
    manifestGeneration?: unknown;
    dataContractVersion?: number;
  } = {}
) {
  const releaseId = options.releaseId || RELEASE_ID;
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
  const policyPath = path.join(root, 'config', 'release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
  if (options.dataContractVersion !== undefined) policy.dataContractVersion = options.dataContractVersion;
  if (options.legacyPolicy) delete policy.metricsRuntimeGeneration;
  else if (Object.hasOwn(options, 'policyGeneration')) {
    policy.metricsRuntimeGeneration = options.policyGeneration;
  }
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'images', 'app-images.tar'), 'app archive fixture');
  fs.writeFileSync(path.join(root, 'images', 'ops-images.tar'), 'ops archive fixture');
  const manifest: Record<string, unknown> = {
    schema: 1,
    releaseId,
    gitSha: releaseId,
    createdAt: '2026-09-20T00:00:00.000Z',
    canonicalOrigin: 'https://mebel-irkutsk.ru',
    publicBuildConfigSha256: 'e'.repeat(64),
    dataContractVersion: policy.dataContractVersion,
    platform: 'linux/amd64',
    images: {
      web: {
        ref: `mbl-web:${releaseId}`,
        id: `sha256:${'b'.repeat(64)}`,
        revision: releaseId,
        publicBuildConfigSha256: 'e'.repeat(64),
      },
      nginx: {
        ref: `mbl-nginx:${releaseId}`,
        id: `sha256:${'c'.repeat(64)}`,
        revision: releaseId,
        publicBuildConfigSha256: 'e'.repeat(64),
      },
      backup: {
        ref: `mbl-backup:${releaseId}`,
        id: `sha256:${'d'.repeat(64)}`,
        revision: releaseId,
        publicBuildConfigSha256: 'e'.repeat(64),
      },
    },
    archives: { application: 'images/app-images.tar', operations: 'images/ops-images.tar' },
  };
  if (!options.legacyManifest) {
    manifest.metricsRuntimeGeneration = Object.hasOwn(options, 'manifestGeneration')
      ? options.manifestGeneration
      : SUPPORTED_METRICS_RUNTIME_GENERATION;
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeReleaseChecksums(root);
  return root;
}

describe('O2.4 application release and rollback policy', () => {
  function contractRuntime(currentVersion: number, previousVersion: number) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-contract-runtime-'));
    const bundles = [
      createBundle({ releaseId: 'a'.repeat(40), dataContractVersion: currentVersion }),
      createBundle({ releaseId: 'b'.repeat(40), dataContractVersion: previousVersion }),
    ];
    const records = bundles.map((directory) => {
      const bundle = verifyReleaseBundle(directory, { allowHistoricalDataContract: true });
      fs.cpSync(directory, path.join(root, 'releases', bundle.manifest.releaseId), { recursive: true });
      return releaseRecord(bundle);
    });
    const state = {
      schema: 1,
      current: records[0],
      previous: records[1],
      redisIdentity: { containerId: 'isolated-redis', imageId: 'redis-image', volumeName: 'isolated-volume' },
    };
    fs.writeFileSync(path.join(root, 'release-state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(root, 'redis-data-proof'), 'queued synthetic lead');
    fs.writeFileSync(path.join(root, 'deploy.env'), 'SYNTHETIC_ONLY=true\n', { mode: 0o600 });
    syncActiveReleaseLink(root, records[0].releaseId);
    return {
      root,
      state,
      bundles,
      cleanup() {
        fs.rmSync(root, { recursive: true, force: true });
        bundles.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
      },
    };
  }

  function snapshotRuntime(root: string) {
    return {
      state: fs.readFileSync(path.join(root, 'release-state.json'), 'utf8'),
      link: fs.readlinkSync(path.join(root, 'current')),
      data: fs.readFileSync(path.join(root, 'redis-data-proof'), 'utf8'),
      journal: fs.existsSync(path.join(root, 'release-operation.json'))
        ? fs.readFileSync(path.join(root, 'release-operation.json'), 'utf8')
        : null,
    };
  }

  test.each([
    [2, 1],
    [1, 2],
  ])(
    'production rollback rejects %i to %i before external commands or filesystem mutation',
    async (current, target) => {
      const fixture = contractRuntime(current, target);
      try {
        const before = snapshotRuntime(fixture.root);
        externalCommand.mockClear();
        await expect(
          rollbackRelease({
            runtimeRoot: fixture.root,
            envFile: path.join(fixture.root, 'deploy.env'),
            baseUrl: 'http://127.0.0.1:1',
          })
        ).rejects.toThrow(`ROLLBACK_DATA_CONTRACT_MISMATCH: current=${current} target=${target}`);
        expect(externalCommand).not.toHaveBeenCalled();
        expect(snapshotRuntime(fixture.root)).toEqual(before);
        expect(fs.existsSync(path.join(fixture.root, '.release.lock'))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  );

  test('verified v2 rollback and fresh/same-contract apply pass read-only preflight', () => {
    const fixture = contractRuntime(2, 2);
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-fresh-v2-'));
    try {
      const source = verifyReleaseBundle(fixture.bundles[1]);
      expect(() => validateRollbackDataContract(fixture.root)).not.toThrow();
      expect(() => validateApplyDataContract(source, fixture.root)).not.toThrow();
      expect(() => validateApplyDataContract(source, fresh)).not.toThrow();
      expect(releaseRecord(source).dataContractVersion).toBe(2);
    } finally {
      fixture.cleanup();
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('production apply rejects a v1 current even with a valid v2 candidate', async () => {
    const fixture = contractRuntime(1, 2);
    try {
      const before = snapshotRuntime(fixture.root);
      externalCommand.mockClear();
      await expect(
        applyRelease({
          bundleDirectory: fixture.bundles[1],
          runtimeRoot: fixture.root,
          envFile: path.join(fixture.root, 'deploy.env'),
          baseUrl: 'http://127.0.0.1:1',
        })
      ).rejects.toThrow('APPLY_DATA_CONTRACT_MISMATCH: current=1 target=2');
      expect(externalCommand).not.toHaveBeenCalled();
      expect(snapshotRuntime(fixture.root)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    [2, 1],
    [1, 2],
    [2, 2],
  ])('interrupted recovery verifies %i source and %i target before mutation', async (sourceVersion, targetVersion) => {
    const fixture = contractRuntime(sourceVersion, targetVersion);
    const journal = {
      schema: 1,
      operationId: 'synthetic-interruption',
      kind: 'apply',
      phase: 'web-updated',
      candidateReleaseId: fixture.state.previous.releaseId,
      stableReleaseId: fixture.state.current.releaseId,
      targetDataContractVersion: targetVersion,
      sourceDataContractVersion: sourceVersion,
      redisIdentityBefore: fixture.state.redisIdentity,
    };
    try {
      fs.writeFileSync(path.join(fixture.root, 'release-operation.json'), JSON.stringify(journal));
      const before = snapshotRuntime(fixture.root);
      externalCommand.mockClear();
      if (sourceVersion === targetVersion) {
        expect(() => validateRecoveryDataContract(fixture.root, journal, fixture.state)).not.toThrow();
      } else {
        await expect(
          rollbackRelease({
            runtimeRoot: fixture.root,
            envFile: path.join(fixture.root, 'deploy.env'),
            baseUrl: 'http://127.0.0.1:1',
          })
        ).rejects.toThrow(`RECOVERY_DATA_CONTRACT_MISMATCH: current=${sourceVersion} target=${targetVersion}`);
        expect(externalCommand).not.toHaveBeenCalled();
        expect(snapshotRuntime(fixture.root)).toEqual(before);
        expect(fs.existsSync(path.join(fixture.root, '.release.lock'))).toBe(false);
      }
    } finally {
      fixture.cleanup();
    }
  });

  test.each(['missing', 'forged'])('recovery rejects %s journal versions without commands', async (scenario) => {
    const fixture = contractRuntime(2, 2);
    try {
      const journal = {
        schema: 1,
        operationId: 'synthetic-invalid-journal',
        kind: 'apply',
        candidateReleaseId: fixture.state.previous.releaseId,
        stableReleaseId: fixture.state.current.releaseId,
        ...(scenario === 'forged' ? { targetDataContractVersion: 1, sourceDataContractVersion: 2 } : {}),
      };
      fs.writeFileSync(path.join(fixture.root, 'release-operation.json'), JSON.stringify(journal));
      const before = snapshotRuntime(fixture.root);
      externalCommand.mockClear();
      await expect(
        rollbackRelease({
          runtimeRoot: fixture.root,
          envFile: path.join(fixture.root, 'deploy.env'),
          baseUrl: 'http://127.0.0.1:1',
        })
      ).rejects.toThrow('RECOVERY_DATA_CONTRACT_MISMATCH');
      expect(externalCommand).not.toHaveBeenCalled();
      expect(snapshotRuntime(fixture.root)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  test('version tampering and state-to-artifact drift are rejected', () => {
    const fixture = contractRuntime(2, 2);
    try {
      const state = { ...fixture.state, previous: { ...fixture.state.previous, dataContractVersion: 1 } };
      fs.writeFileSync(path.join(fixture.root, 'release-state.json'), JSON.stringify(state));
      expect(() => validateRollbackDataContract(fixture.root)).toThrow(/data-contract/i);
      const manifestPath = path.join(fixture.bundles[1], 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dataContractVersion: 1 }));
      expect(() => verifyReleaseBundle(fixture.bundles[1])).toThrow(/Checksum mismatch/);
      writeReleaseChecksums(fixture.bundles[1]);
      expect(() => verifyReleaseBundle(fixture.bundles[1])).toThrow(/versions differ/);
    } finally {
      fixture.cleanup();
    }
  });
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
    expect(policy.metricsRuntimeGeneration).toBe(SUPPORTED_METRICS_RUNTIME_GENERATION);
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

  test.each([
    ['generation 1', 1],
    ['zero generation', 0],
    ['negative generation', -1],
    ['fractional generation', 1.5],
    ['string generation', '2'],
    ['future generation', 3],
  ])('rejects an unsupported release-policy %s', (_label, generation) => {
    const root = createBundle({ policyGeneration: generation, manifestGeneration: generation });
    try {
      expect(() => readReleasePolicy(path.join(root, 'config', 'release-policy.json'))).toThrow(
        /metrics runtime generation/i
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps missing generation distinguishable and rejects it in a new release policy', () => {
    const root = createBundle({ legacyPolicy: true, legacyManifest: true });
    try {
      expect(() => readReleasePolicy(path.join(root, 'config', 'release-policy.json'))).toThrow(
        /metricsRuntimeGeneration is required/i
      );
      const legacy = readReleasePolicy(path.join(root, 'config', 'release-policy.json'), {
        allowLegacyMetricsRuntimeGeneration: true,
      });
      expect(Object.hasOwn(legacy, 'metricsRuntimeGeneration')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a manifest generation that does not match its release policy', () => {
    const root = createBundle({ legacyManifest: true });
    try {
      expect(() => verifyReleaseBundle(root, { allowLegacyMetricsRuntimeGeneration: true })).toThrow(
        /manifest and policy metrics runtime generations differ/i
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ['uppercase', METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID.toUpperCase()],
    ['leading whitespace', ` ${METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID}`],
    ['trailing whitespace', `${METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID} `],
  ])('rejects a non-canonical %s persisted manifest release ID', (_label, releaseId) => {
    const root = createBundle({ releaseId });
    try {
      expect(() => verifyReleaseBundle(root)).toThrow(/exact lowercase 40-character Git SHA/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('persists metrics generation in new release records without upgrading legacy records', () => {
    const currentRoot = createBundle();
    const legacyRoot = createBundle({
      releaseId: METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID,
      legacyPolicy: true,
      legacyManifest: true,
    });
    try {
      const current = verifyReleaseBundle(currentRoot);
      expect(releaseRecord(current).metricsRuntimeGeneration).toBe(SUPPORTED_METRICS_RUNTIME_GENERATION);

      const legacy = verifyReleaseBundle(legacyRoot, { allowLegacyMetricsRuntimeGeneration: true });
      expect(Object.hasOwn(releaseRecord(legacy), 'metricsRuntimeGeneration')).toBe(false);
    } finally {
      fs.rmSync(currentRoot, { recursive: true, force: true });
      fs.rmSync(legacyRoot, { recursive: true, force: true });
    }
  });

  test('allows only generation 2 or the exact legacy bootstrap as rollback targets', () => {
    const current = { releaseId: 'f'.repeat(40), metricsRuntimeGeneration: 2 };
    expect(() =>
      assertMetricsRollbackCompatible({ releaseId: 'a'.repeat(40), metricsRuntimeGeneration: 2 }, current)
    ).not.toThrow();
    expect(() =>
      assertMetricsRollbackCompatible({ releaseId: METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID }, current)
    ).not.toThrow();

    for (const target of [
      { releaseId: METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID.toUpperCase() },
      { releaseId: ` ${METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID}` },
      { releaseId: `${METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID} ` },
      { releaseId: METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID.slice(0, 8) },
      { releaseId: '8c34c97a5fed70db90184966fd5868a39aa4f292' },
      { releaseId: 'd'.repeat(40) },
      { releaseId: '1'.repeat(40), metricsRuntimeGeneration: 1 },
      { releaseId: '2'.repeat(40), metricsRuntimeGeneration: 0 },
      { releaseId: '3'.repeat(40), metricsRuntimeGeneration: -1 },
      { releaseId: '4'.repeat(40), metricsRuntimeGeneration: 1.5 },
      { releaseId: '5'.repeat(40), metricsRuntimeGeneration: '2' },
      { releaseId: '6'.repeat(40), metricsRuntimeGeneration: 3 },
    ]) {
      expect(() => assertMetricsRollbackCompatible(target, current)).toThrow(
        /ROLLBACK_TARGET_METRICS_RUNTIME_INCOMPATIBLE/
      );
    }
  });

  test('allows normal apply only from no current, generation 2 or the exact legacy bootstrap', () => {
    expect(() => assertMetricsApplyCompatible(null)).not.toThrow();
    expect(() =>
      assertMetricsApplyCompatible({ releaseId: 'a'.repeat(40), metricsRuntimeGeneration: 2 })
    ).not.toThrow();
    expect(() => assertMetricsApplyCompatible({ releaseId: METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID })).not.toThrow();

    for (const current of [
      { releaseId: '8c34c97a5fed70db90184966fd5868a39aa4f292' },
      { releaseId: 'd'.repeat(40) },
      { releaseId: METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID.toUpperCase() },
      { releaseId: ` ${METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID}` },
      { releaseId: `${METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID} ` },
      { releaseId: 'e'.repeat(40), metricsRuntimeGeneration: 1 },
      { releaseId: 'f'.repeat(40), metricsRuntimeGeneration: 3 },
    ]) {
      expect(() => assertMetricsApplyCompatible(current)).toThrow(/APPLY_CURRENT_METRICS_RUNTIME_INCOMPATIBLE/);
    }
  });

  test('binds canonical release identity and generation presence exactly between state and bundle', () => {
    const root = createBundle();
    try {
      const bundle = verifyReleaseBundle(root);
      const generationRecord = releaseRecord(bundle);
      const legacyRecord = structuredClone(generationRecord);
      delete legacyRecord.metricsRuntimeGeneration;
      const legacyBundle = structuredClone(bundle);
      delete legacyBundle.manifest.metricsRuntimeGeneration;

      expect(() => assertBundleMatchesRecord(bundle, legacyRecord, 'Legacy state')).toThrow(
        /metrics runtime generation does not match/i
      );
      expect(() => assertBundleMatchesRecord(legacyBundle, generationRecord, 'Legacy bundle')).toThrow(
        /metrics runtime generation does not match/i
      );

      const wrongGeneration = structuredClone(generationRecord);
      wrongGeneration.metricsRuntimeGeneration = 1;
      expect(() => assertBundleMatchesRecord(bundle, wrongGeneration, 'Wrong generation')).toThrow(
        /metrics runtime generation does not match/i
      );

      const wrongRelease = structuredClone(generationRecord);
      wrongRelease.releaseId = 'f'.repeat(40);
      expect(() => assertBundleMatchesRecord(bundle, wrongRelease, 'Wrong release')).toThrow(/release ID/i);

      const uppercaseState = structuredClone(generationRecord);
      uppercaseState.releaseId = generationRecord.releaseId.toUpperCase();
      expect(() => assertBundleMatchesRecord(bundle, uppercaseState, 'Uppercase state')).toThrow(
        /exact lowercase 40-character Git SHA/i
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps bootstrap apply preconditions readable and permits generation 2 rollback to it', () => {
    const bootstrapRoot = createBundle({
      releaseId: METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID,
      legacyPolicy: true,
      legacyManifest: true,
    });
    const candidateRoot = createBundle({ releaseId: 'b'.repeat(40) });
    try {
      const bootstrap = verifyReleaseBundle(bootstrapRoot, { allowLegacyMetricsRuntimeGeneration: true });
      const candidate = verifyReleaseBundle(candidateRoot);
      const bootstrapRecord = releaseRecord(bootstrap);
      const candidateRecord = releaseRecord(candidate);

      expect(() =>
        assertCurrentBundleCompatibleForApply(bootstrap, bootstrapRecord, 'Bootstrap release')
      ).not.toThrow();
      expect(candidateRecord.metricsRuntimeGeneration).toBe(2);
      expect(() => assertMetricsRollbackCompatible(bootstrapRecord, candidateRecord)).not.toThrow();
    } finally {
      fs.rmSync(bootstrapRoot, { recursive: true, force: true });
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  test('rejects arbitrary legacy apply and a bootstrap claim that does not match the verified bundle', () => {
    const arbitraryRoot = createBundle({
      releaseId: '8c34c97a5fed70db90184966fd5868a39aa4f292',
      legacyPolicy: true,
      legacyManifest: true,
    });
    try {
      const arbitrary = verifyReleaseBundle(arbitraryRoot, { allowLegacyMetricsRuntimeGeneration: true });
      const arbitraryRecord = releaseRecord(arbitrary);
      expect(() => assertCurrentBundleCompatibleForApply(arbitrary, arbitraryRecord)).toThrow(
        /APPLY_CURRENT_METRICS_RUNTIME_INCOMPATIBLE/
      );

      const spoofedBootstrapRecord = {
        ...arbitraryRecord,
        releaseId: METRICS_RUNTIME_BOOTSTRAP_RELEASE_ID,
      };
      expect(() => assertCurrentBundleCompatibleForApply(arbitrary, spoofedBootstrapRecord)).toThrow(
        /release ID does not match its stored bundle/i
      );
    } finally {
      fs.rmSync(arbitraryRoot, { recursive: true, force: true });
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
