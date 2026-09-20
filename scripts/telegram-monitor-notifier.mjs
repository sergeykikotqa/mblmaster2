import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_SCHEMA = 1;
const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_ESCALATION_SEC = 6 * 60 * 60;
const DEFAULT_RETRY_SEC = 5 * 60;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 64 * 1024;

class TelegramNotifierError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TelegramNotifierError';
    this.code = code;
  }
}

function assert(condition, code) {
  if (!condition) throw new TelegramNotifierError(code);
}

function parseBoolean(value, fallback = false) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new TelegramNotifierError('TELEGRAM_ENABLED_INVALID');
}

function parsePositiveInt(value, fallback, minimum, maximum) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  assert(Number.isFinite(parsed), 'TELEGRAM_NUMERIC_CONFIG_INVALID');
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function safeCodes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((item) => /^[A-Z][A-Z0-9_]{2,63}$/.test(item)))].slice(0, 25).sort();
}

function emptyState() {
  return { schema: STATE_SCHEMA, active: null };
}

function isNullableTimestamp(value) {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function isValidState(value) {
  if (!value || typeof value !== 'object' || value.schema !== STATE_SCHEMA) return false;
  if (value.active === null) return true;
  const active = value.active;
  return (
    active &&
    typeof active === 'object' &&
    Number.isFinite(active.startedAtMs) &&
    active.startedAtMs >= 0 &&
    isNullableTimestamp(active.initialDeliveredAtMs) &&
    isNullableTimestamp(active.lastDeliveredAtMs) &&
    isNullableTimestamp(active.nextAttemptAtMs) &&
    isNullableTimestamp(active.recoveryPendingSinceMs) &&
    Array.isArray(active.codes) &&
    active.codes.length <= 25 &&
    active.codes.every((code) => /^[A-Z][A-Z0-9_]{2,63}$/.test(code))
  );
}

export function loadTelegramNotificationConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  const enabled = parseBoolean(env.MBL_TELEGRAM_ENABLED, Boolean(token || chatId));
  if (!enabled) return { enabled: false };

  assert(/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token), 'TELEGRAM_BOT_TOKEN_INVALID');
  assert(/^-?\d{3,20}$/.test(chatId), 'TELEGRAM_CHAT_ID_INVALID');

  const stateFile = String(env.MBL_TELEGRAM_STATE_FILE || '/var/lib/mbl-monitor/telegram-state.json').trim();
  assert(path.isAbsolute(stateFile), 'TELEGRAM_STATE_FILE_MUST_BE_ABSOLUTE');

  return {
    enabled: true,
    token,
    chatId,
    stateFile,
    apiOrigin: TELEGRAM_API_ORIGIN,
    timeoutMs: parsePositiveInt(env.MBL_TELEGRAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 30_000),
    maxRetries: parsePositiveInt(env.MBL_TELEGRAM_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 3),
    escalationMs:
      parsePositiveInt(env.MBL_TELEGRAM_ESCALATION_SEC, DEFAULT_ESCALATION_SEC, 15 * 60, 7 * 24 * 60 * 60) * 1000,
    retryMs: parsePositiveInt(env.MBL_TELEGRAM_RETRY_SEC, DEFAULT_RETRY_SEC, 60, 60 * 60) * 1000,
  };
}

export async function readTelegramNotificationState(stateFile) {
  try {
    const stat = await fs.stat(stateFile);
    assert(stat.isFile() && stat.size > 0 && stat.size <= MAX_STATE_BYTES, 'TELEGRAM_STATE_INVALID');
    const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert(isValidState(parsed), 'TELEGRAM_STATE_INVALID');
    return parsed;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return emptyState();
    if (error instanceof TelegramNotifierError) throw error;
    throw new TelegramNotifierError('TELEGRAM_STATE_INVALID');
  }
}

async function writeTelegramNotificationState(stateFile, state) {
  assert(isValidState(state), 'TELEGRAM_STATE_INVALID');
  const directory = path.dirname(stateFile);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(temporary, stateFile);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    await fs.rm(stateFile, { force: true });
    await fs.rename(temporary, stateFile);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  await fs.chmod(stateFile, 0o600).catch(() => {});
}

async function readLimitedJson(response) {
  const advertised = Number(response.headers.get('content-length'));
  assert(!Number.isFinite(advertised) || advertised <= MAX_RESPONSE_BYTES, 'TELEGRAM_RESPONSE_TOO_LARGE');
  if (!response.body) throw new TelegramNotifierError('TELEGRAM_RESPONSE_INVALID');

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new TelegramNotifierError('TELEGRAM_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new TelegramNotifierError('TELEGRAM_RESPONSE_INVALID');
  }
}

async function postTelegramMessage(config, text, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const apiOrigin = String(options.apiOrigin || config.apiOrigin || TELEGRAM_API_ORIGIN).replace(/\/+$/, '');
  const endpoint = `${apiOrigin}/bot${config.token}/sendMessage`;
  const attempts = config.maxRetries + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          disable_web_page_preview: true,
        }),
      });
      const body = await readLimitedJson(response);
      if (response.ok && body?.ok === true) return { ok: true, status: response.status };
    } catch {
      // The result is intentionally reduced to a safe code below. Never log
      // the Telegram request URL because it contains the bot token.
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: null, code: 'TELEGRAM_DELIVERY_FAILED' };
}

function hasAny(codes, candidates) {
  return candidates.some((code) => codes.includes(code));
}

function incidentSummary(codes) {
  const lines = [];
  if (
    hasAny(codes, [
      'EDGE_UNAVAILABLE',
      'EDGE_REDIRECTED',
      'EDGE_HTTP_ERROR',
      'EDGE_CONTENT_TYPE_INVALID',
      'EDGE_BODY_INVALID',
      'NETWORK_OR_TLS_ERROR',
      'TLS_VALIDATION_FAILED',
      'LIVENESS_FAILED',
    ])
  ) {
    lines.push('Публичный сайт не отвечает через основной адрес.');
  }
  if (hasAny(codes, ['TLS_VALIDATION_FAILED', 'TLS_CERTIFICATE_INVALID', 'TLS_CERTIFICATE_EXPIRED'])) {
    lines.push('Проверка HTTPS-сертификата не прошла.');
  }
  if (hasAny(codes, ['TLS_EXPIRING_CRITICAL', 'TLS_EXPIRING_WARNING'])) {
    lines.push('Срок действия HTTPS-сертификата скоро закончится.');
  }
  if (hasAny(codes, ['READINESS_FAILED', 'REDIS_NOT_READY'])) {
    lines.push('Redis или приём заявок сейчас не готовы к работе.');
  }
  if (
    hasAny(codes, [
      'WORKER_DEGRADED',
      'WORKER_HEARTBEAT_MISSING',
      'WORKER_HEARTBEAT_STALE',
      'WORKER_HEARTBEAT_ERROR',
      'WORKER_PAUSED',
    ])
  ) {
    lines.push('Обработчик заявок не подтверждает нормальную работу. Доставка может задерживаться.');
  }
  if (hasAny(codes, ['OLDEST_PENDING_CRITICAL'])) {
    lines.push('Возраст ожидающей заявки достиг критического порога.');
  }
  if (
    hasAny(codes, [
      'PIPELINE_DEGRADED',
      'PIPELINE_DLQ',
      'PIPELINE_RETRY_RATE',
      'PIPELINE_QUEUE_BACKPRESSURE',
      'PIPELINE_MEMORY_FALLBACK',
    ])
  ) {
    lines.push('Очередь доставки заявок работает с ошибками или перегрузкой.');
  }
  if (hasAny(codes, ['BACKUP_MISSING', 'BACKUP_INVALID', 'BACKUP_STALE'])) {
    lines.push('Свежая подтверждённая резервная копия отсутствует или просрочена.');
  }
  if (hasAny(codes, ['MONITOR_AUTH_FAILED', 'MONITOR_HTTP_ERROR', 'MONITOR_CONTRACT_INVALID'])) {
    lines.push('Защищённая проверка состояния мониторинга не прошла.');
  }
  if (lines.length === 0) lines.push('Внешний мониторинг обнаружил техническую неисправность.');
  return lines.slice(0, 4);
}

function formatUtc(timestampMs) {
  return new Date(timestampMs).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function formatDuration(durationMs) {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) return `${minutes} мин.`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} ч.` : `${hours} ч. ${remainder} мин.`;
}

export function buildTelegramIncidentMessage(codes, checkedAtMs, reminder = false) {
  const summary = incidentSummary(safeCodes(codes));
  return [
    reminder ? 'MBL — проблема всё ещё активна' : 'MBL — обнаружена проблема',
    '',
    ...summary.map((line) => `• ${line}`),
    '',
    `Обнаружено: ${formatUtc(checkedAtMs)}`,
    'Проверка продолжится автоматически.',
  ].join('\n');
}

export function buildTelegramRecoveryMessage(startedAtMs, recoveredAtMs) {
  return [
    'MBL — система восстановлена',
    '',
    'Все контролируемые компоненты снова проходят проверку.',
    `Длительность: ${formatDuration(Math.max(0, recoveredAtMs - startedAtMs))}`,
    `Восстановлено: ${formatUtc(recoveredAtMs)}`,
  ].join('\n');
}

export async function sendTelegramTestMessage(config, options = {}) {
  assert(config?.enabled === true, 'TELEGRAM_DISABLED');
  return postTelegramMessage(config, 'MBL Monitor: тестовое уведомление. Связь с Telegram работает', options);
}

export async function notifyTelegramForReport(config, report, options = {}) {
  assert(config?.enabled === true, 'TELEGRAM_DISABLED');
  const checkedAtMs = Number(report?.checkedAtMs);
  assert(Number.isFinite(checkedAtMs) && checkedAtMs >= 0, 'TELEGRAM_REPORT_INVALID');
  const codes = safeCodes(report?.codes);
  const healthy = report?.ok === true && codes.length === 0;
  const state = await readTelegramNotificationState(config.stateFile);

  if (healthy) {
    if (!state.active) return { ok: true, action: 'none', delivered: false, reason: 'already_healthy' };
    if (state.active.initialDeliveredAtMs === null) {
      await writeTelegramNotificationState(config.stateFile, emptyState());
      return { ok: true, action: 'none', delivered: false, reason: 'incident_was_not_delivered' };
    }
    if (state.active.nextAttemptAtMs !== null && checkedAtMs < state.active.nextAttemptAtMs) {
      return { ok: false, action: 'recovery', delivered: false, code: 'TELEGRAM_DELIVERY_PENDING' };
    }

    state.active.recoveryPendingSinceMs ??= checkedAtMs;
    state.active.nextAttemptAtMs = checkedAtMs + config.retryMs;
    await writeTelegramNotificationState(config.stateFile, state);
    const delivery = await postTelegramMessage(
      config,
      buildTelegramRecoveryMessage(state.active.startedAtMs, checkedAtMs),
      options
    );
    if (!delivery.ok) {
      return { ok: false, action: 'recovery', delivered: false, code: 'TELEGRAM_DELIVERY_FAILED' };
    }
    await writeTelegramNotificationState(config.stateFile, emptyState());
    return { ok: true, action: 'recovery', delivered: true };
  }

  if (!state.active) {
    state.active = {
      startedAtMs: checkedAtMs,
      initialDeliveredAtMs: null,
      lastDeliveredAtMs: null,
      nextAttemptAtMs: null,
      recoveryPendingSinceMs: null,
      codes,
    };
  } else {
    state.active.codes = codes;
    state.active.recoveryPendingSinceMs = null;
  }

  let action = 'none';
  if (state.active.initialDeliveredAtMs === null) action = 'incident';
  else if (checkedAtMs - state.active.lastDeliveredAtMs >= config.escalationMs) action = 'reminder';

  if (action === 'none') {
    await writeTelegramNotificationState(config.stateFile, state);
    return { ok: true, action, delivered: false, reason: 'incident_already_notified' };
  }
  if (state.active.nextAttemptAtMs !== null && checkedAtMs < state.active.nextAttemptAtMs) {
    await writeTelegramNotificationState(config.stateFile, state);
    return { ok: false, action, delivered: false, code: 'TELEGRAM_DELIVERY_PENDING' };
  }

  state.active.nextAttemptAtMs = checkedAtMs + config.retryMs;
  await writeTelegramNotificationState(config.stateFile, state);
  const delivery = await postTelegramMessage(
    config,
    buildTelegramIncidentMessage(state.active.codes, state.active.startedAtMs, action === 'reminder'),
    options
  );
  if (!delivery.ok) return { ok: false, action, delivered: false, code: 'TELEGRAM_DELIVERY_FAILED' };

  state.active.initialDeliveredAtMs ??= checkedAtMs;
  state.active.lastDeliveredAtMs = checkedAtMs;
  state.active.nextAttemptAtMs = null;
  await writeTelegramNotificationState(config.stateFile, state);
  return { ok: true, action, delivered: true };
}

export function telegramNotifierErrorCode(error) {
  return error instanceof TelegramNotifierError ? error.code : 'TELEGRAM_NOTIFIER_FAILED';
}

export const TELEGRAM_NOTIFICATION_DEFAULTS = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxRetries: DEFAULT_MAX_RETRIES,
  escalationSec: DEFAULT_ESCALATION_SEC,
  retrySec: DEFAULT_RETRY_SEC,
});
