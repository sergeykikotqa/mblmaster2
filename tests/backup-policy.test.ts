import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  assertSafeRestoreTarget,
  buildRetentionArgs,
  redactBackupDiagnostic,
  validateBackupRepository,
} from '../scripts/redis-backup.mjs';

describe('O2.4 encrypted Redis backup policy', () => {
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
