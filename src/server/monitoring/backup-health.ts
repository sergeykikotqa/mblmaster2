import fs from 'node:fs/promises';

const DEFAULT_BACKUP_MAX_AGE_SEC = 2 * 60 * 60 + 15 * 60;
const DEFAULT_BACKUP_FUTURE_TOLERANCE_SEC = 5 * 60;
const MAX_CHECKPOINT_BYTES = 64 * 1024;

export type BackupHealthStatus = 'fresh' | 'missing' | 'invalid' | 'stale';

export type BackupHealth = {
  ok: boolean;
  service: 'redis-backup';
  status: BackupHealthStatus;
  checkedAtMs: number;
  completedAt: string | null;
  ageMs: number | null;
  maxAgeMs: number;
};

type BackupCheckpoint = {
  schema: number;
  status: string;
  completedAt: string;
  snapshotId: string;
  releaseSha: string;
  rdbBytes: number;
  rdbSha256: string;
};

function parsePositiveSeconds(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

export function resolveBackupHealthConfig() {
  return {
    checkpointFile: String(process.env.MBL_BACKUP_STATUS_FILE || '/run/mbl-backup-status/last-success.json').trim(),
    maxAgeMs: parsePositiveSeconds(process.env.MBL_BACKUP_MAX_AGE_SEC, DEFAULT_BACKUP_MAX_AGE_SEC, 60) * 1000,
    futureToleranceMs:
      parsePositiveSeconds(process.env.MBL_BACKUP_FUTURE_TOLERANCE_SEC, DEFAULT_BACKUP_FUTURE_TOLERANCE_SEC, 0) * 1000,
  };
}

function isCheckpoint(value: unknown): value is BackupCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Record<string, unknown>;
  return (
    checkpoint.schema === 1 &&
    checkpoint.status === 'ok' &&
    typeof checkpoint.completedAt === 'string' &&
    typeof checkpoint.snapshotId === 'string' &&
    /^[a-f0-9]{8,64}$/i.test(checkpoint.snapshotId) &&
    typeof checkpoint.releaseSha === 'string' &&
    /^[a-f0-9]{40}$/i.test(checkpoint.releaseSha) &&
    typeof checkpoint.rdbBytes === 'number' &&
    Number.isFinite(checkpoint.rdbBytes) &&
    checkpoint.rdbBytes > 0 &&
    typeof checkpoint.rdbSha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(checkpoint.rdbSha256)
  );
}

function result(
  status: BackupHealthStatus,
  checkedAtMs: number,
  maxAgeMs: number,
  completedAt: string | null = null,
  ageMs: number | null = null
): BackupHealth {
  return {
    ok: status === 'fresh',
    service: 'redis-backup',
    status,
    checkedAtMs,
    completedAt,
    ageMs,
    maxAgeMs,
  };
}

export function classifyBackupCheckpoint(
  value: unknown,
  options: { nowMs?: number; maxAgeMs?: number; futureToleranceMs?: number } = {}
): BackupHealth {
  const config = resolveBackupHealthConfig();
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? config.maxAgeMs;
  const futureToleranceMs = options.futureToleranceMs ?? config.futureToleranceMs;

  if (!isCheckpoint(value)) return result('invalid', nowMs, maxAgeMs);

  const completedAtMs = Date.parse(value.completedAt);
  if (!Number.isFinite(completedAtMs)) return result('invalid', nowMs, maxAgeMs);
  const ageMs = nowMs - completedAtMs;
  if (ageMs < -futureToleranceMs) return result('invalid', nowMs, maxAgeMs);
  const safeAgeMs = Math.max(0, ageMs);
  if (safeAgeMs > maxAgeMs) return result('stale', nowMs, maxAgeMs, value.completedAt, safeAgeMs);
  return result('fresh', nowMs, maxAgeMs, value.completedAt, safeAgeMs);
}

export async function readBackupHealth(
  options: { checkpointFile?: string; nowMs?: number; maxAgeMs?: number; futureToleranceMs?: number } = {}
): Promise<BackupHealth> {
  const config = resolveBackupHealthConfig();
  const checkpointFile = String(options.checkpointFile || config.checkpointFile).trim();
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? config.maxAgeMs;
  const futureToleranceMs = options.futureToleranceMs ?? config.futureToleranceMs;

  if (!checkpointFile) return result('missing', nowMs, maxAgeMs);

  try {
    const stat = await fs.stat(checkpointFile);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CHECKPOINT_BYTES) {
      return result('invalid', nowMs, maxAgeMs);
    }
    const raw = await fs.readFile(checkpointFile, 'utf8');
    const value: unknown = JSON.parse(raw);
    return classifyBackupCheckpoint(value, { nowMs, maxAgeMs, futureToleranceMs });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return result(code === 'ENOENT' ? 'missing' : 'invalid', nowMs, maxAgeMs);
  }
}

export const BACKUP_HEALTH_DEFAULTS = Object.freeze({
  maxAgeSec: DEFAULT_BACKUP_MAX_AGE_SEC,
  futureToleranceSec: DEFAULT_BACKUP_FUTURE_TOLERANCE_SEC,
  maxCheckpointBytes: MAX_CHECKPOINT_BYTES,
});
