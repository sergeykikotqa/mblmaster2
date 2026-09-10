import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_PREFIX = 'lead';
const DEFAULT_LEAD_RECORD_TTL_SEC = 60 * 60 * 24 * 30;
const DEFAULT_REPLAY_LOCK_SEC = 15 * 60;
const DEFAULT_REPLAY_ALL_LIMIT = 20;
const MAX_REPLAY_ALL_LIMIT = 200;
const DEFAULT_REPLAY_ALL_DELAY_MS = 250;
const DEFAULT_AUDIT_LOG_PATH = path.join('logs', 'dlq-replay-audit.log');
const DEFAULT_AUDIT_REDIS_MAX_ENTRIES = 5000;
const DEFAULT_AUDIT_REDIS_TTL_SEC = 60 * 60 * 24 * 90;
const REPLAY_ALL_CONFIRM_VALUE = 'YES';

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!hit) return '';
  return hit.slice(prefix.length).trim();
}

function readBooleanFlag(name) {
  const needle = `--${name}`;
  return process.argv.includes(needle);
}

function parsePositiveInt(value, fallback, min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function parseBoolean(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizePrefix(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return DEFAULT_PREFIX;
  return value.replace(/[^a-zA-Z0-9:_-]/g, '-');
}

function resolveReplayLockSec() {
  return parsePositiveInt(process.env.CONTACT_DLQ_REPLAY_LOCK_SEC, DEFAULT_REPLAY_LOCK_SEC, 1);
}

function resolveAuditActor() {
  return (
    String(process.env.DLQ_CLI_ACTOR || '').trim() ||
    String(process.env.GITHUB_ACTOR || '').trim() ||
    String(process.env.USERNAME || '').trim() ||
    String(process.env.USER || '').trim() ||
    os.userInfo().username ||
    'unknown'
  );
}

function resolveAuditLogPath() {
  const configured = String(process.env.DLQ_AUDIT_LOG_PATH || '').trim();
  return configured || DEFAULT_AUDIT_LOG_PATH;
}

function resolveAuditRedisEnabled() {
  return parseBoolean(process.env.DLQ_AUDIT_REDIS_ENABLED, true);
}

function resolveAuditRedisMaxEntries() {
  return parsePositiveInt(process.env.DLQ_AUDIT_REDIS_MAX_ENTRIES, DEFAULT_AUDIT_REDIS_MAX_ENTRIES, 100);
}

function resolveAuditRedisTtlSec() {
  return parsePositiveInt(process.env.DLQ_AUDIT_REDIS_TTL_SEC, DEFAULT_AUDIT_REDIS_TTL_SEC, 60);
}

async function appendAudit(client, keys, entry) {
  const line = JSON.stringify(entry);
  const filePath = path.resolve(process.cwd(), resolveAuditLogPath());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${line}\n`, 'utf8');

  if (!resolveAuditRedisEnabled()) {
    return;
  }

  try {
    await client.command('RPUSH', keys.auditLog, line);
    const maxEntries = resolveAuditRedisMaxEntries();
    await client.command('LTRIM', keys.auditLog, -maxEntries, -1);
    await client.command('EXPIRE', keys.auditLog, resolveAuditRedisTtlSec());
  } catch (error) {
    console.warn(`audit redis write failed: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
  }
}

class UpstashRedisClient {
  constructor(endpoint, token) {
    this.endpoint = endpoint;
    this.token = token;
  }

  async command(...args) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });

    if (!response.ok) {
      throw new Error(`REDIS_HTTP_${response.status}`);
    }

    const payload = await response.json();
    if (payload?.error) {
      throw new Error(`REDIS_COMMAND_ERROR:${payload.error}`);
    }

    return payload?.result;
  }
}

function parseJsonOrNull(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildKeys(prefix) {
  return {
    dlq: `${prefix}:delivery:dlq`,
    queue: `${prefix}:delivery:queue`,
    leadRecord: (leadId) => `${prefix}:record:${leadId}`,
    replayLock: (leadId) => `${prefix}:delivery:replay-lock:${leadId}`,
    auditLog: `${prefix}:delivery:replay:audit`,
  };
}

async function listDlq(client, keys, limit) {
  const raw = await client.command('LRANGE', keys.dlq, 0, Math.max(0, limit - 1));
  const rows = Array.isArray(raw) ? raw : [];
  if (rows.length === 0) {
    console.log('DLQ is empty.');
    return;
  }

  console.log(`DLQ entries: ${rows.length}`);
  rows.forEach((item, index) => {
    const parsed = parseJsonOrNull(item);
    const leadId = parsed?.leadId || '(unknown)';
    const failedAt = parsed?.failedAt || '(unknown)';
    const retryCount = Number.isFinite(Number(parsed?.retryCount)) ? Number(parsed.retryCount) : '(unknown)';
    const errorCode = parsed?.errorCode || '(unknown)';
    console.log(`${index + 1}. leadId=${leadId} failedAt=${failedAt} retryCount=${retryCount} errorCode=${errorCode}`);
  });
}

async function acquireReplayLock(client, keys, leadId, lockSec, force) {
  if (force) {
    return { ok: true, bypassed: true };
  }

  const lockResult = await client.command('SET', keys.replayLock(leadId), String(Date.now()), 'EX', lockSec, 'NX');
  if (lockResult === 'OK') {
    return { ok: true, bypassed: false };
  }

  return { ok: false, bypassed: false };
}

async function replayLead(
  client,
  keys,
  leadId,
  options = { removeFromDlq: true, replayLockSec: DEFAULT_REPLAY_LOCK_SEC, force: false }
) {
  const lock = await acquireReplayLock(client, keys, leadId, options.replayLockSec, options.force);
  if (!lock.ok) {
    return {
      status: 'skipped',
      reason: 'REPLAY_LOCK_ACTIVE',
      leadId,
    };
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const leadRecordTtlSec = parsePositiveInt(process.env.CONTACT_LEAD_RECORD_TTL_SEC, DEFAULT_LEAD_RECORD_TTL_SEC, 0);

  const rawRecord = await client.command('GET', keys.leadRecord(leadId));
  const current = parseJsonOrNull(rawRecord);
  if (!current || typeof current !== 'object') {
    throw new Error(`Lead record is missing for leadId=${leadId}`);
  }

  const nextRecord = {
    ...current,
    status: 'pending',
    retryCount: 0,
    nextRetryAt: nowMs,
    updatedAt: nowIso,
    lastErrorCode: undefined,
    lastErrorStatus: undefined,
    lastErrorMessage: undefined,
  };

  if (leadRecordTtlSec > 0) {
    await client.command('SET', keys.leadRecord(leadId), JSON.stringify(nextRecord), 'EX', leadRecordTtlSec);
  } else {
    await client.command('SET', keys.leadRecord(leadId), JSON.stringify(nextRecord));
  }

  await client.command('ZADD', keys.queue, nowMs, leadId);

  if (options.removeFromDlq) {
    const rawDlq = await client.command('LRANGE', keys.dlq, 0, -1);
    const rows = Array.isArray(rawDlq) ? rawDlq : [];
    for (const item of rows) {
      const parsed = parseJsonOrNull(item);
      if (parsed?.leadId === leadId) {
        await client.command('LREM', keys.dlq, 1, item);
      }
    }
  }

  return {
    status: 'replayed',
    leadId,
    replayLockBypassed: lock.bypassed,
  };
}

async function replayAll(client, keys, options) {
  const raw = await client.command('LRANGE', keys.dlq, 0, Math.max(0, options.limit - 1));
  const rows = Array.isArray(raw) ? raw : [];
  const leadIds = rows
    .map((item) => parseJsonOrNull(item))
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.leadId === 'string')
    .map((entry) => entry.leadId);

  if (leadIds.length === 0) {
    console.log('DLQ has no replayable entries.');
    return { ok: 0, failed: 0, skipped: 0, total: 0 };
  }

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const leadId of leadIds) {
    try {
      const result = await replayLead(client, keys, leadId, {
        removeFromDlq: true,
        replayLockSec: options.replayLockSec,
        force: options.force,
      });
      if (result.status === 'replayed') {
        ok += 1;
        console.log(`replayed leadId=${leadId}`);
      } else {
        skipped += 1;
        console.warn(`skipped leadId=${leadId}: ${result.reason}`);
      }
    } catch (error) {
      failed += 1;
      console.error(`failed leadId=${leadId}: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }

    if (options.delayMs > 0) {
      await delay(options.delayMs);
    }
  }

  console.log(`Replay completed: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  return { ok, failed, skipped, total: leadIds.length };
}

function printUsage() {
  console.log(`Usage:
  node scripts/dlq-cli.mjs list [--limit=20]
  node scripts/dlq-cli.mjs replay --lead-id=<uuid> [--force]
  node scripts/dlq-cli.mjs replay-all [--limit=20] [--delay-ms=250] [--force] --confirm=${REPLAY_ALL_CONFIRM_VALUE}

Required env:
  UPSTASH_REDIS_REST_URL
  UPSTASH_REDIS_REST_TOKEN
Optional env:
  CONTACT_REDIS_PREFIX (default: lead)
  CONTACT_LEAD_RECORD_TTL_SEC (default: 2592000)
  CONTACT_DLQ_REPLAY_LOCK_SEC (default: 900)
  DLQ_CLI_ACTOR (for audit trail)
  DLQ_AUDIT_LOG_PATH (default: logs/dlq-replay-audit.log)
  DLQ_AUDIT_REDIS_ENABLED (default: true)
  DLQ_AUDIT_REDIS_MAX_ENTRIES (default: 5000)
  DLQ_AUDIT_REDIS_TTL_SEC (default: 7776000)
`);
}

async function main() {
  const command = String(process.argv[2] || '')
    .trim()
    .toLowerCase();
  if (!command || ['-h', '--help', 'help'].includes(command)) {
    printUsage();
    return;
  }

  const endpoint = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!endpoint || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
  }

  const prefix = normalizePrefix(process.env.CONTACT_REDIS_PREFIX);
  const client = new UpstashRedisClient(endpoint, token);
  const keys = buildKeys(prefix);
  const actor = resolveAuditActor();
  const startedAt = new Date().toISOString();

  if (command === 'list') {
    const limit = parsePositiveInt(readArg('limit'), DEFAULT_REPLAY_ALL_LIMIT, 1);
    await listDlq(client, keys, limit);
    await appendAudit(client, keys, {
      event: 'dlq_cli_list',
      actor,
      timestamp: startedAt,
      limit,
    });
    return;
  }

  if (command === 'replay') {
    const leadId = readArg('lead-id');
    if (!leadId) {
      throw new Error('Missing required argument: --lead-id=<uuid>');
    }

    const force = readBooleanFlag('force');
    const replayLockSec = resolveReplayLockSec();
    const result = await replayLead(client, keys, leadId, {
      removeFromDlq: true,
      replayLockSec,
      force,
    });

    await appendAudit(client, keys, {
      event: 'dlq_cli_replay',
      actor,
      timestamp: startedAt,
      leadId,
      result: result.status,
      reason: result.reason || null,
      force,
      replayLockSec,
    });

    if (result.status === 'replayed') {
      console.log(`replayed leadId=${leadId}`);
      return;
    }

    console.warn(`skipped leadId=${leadId}: ${result.reason}`);
    return;
  }

  if (command === 'replay-all') {
    const confirm = readArg('confirm');
    if (confirm !== REPLAY_ALL_CONFIRM_VALUE) {
      throw new Error(
        `Replay-all requires explicit confirmation: --confirm=${REPLAY_ALL_CONFIRM_VALUE}. This protects against replay storms.`
      );
    }

    const force = readBooleanFlag('force');
    const replayLockSec = resolveReplayLockSec();
    const limit = Math.min(parsePositiveInt(readArg('limit'), DEFAULT_REPLAY_ALL_LIMIT, 1), MAX_REPLAY_ALL_LIMIT);
    const delayMs = parsePositiveInt(readArg('delay-ms'), DEFAULT_REPLAY_ALL_DELAY_MS, 0);

    const summary = await replayAll(client, keys, {
      limit,
      delayMs,
      replayLockSec,
      force,
    });

    await appendAudit(client, keys, {
      event: 'dlq_cli_replay_all',
      actor,
      timestamp: startedAt,
      confirm,
      force,
      limit,
      delayMs,
      replayLockSec,
      summary,
    });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error('DLQ CLI failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
