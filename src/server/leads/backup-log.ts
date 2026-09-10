import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseBooleanEnv } from '~/server/utils/auth';

const DEFAULT_DEV_BACKUP_FILE = path.resolve(process.cwd(), 'data', 'lead-backup.ndjson');
const DEFAULT_PROD_BACKUP_FILE = '/tmp/lead-backup.ndjson';
const REDACTED_VALUE = '[REDACTED]';
const MAX_REDACTION_DEPTH = 8;
const REDACTED_KEYS = new Set(['name', 'phone', 'message', 'ip']);

function isBackupEnabled(): boolean {
  return parseBooleanEnv(process.env.CONTACT_LEAD_BACKUP_ENABLED, !import.meta.env.PROD);
}

function includeBackupPii(): boolean {
  return parseBooleanEnv(process.env.CONTACT_LEAD_BACKUP_INCLUDE_PII, !import.meta.env.PROD);
}

function resolveBackupFilePath(): string {
  const configuredPath = (process.env.CONTACT_LEAD_BACKUP_FILE || '').trim();
  if (configuredPath) {
    return path.resolve(process.cwd(), configuredPath);
  }
  return import.meta.env.PROD ? DEFAULT_PROD_BACKUP_FILE : DEFAULT_DEV_BACKUP_FILE;
}

export async function appendLeadBackup(entry: Record<string, unknown>): Promise<void> {
  if (!isBackupEnabled()) return;

  const filePath = resolveBackupFilePath();
  const line = `${JSON.stringify(sanitizeBackupEntry(entry))}\n`;

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, line, 'utf8');
  } catch (error) {
    console.warn('[lead-backup] append_failed', {
      filePath,
      code: error instanceof Error ? error.message : 'UNKNOWN',
    });
  }
}

function sanitizeBackupEntry(entry: Record<string, unknown>): Record<string, unknown> {
  if (includeBackupPii()) return entry;
  return sanitizeUnknown(entry, 0) as Record<string, unknown>;
}

function sanitizeUnknown(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACTION_DEPTH) {
    return '[TRUNCATED]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, depth + 1));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = String(rawKey || '').trim();
    const normalizedKey = key.toLowerCase();
    if (REDACTED_KEYS.has(normalizedKey)) {
      sanitized[key] = REDACTED_VALUE;
      continue;
    }
    sanitized[key] = sanitizeUnknown(rawValue, depth + 1);
  }
  return sanitized;
}
