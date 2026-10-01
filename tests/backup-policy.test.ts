import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

const externalCommand = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: externalCommand }));

import {
  assertSafeRestoreTarget,
  buildRetentionArgs,
  redactBackupDiagnostic,
  validateBackupRepository,
  readBackupDataContractVersion,
  assertBackupDataContract,
  backupRedis,
  restoreSnapshot,
} from '../scripts/redis-backup.mjs';
import { readDataContractVersion } from '../scripts/release-tool.mjs';

describe('O2.4 encrypted Redis backup policy', () => {
  test('backup image and release tools use the same packaged policy, not independent versions', () => {
    expect(readBackupDataContractVersion()).toBe(2);
    expect(readBackupDataContractVersion()).toBe(readDataContractVersion());
    const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('COPY --chown=node:node config/release-policy.json ./config/release-policy.json');
    expect(() => assertBackupDataContract({ schema: 1, dataContractVersion: 1 })).toThrow(
      'BACKUP_DATA_CONTRACT_MISMATCH'
    );
    expect(() => assertBackupDataContract({ schema: 1, dataContractVersion: 3 })).toThrow(
      'BACKUP_DATA_CONTRACT_MISMATCH'
    );
  });

  test.each(['v2', 'v1', 'wrong-password', 'checksum', 'corrupt-rdb'])(
    'production backup/restore path: %s',
    (scenario) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-backup-contract-'));
      const config = {
        repository: { path: path.join(root, 'repository'), value: 'synthetic-repository' },
        password: { path: path.join(root, 'password'), value: 'synthetic-password' },
        releaseSha: 'a'.repeat(40),
        dataContractVersion: readBackupDataContractVersion(),
        host: 'isolated-test',
        statusDir: path.join(root, 'status'),
        restoreRoot: path.join(root, 'restore'),
        redisHost: '127.0.0.1',
        redisPort: '6379',
        redisUser: '',
      };
      let saved:
        | {
            manifest: {
              schema: number;
              releaseSha: string;
              dataContractVersion: number;
              rdb: { sha256: string; bytes: number; file: string };
            };
            rdb: Buffer;
          }
        | undefined;
      const commands: string[][] = [];
      externalCommand.mockImplementation((command: string, args: string[]) => {
        commands.push([command, ...args]);
        if (command === 'redis-cli') {
          fs.writeFileSync(args[args.indexOf('--rdb') + 1], 'synthetic-rdb');
        }
        if (command === 'restic' && args[0] === 'backup') {
          saved = {
            manifest: JSON.parse(fs.readFileSync(path.join(args[1], 'mbl-redis-backup.json'), 'utf8')),
            rdb: fs.readFileSync(path.join(args[1], 'dump.rdb')),
          };
          return { status: 0, stdout: JSON.stringify({ message_type: 'summary', snapshot_id: 'a'.repeat(64) }) };
        }
        if (command === 'restic' && args[0] === 'restore') {
          if (scenario === 'wrong-password') return { status: 1, stderr: 'wrong password' };
          const output = args[args.indexOf('--target') + 1];
          fs.writeFileSync(path.join(output, 'dump.rdb'), saved!.rdb);
          fs.writeFileSync(path.join(output, 'mbl-redis-backup.json'), JSON.stringify(saved!.manifest));
        }
        if (
          command === 'redis-check-rdb' &&
          commands.some((entry) => entry[0] === 'restic' && entry[1] === 'restore') &&
          scenario === 'corrupt-rdb'
        ) {
          return { status: 1, stderr: 'RDB corruption' };
        }
        return { status: 0, stdout: '[]' };
      });
      const oldConfirmation = process.env.MBL_BACKUP_RESTORE_CONFIRM;
      process.env.MBL_BACKUP_RESTORE_CONFIRM = 'RESTORE_TO_ISOLATED_DIRECTORY';
      try {
        backupRedis(config);
        expect(saved!.manifest.dataContractVersion).toBe(2);
        expect(saved!.manifest.releaseSha).toBe(config.releaseSha);
        expect(commands.find((entry) => entry[1] === 'backup')).toContain('data-contract-2');
        if (scenario === 'v1') saved!.manifest.dataContractVersion = 1;
        if (scenario === 'checksum') saved!.manifest.rdb.sha256 = '0'.repeat(64);
        expect(saved!.manifest.rdb.sha256).toBe(
          scenario === 'checksum' ? '0'.repeat(64) : createHash('sha256').update(saved!.rdb).digest('hex')
        );
        const target = path.join(config.restoreRoot, 'drill');
        const restore = () => restoreSnapshot(config, ['--snapshot', 'latest', '--target', target]);
        if (scenario === 'v2') {
          expect(restore).not.toThrow();
          expect(fs.readFileSync(path.join(target, 'dump.rdb'))).toEqual(saved!.rdb);
        } else {
          expect(restore).toThrow(
            {
              v1: 'BACKUP_DATA_CONTRACT_MISMATCH',
              'wrong-password': 'wrong password',
              checksum: 'checksum',
              'corrupt-rdb': 'RDB corruption',
            }[scenario]
          );
          expect(fs.existsSync(target)).toBe(false);
        }
        // Restore is Restic -> temporary directory -> validated isolated output;
        // it never issues a Redis command, even for a mismatched manifest.
        expect(commands.filter((entry) => entry[0] === 'redis-cli')).toHaveLength(1);
      } finally {
        if (oldConfirmation === undefined) delete process.env.MBL_BACKUP_RESTORE_CONFIRM;
        else process.env.MBL_BACKUP_RESTORE_CONFIRM = oldConfirmation;
        externalCommand.mockReset();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );
  test('requires HTTPS S3 in production and permits local repositories only for an explicit drill', () => {
    expect(validateBackupRepository('s3:https://storage.example.test/mbl/backups')).toContain('s3:https://');
    expect(() => validateBackupRepository('s3:http://storage.example.test/mbl/backups', true)).toThrow(/Plain HTTP/i);
    expect(() => validateBackupRepository('/repository/restic')).toThrow(/S3 over HTTPS/i);
    expect(validateBackupRepository('/repository/restic', true)).toBe('/repository/restic');
  });

  test('uses the agreed 24 hourly, 7 daily and 4 weekly retention contract', () => {
    expect(buildRetentionArgs()).toEqual([
      'forget',
      '--host',
      'mbl-production',
      '--tag',
      'mbl-redis',
      '--keep-hourly',
      '24',
      '--keep-daily',
      '7',
      '--keep-weekly',
      '4',
      '--prune',
    ]);
  });

  test('only restores to a dedicated directory below the isolated restore root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-restore-policy-'));
    try {
      expect(assertSafeRestoreTarget(path.join(root, 'drill-1'), root)).toBe(path.join(root, 'drill-1'));
      expect(() => assertSafeRestoreTarget(root, root)).toThrow(/dedicated child/i);
      expect(() => assertSafeRestoreTarget(path.join(root, '..', 'outside'), root)).toThrow(/inside/i);
      expect(() => assertSafeRestoreTarget(path.join(root, 'data', 'candidate'), root)).toThrow(/data directory/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('redacts credentials and repository locations from diagnostics', () => {
    const output = redactBackupDiagnostic(
      'AWS_ACCESS_KEY_ID=alpha AWS_SECRET_ACCESS_KEY=beta s3:https://storage.example.test/private redis://secret@redis:6379',
      ['alpha', 'beta']
    );
    expect(output).not.toContain('alpha');
    expect(output).not.toContain('beta');
    expect(output).not.toContain('/private');
    expect(output).not.toContain('secret@redis');
  });

  test('keeps the backup job one-shot, private and detached from the Redis data volume', () => {
    const compose = fs.readFileSync(new URL('../compose.backup.yml', import.meta.url), 'utf8');
    expect(compose).toMatch(/profiles:\s*\[backup\]/);
    expect(compose).toMatch(/target:\s*backup-runtime/);
    expect(compose).toMatch(/- mbl-backend/);
    expect(compose).toMatch(/- mbl-backup-egress/);
    expect(compose).not.toMatch(/^\s*mbl-redis-data:\s*$/m);
    expect(compose).not.toMatch(/\n\s*ports:/);
    expect(compose).toMatch(/read_only:\s*true/);
    expect(compose).toMatch(/no-new-privileges:true/);
  });

  test('pins Restic and protects the production Redis volume from compose down -v', () => {
    const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    const productionCompose = fs.readFileSync(new URL('../compose.production.yml', import.meta.url), 'utf8');
    expect(dockerfile).toContain(
      'restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'
    );
    expect(productionCompose).toMatch(/MBL_REDIS_VOLUME_NAME/);
    expect(productionCompose).toMatch(/MBL_REDIS_VOLUME_EXTERNAL:-true/);
  });

  test('schedules non-overlapping hourly backups and daily retention', () => {
    const backupTimer = fs.readFileSync(new URL('../ops/systemd/mbl-redis-backup.timer', import.meta.url), 'utf8');
    const backupService = fs.readFileSync(new URL('../ops/systemd/mbl-redis-backup.service', import.meta.url), 'utf8');
    const retentionTimer = fs.readFileSync(
      new URL('../ops/systemd/mbl-redis-retention.timer', import.meta.url),
      'utf8'
    );
    expect(backupTimer).toMatch(/OnCalendar=hourly/);
    expect(backupTimer).toMatch(/Persistent=true/);
    expect(retentionTimer).toMatch(/OnCalendar=\*-\*-\* 03:30:00/);
    expect(backupService).toMatch(/flock -n \/run\/lock\/mbl-redis-maintenance\.lock/);
    expect(backupService).toMatch(/WorkingDirectory=\/opt\/mbl\/runtime\/current/);
    expect(backupService).not.toContain('/opt/mbl/current');
  });
});
