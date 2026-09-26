import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA = 1;
const MAX_BYTES = 4096;
const DEFAULT_FILE = '/var/lib/mbl-monitor/status-snapshot.json';

function tristate(value) {
  return typeof value === 'boolean' ? value : null;
}

function safeState(value) {
  return ['healthy', 'degraded', 'unknown'].includes(value) ? value : 'unknown';
}

function safeBackup(value) {
  return ['fresh', 'missing', 'invalid', 'stale'].includes(value) ? value : 'unknown';
}

export function createMonitorStatusSnapshot(report) {
  const operational = report?.checks?.operational?.summary;
  const queueDepth = operational?.queueDepth;
  return {
    schema: SCHEMA,
    checkedAtMs: Number.isSafeInteger(report?.checkedAtMs) && report.checkedAtMs >= 0 ? report.checkedAtMs : 0,
    site: report?.checks?.edge?.ok === true,
    readiness: report?.checks?.ready?.ok === true ? true : report?.checks?.ready ? false : null,
    redis: tristate(operational?.redis),
    worker: safeState(operational?.worker),
    queue: safeState(operational?.queue),
    queueDepth: Number.isSafeInteger(queueDepth) && queueDepth >= 0 && queueDepth <= 1_000_000 ? queueDepth : null,
    backup: safeBackup(operational?.backup),
  };
}

function validSnapshot(value) {
  return (
    value?.schema === SCHEMA &&
    Number.isSafeInteger(value.checkedAtMs) &&
    value.checkedAtMs >= 0 &&
    typeof value.site === 'boolean' &&
    (value.readiness === null || typeof value.readiness === 'boolean') &&
    (value.redis === null || typeof value.redis === 'boolean') &&
    ['healthy', 'degraded', 'unknown'].includes(value.worker) &&
    ['healthy', 'degraded', 'unknown'].includes(value.queue) &&
    (value.queueDepth === null || (Number.isSafeInteger(value.queueDepth) && value.queueDepth >= 0)) &&
    ['fresh', 'missing', 'invalid', 'stale', 'unknown'].includes(value.backup)
  );
}

export async function writeMonitorStatusSnapshot(report, file = DEFAULT_FILE) {
  const snapshot = createMonitorStatusSnapshot(report);
  if (!validSnapshot(snapshot) || !path.isAbsolute(file)) throw new Error('MONITOR_STATUS_INVALID');
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    await fs.rm(file, { force: true });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  await fs.chmod(file, 0o600).catch(() => {});
  return snapshot;
}

export async function readMonitorStatusSnapshot(file = DEFAULT_FILE) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) return null;
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return validSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
