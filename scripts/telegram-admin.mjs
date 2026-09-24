import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readMonitorStatusSnapshot } from './monitor-status-snapshot.mjs';
import { sendTelegramMessage } from './telegram-monitor-notifier.mjs';

const TELEGRAM_ORIGIN = 'https://api.telegram.org';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 4096;
const MAX_UPDATES = 20;
const COMMANDS = new Set(['/today', '/week', '/funnel', '/status']);

class TelegramAdminError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function assert(condition, code) {
  if (!condition) throw new TelegramAdminError(code);
}

function integerId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : '';
}

function absoluteFile(value, fallback) {
  const resolved = String(value || fallback).trim();
  assert(path.isAbsolute(resolved), 'TELEGRAM_ADMIN_FILE_INVALID');
  return resolved;
}

export function loadTelegramAdminConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const userId = String(env.MBL_TELEGRAM_ADMIN_USER_ID || '').trim();
  const chatId = String(env.MBL_TELEGRAM_ADMIN_CHAT_ID || '').trim();
  const metricsToken = String(env.MBL_OWNER_METRICS_TOKEN || '').trim();
  const baseUrl = new URL(String(env.MBL_MONITOR_BASE_URL || ''));
  assert(/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token), 'TELEGRAM_ADMIN_BOT_TOKEN_INVALID');
  assert(/^\d{3,20}$/.test(userId) && /^\d{3,20}$/.test(chatId), 'TELEGRAM_ADMIN_OWNER_ID_INVALID');
  assert(
    metricsToken.length >= 24 && metricsToken !== String(env.MBL_MONITOR_TOKEN || '').trim(),
    'METRICS_TOKEN_INVALID'
  );
  assert(baseUrl.username === '' && baseUrl.password === '' && baseUrl.hash === '', 'METRICS_URL_INVALID');
  assert(baseUrl.pathname === '/' && baseUrl.search === '', 'METRICS_URL_INVALID');
  assert(baseUrl.protocol === 'https:', 'METRICS_HTTPS_REQUIRED');
  const timeoutMs = Number(env.MBL_TELEGRAM_ADMIN_TIMEOUT_MS || 6000);
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 10000, 'TELEGRAM_ADMIN_TIMEOUT_INVALID');
  return {
    token,
    userId,
    chatId,
    metricsToken,
    baseUrl,
    timeoutMs,
    apiOrigin: TELEGRAM_ORIGIN,
    stateFile: absoluteFile(env.MBL_TELEGRAM_ADMIN_STATE_FILE, '/var/lib/mbl-monitor/telegram-admin-state.json'),
    statusFile: absoluteFile(env.MBL_MONITOR_STATUS_FILE, '/var/lib/mbl-monitor/status-snapshot.json'),
  };
}

function validState(value) {
  return (
    value?.schema === 1 &&
    Number.isSafeInteger(value.nextOffset) &&
    value.nextOffset >= 0 &&
    Array.isArray(value.ownerRecentMs) &&
    value.ownerRecentMs.length <= 6 &&
    value.ownerRecentMs.every((item) => Number.isSafeInteger(item) && item >= 0) &&
    Number.isSafeInteger(value.rateNoticeAtMs) &&
    value.rateNoticeAtMs >= 0
  );
}

async function readState(file) {
  try {
    const stat = await fs.stat(file);
    assert(stat.isFile() && stat.size > 0 && stat.size <= MAX_STATE_BYTES, 'TELEGRAM_ADMIN_STATE_INVALID');
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    assert(validState(state), 'TELEGRAM_ADMIN_STATE_INVALID');
    return state;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { schema: 1, nextOffset: 0, ownerRecentMs: [], rateNoticeAtMs: 0 };
    }
    throw new TelegramAdminError('TELEGRAM_ADMIN_STATE_INVALID');
  }
}

async function writeState(file, state) {
  assert(validState(state), 'TELEGRAM_ADMIN_STATE_INVALID');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
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
}

async function limitedJson(response) {
  const size = Number(response.headers.get('content-length'));
  assert(!Number.isFinite(size) || size <= MAX_RESPONSE_BYTES, 'TELEGRAM_ADMIN_RESPONSE_TOO_LARGE');
  assert(response.body, 'TELEGRAM_ADMIN_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new TelegramAdminError('TELEGRAM_ADMIN_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const payload = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new TelegramAdminError('TELEGRAM_ADMIN_RESPONSE_INVALID');
  }
}

async function requestJson(url, init, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal });
    const body = await limitedJson(response);
    return { response, body };
  } catch {
    // The Telegram request URL contains the bot token. Never include it in
    // an exception, log, or returned error.
    throw new TelegramAdminError('TELEGRAM_ADMIN_REQUEST_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

async function getUpdates(config, offset, fetchImpl) {
  const { response, body } = await requestJson(
    `${config.apiOrigin}/bot${config.token}/getUpdates`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ offset, limit: MAX_UPDATES, timeout: 0, allowed_updates: ['message'] }),
    },
    config.timeoutMs,
    fetchImpl
  );
  assert(response.status === 200 && body?.ok === true && Array.isArray(body.result), 'TELEGRAM_ADMIN_POLL_FAILED');
  assert(body.result.length <= MAX_UPDATES, 'TELEGRAM_ADMIN_UPDATES_INVALID');
  return body.result;
}

function validMetrics(body, kind) {
  if (body?.ok !== true || body?.period?.kind !== kind || body.period.timeZone !== 'Asia/Irkutsk') return false;
  const boundariesValid =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(body.period.startLocal) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(body.period.endLocal);
  if (!boundariesValid) return false;
  if (body.complete === false) {
    return body.reason === 'HOURLY_RETENTION_INSUFFICIENT' && body.counts === null && body.conversions === null;
  }
  if (
    body.complete !== true ||
    body.source !== 'local_funnel' ||
    body.scope !== 'trusted_public_routes' ||
    body.historicalCaptureVerified !== false
  )
    return false;
  const counts = body.counts;
  if (!(
    counts &&
    [counts.consentedPageViews, counts.consentedFormOpens, counts.acceptedLeads].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  )) {
    return false;
  }
  const conversion = body.conversions;
  const openedPerPageView = conversion?.openedPerPageView;
  const submittedPerOpened = conversion?.submittedPerOpened;
  const submittedPerPageView = conversion?.submittedPerPageView;
  return (
    openedPerPageView?.numerator === counts.consentedFormOpens &&
    openedPerPageView?.denominator === counts.consentedPageViews &&
    openedPerPageView?.compatible === false &&
    openedPerPageView?.rate === null &&
    openedPerPageView?.reason === 'CONSENT_SCOPE_MISMATCH' &&
    submittedPerOpened?.numerator === counts.acceptedLeads &&
    submittedPerOpened?.denominator === counts.consentedFormOpens &&
    submittedPerOpened?.compatible === false &&
    submittedPerOpened?.rate === null &&
    submittedPerOpened?.reason === 'CONSENT_SCOPE_MISMATCH' &&
    submittedPerPageView?.numerator === counts.acceptedLeads &&
    submittedPerPageView?.denominator === counts.consentedPageViews &&
    submittedPerPageView?.compatible === false &&
    submittedPerPageView?.rate === null &&
    submittedPerPageView?.reason === 'CONSENT_SCOPE_MISMATCH'
  );
}

async function fetchMetrics(config, kind, fetchImpl) {
  const target = new URL(`/api/monitoring/owner-metrics?period=${kind}`, config.baseUrl);
  try {
    const { response, body } = await requestJson(
      target,
      { method: 'GET', headers: { Authorization: `Bearer ${config.metricsToken}`, Accept: 'application/json' } },
      config.timeoutMs,
      fetchImpl
    );
    return response.status === 200 && validMetrics(body, kind) ? body : null;
  } catch {
    return null;
  }
}

function localDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso));
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}` : 'неизвестно';
}

function percent(item) {
  if (!item || !Number.isSafeInteger(item.numerator) || !Number.isSafeInteger(item.denominator)) return 'недоступно';
  if (item.compatible === false || item.reason === 'CONSENT_SCOPE_MISMATCH') {
    return 'не рассчитывается (разный охват согласия)';
  }
  if (item.denominator <= 0 || !Number.isFinite(item.rate)) return 'недоступно (нет знаменателя)';
  return `${(item.rate * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

function metricNotes() {
  return [
    'Источник: локальная воронка по доверенным публичным маршрутам — не весь сайт.',
    'Просмотры и открытия учитываются только при согласии на аналитику; заявки — все принятые сервером с этих страниц.',
    'Процент конверсии не рассчитывается: числитель и знаменатель имеют разный охват согласия.',
    'Полнота исторического сбора не подтверждена. Это учтённые события, не уникальные посетители.',
  ];
}

export function formatMetricsCommand(command, body) {
  const title =
    command === '/week' ? 'MBL · текущая неделя' : command === '/funnel' ? 'MBL · воронка сегодня' : 'MBL · сегодня';
  if (!body) return `${title}\n\nДанные недоступны: основной сервер или хранилище метрик не отвечает.`;
  const period = body.period;
  if (body.complete === false) {
    return `${title}\n\nПериод: ${localDate(period.startLocal)} — ${localDate(period.endLocal)} (Иркутск).\nПочасовой истории недостаточно для точного итога. Данные не подменяются нулями.`;
  }
  const lines = [title, '', `Период: ${localDate(period.startLocal)} — ${localDate(period.endLocal)} (Иркутск).`];
  if (command !== '/funnel') {
    lines.push(`Просмотры с согласием на аналитику: ${body.counts.consentedPageViews}`);
    lines.push(`Открытия формы с согласием: ${body.counts.consentedFormOpens}`);
    lines.push(`Все принятые сервером заявки: ${body.counts.acceptedLeads}`);
  } else {
    lines.push(
      `Просмотры с согласием → открытия с согласием: ${body.counts.consentedPageViews} → ${body.counts.consentedFormOpens}`
    );
    lines.push(
      `Открытия / просмотры (${body.counts.consentedFormOpens}/${body.counts.consentedPageViews}): ${percent(body.conversions?.openedPerPageView)}`
    );
    lines.push(
      `Открытия с согласием → все принятые заявки: ${body.counts.consentedFormOpens} → ${body.counts.acceptedLeads}`
    );
    lines.push(
      `Заявки / открытия (${body.counts.acceptedLeads}/${body.counts.consentedFormOpens}): ${percent(body.conversions?.submittedPerOpened)}`
    );
    lines.push(
      `Заявки / просмотры (${body.counts.acceptedLeads}/${body.counts.consentedPageViews}): ${percent(body.conversions?.submittedPerPageView)}`
    );
  }
  return [...lines, '', ...metricNotes()].join('\n');
}

function healthLabel(value) {
  if (value === true || value === 'healthy' || value === 'fresh') return 'работает';
  if (value === false || value === 'degraded' || value === 'stale' || value === 'invalid' || value === 'missing')
    return 'проблема';
  return 'нет данных';
}

export function formatStatusCommand(snapshot, nowMs = Date.now()) {
  if (!snapshot || !Number.isSafeInteger(snapshot.checkedAtMs) || snapshot.checkedAtMs <= 0) {
    return 'MBL · состояние\n\nНезависимый мониторинг ещё не сохранил результат проверки. Состояние неизвестно.';
  }
  const ageMs = nowMs - snapshot.checkedAtMs;
  const stale = ageMs < -120_000 || ageMs > 10 * 60_000;
  const time = new Date(snapshot.checkedAtMs + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 16);
  return [
    'MBL · состояние',
    '',
    `Последняя независимая проверка: ${time} (Иркутск)${stale ? ' — устарела' : ''}.`,
    `Сайт: ${healthLabel(snapshot.site)}`,
    `Готовность: ${healthLabel(snapshot.readiness)}`,
    `Redis: ${healthLabel(snapshot.redis)}`,
    `Worker: ${healthLabel(snapshot.worker)}`,
    `Очередь: ${healthLabel(snapshot.queue)}${snapshot.queueDepth === null ? '' : ` (${snapshot.queueDepth} ожидают)`}`,
    `Резервная копия: ${healthLabel(snapshot.backup)}`,
    stale ? 'Это последнее наблюдение, а не подтверждение текущего состояния.' : 'Данные независимого мониторинга.',
  ].join('\n');
}

export async function runTelegramAdminOnce(config, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const nowMs = options.nowMs ?? Date.now();
  const state = await readState(config.stateFile);
  const updates = await getUpdates(config, state.nextOffset, fetchImpl);
  const result = { received: updates.length, processed: 0, replied: 0, deliveryFailures: 0 };
  for (const update of updates) {
    const id = update?.update_id;
    if (!Number.isSafeInteger(id) || id < state.nextOffset) continue;
    // Persist before handling: after a crash the command may be lost, but it
    // cannot be delivered twice or replayed to trigger repeated API reads.
    state.nextOffset = id + 1;
    await writeState(config.stateFile, state);
    const message = update?.message;
    if (
      integerId(message?.from?.id) !== config.userId ||
      integerId(message?.chat?.id) !== config.chatId ||
      message?.chat?.type !== 'private'
    ) {
      continue;
    }
    const messageTimeMs = Number(message.date) * 1000;
    if (!Number.isSafeInteger(messageTimeMs) || Math.abs(nowMs - messageTimeMs) > 15 * 60_000) continue;
    const parts = String(message.text || '')
      .trim()
      .split(/\s+/);
    if (parts.length !== 1) continue;
    const command = parts[0].replace(/@MBL_Monitor_38_bot$/i, '');
    if (!COMMANDS.has(command)) continue;

    state.ownerRecentMs = state.ownerRecentMs.filter((item) => item > nowMs - 60_000);
    if (state.ownerRecentMs.length >= 6) {
      if (nowMs - state.rateNoticeAtMs < 60_000) continue;
      state.rateNoticeAtMs = nowMs;
      await writeState(config.stateFile, state);
      const limited = await sendTelegramMessage(
        {
          enabled: true,
          token: config.token,
          chatId: config.chatId,
          apiOrigin: config.apiOrigin,
          timeoutMs: config.timeoutMs,
          maxRetries: 0,
        },
        'Слишком много команд. Повторите через минуту.',
        { fetchImpl }
      );
      if (limited.ok) result.replied += 1;
      else result.deliveryFailures += 1;
      continue;
    }
    state.ownerRecentMs.push(nowMs);
    await writeState(config.stateFile, state);
    result.processed += 1;

    let reply;
    if (command === '/status') {
      const snapshot = await (options.statusReader || readMonitorStatusSnapshot)(config.statusFile);
      reply = formatStatusCommand(snapshot, nowMs);
    } else {
      const metrics = await fetchMetrics(config, command === '/week' ? 'week' : 'today', fetchImpl);
      reply = formatMetricsCommand(command, metrics);
    }
    const delivery = await sendTelegramMessage(
      {
        enabled: true,
        token: config.token,
        chatId: config.chatId,
        apiOrigin: config.apiOrigin,
        timeoutMs: config.timeoutMs,
        maxRetries: 0,
      },
      reply,
      { fetchImpl }
    );
    if (delivery.ok) result.replied += 1;
    else result.deliveryFailures += 1;
  }
  return result;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    console.log(JSON.stringify({ ok: true, ...(await runTelegramAdminOnce(loadTelegramAdminConfig())) }));
  } catch (error) {
    console.error(
      JSON.stringify({ ok: false, code: error instanceof TelegramAdminError ? error.code : 'TELEGRAM_ADMIN_FAILED' })
    );
    process.exitCode = 1;
  }
}
