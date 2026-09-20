import { createHash } from 'node:crypto';
import process from 'node:process';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

import {
  loadTelegramNotificationConfig,
  notifyTelegramForReport,
  telegramNotifierErrorCode,
} from './telegram-monitor-notifier.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TLS_WARNING_DAYS = 30;
const DEFAULT_TLS_CRITICAL_DAYS = 14;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_HTML_BYTES = 512 * 1024;

class MonitorError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MonitorError';
    this.code = code;
  }
}

function assert(condition, code) {
  if (!condition) throw new MonitorError(code);
}

function parseBoolean(value, fallback = false) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value, fallback, minimum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

function validateUrl(raw, label, allowHttp) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new MonitorError(`${label}_URL_INVALID`);
  }
  assert(url.username === '' && url.password === '', `${label}_URL_CREDENTIALS_FORBIDDEN`);
  assert(url.hash === '', `${label}_URL_FRAGMENT_FORBIDDEN`);
  assert(url.protocol === 'https:' || (allowHttp && url.protocol === 'http:'), `${label}_HTTPS_REQUIRED`);
  return url;
}

export function loadExternalMonitorConfig(env = process.env) {
  const allowHttp = parseBoolean(env.MBL_MONITOR_ALLOW_HTTP, false);
  const baseUrl = validateUrl(env.MBL_MONITOR_BASE_URL, 'BASE', allowHttp);
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '') || '/';
  baseUrl.search = '';

  const token = String(env.MBL_MONITOR_TOKEN || '').trim();
  assert(token.length >= 24, 'MONITOR_TOKEN_MISSING_OR_WEAK');
  const successUrl = validateUrl(env.MBL_MONITOR_SUCCESS_URL, 'SUCCESS_SIGNAL', allowHttp);
  const failureUrl = validateUrl(env.MBL_MONITOR_FAILURE_URL, 'FAILURE_SIGNAL', allowHttp);
  assert(successUrl.origin !== baseUrl.origin, 'SUCCESS_SIGNAL_NOT_INDEPENDENT');
  assert(failureUrl.origin !== baseUrl.origin, 'FAILURE_SIGNAL_NOT_INDEPENDENT');

  return {
    baseUrl,
    token,
    successUrl,
    failureUrl,
    timeoutMs: parsePositiveInt(env.MBL_MONITOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000),
    tlsWarningDays: parsePositiveInt(env.MBL_MONITOR_TLS_WARNING_DAYS, DEFAULT_TLS_WARNING_DAYS, 1),
    tlsCriticalDays: parsePositiveInt(env.MBL_MONITOR_TLS_CRITICAL_DAYS, DEFAULT_TLS_CRITICAL_DAYS, 1),
    allowHttp,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
  } catch {
    throw new MonitorError('NETWORK_OR_TLS_ERROR');
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(response, maxBytes) {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new MonitorError('RESPONSE_TOO_LARGE');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MonitorError('RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function requestJson(url, options, timeoutMs) {
  const startedAt = Date.now();
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const raw = await readLimited(response, MAX_JSON_BYTES);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new MonitorError('INVALID_JSON');
  }
  return { response, body, latencyMs: Date.now() - startedAt };
}

async function checkHomepage(config) {
  const startedAt = Date.now();
  const response = await fetchWithTimeout(new URL('/', config.baseUrl), { method: 'GET' }, config.timeoutMs);
  assert(
    response.status === 200,
    response.status >= 300 && response.status < 400 ? 'EDGE_REDIRECTED' : 'EDGE_HTTP_ERROR'
  );
  assert(/text\/html/i.test(response.headers.get('content-type') || ''), 'EDGE_CONTENT_TYPE_INVALID');
  const html = await readLimited(response, MAX_HTML_BYTES);
  assert(/<html\b/i.test(html), 'EDGE_BODY_INVALID');
  return { ok: true, status: response.status, latencyMs: Date.now() - startedAt };
}

async function checkPublicJson(config, path, expectedStatus, expectedValue, errorCode) {
  const { response, body, latencyMs } = await requestJson(
    new URL(path, config.baseUrl),
    { method: 'GET' },
    config.timeoutMs
  );
  assert(response.status === 200, errorCode);
  assert(body?.ok === true && body?.status === expectedStatus, errorCode);
  assert(/no-store/i.test(response.headers.get('cache-control') || ''), `${errorCode}_CACHE_POLICY`);
  return { ok: true, status: response.status, value: expectedValue, latencyMs };
}

function safeIncidentCodes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((item) => /^[A-Z][A-Z0-9_]{2,63}$/.test(item)))].slice(0, 25).sort();
}

async function checkOperationalHealth(config) {
  const { response, body, latencyMs } = await requestJson(
    new URL('/api/monitoring/health', config.baseUrl),
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    },
    config.timeoutMs
  );
  if ([401, 403, 429].includes(response.status)) throw new MonitorError('MONITOR_AUTH_FAILED');
  assert([200, 503].includes(response.status), 'MONITOR_HTTP_ERROR');
  assert(body?.service === 'mbl-production' && Array.isArray(body?.incidents), 'MONITOR_CONTRACT_INVALID');
  const incidents = safeIncidentCodes(body.incidents);
  if (response.status !== 200 || body.ok !== true || incidents.length > 0) {
    return {
      ok: false,
      status: response.status,
      incidents: incidents.length > 0 ? incidents : ['MONITOR_DEGRADED'],
      latencyMs,
    };
  }
  return { ok: true, status: response.status, incidents: [], latencyMs };
}

async function checkTls(config, nowMs = Date.now()) {
  if (config.baseUrl.protocol !== 'https:') return { ok: true, skipped: true, daysRemaining: null };
  const port = Number(config.baseUrl.port || 443);
  const certificate = await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: config.baseUrl.hostname,
      port,
      servername: config.baseUrl.hostname,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => socket.destroy(new Error('timeout')), config.timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const peer = socket.getPeerCertificate();
      socket.end();
      resolve(peer);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      reject(new MonitorError('TLS_VALIDATION_FAILED'));
    });
  });
  const validToMs = Date.parse(String(certificate?.valid_to || ''));
  assert(Number.isFinite(validToMs), 'TLS_CERTIFICATE_INVALID');
  const daysRemaining = Math.floor((validToMs - nowMs) / 86_400_000);
  assert(daysRemaining > 0, 'TLS_CERTIFICATE_EXPIRED');
  return { ok: true, skipped: false, daysRemaining };
}

function reportFingerprint(codes) {
  return createHash('sha256')
    .update(codes.slice().sort().join(',') || 'healthy')
    .digest('hex')
    .slice(0, 24);
}

async function sendSignal(config, ok, report) {
  const target = ok ? config.successUrl : config.failureUrl;
  const payload = {
    event: 'mbl_external_monitor',
    status: ok ? 'ok' : 'failure',
    checkedAt: new Date(report.checkedAtMs).toISOString(),
    targetHost: config.baseUrl.hostname,
    incidentKey: reportFingerprint(report.codes),
    codes: report.codes,
    source: 'independent-monitor-host',
  };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        target,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': payload.incidentKey },
          body: JSON.stringify(payload),
        },
        config.timeoutMs
      );
      await response.body?.cancel();
      if (response.ok) return { delivered: true, status: response.status };
      lastError = new MonitorError('SIGNAL_HTTP_ERROR');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof MonitorError ? lastError : new MonitorError('SIGNAL_DELIVERY_FAILED');
}

function errorCode(error, fallback) {
  return error instanceof MonitorError ? error.code : fallback;
}

export async function runExternalMonitor(config, options = {}) {
  const checkedAtMs = options.nowMs ?? Date.now();
  const codes = [];
  const checks = {};
  let edgeHealthy = false;
  let liveHealthy = false;
  let readyHealthy = false;

  try {
    checks.tls = await checkTls(config, checkedAtMs);
    if (!checks.tls.skipped && checks.tls.daysRemaining <= config.tlsWarningDays) {
      codes.push(checks.tls.daysRemaining <= config.tlsCriticalDays ? 'TLS_EXPIRING_CRITICAL' : 'TLS_EXPIRING_WARNING');
    }
    checks.edge = await checkHomepage(config);
    edgeHealthy = true;
  } catch (error) {
    codes.push(errorCode(error, 'EDGE_UNAVAILABLE'));
  }

  if (edgeHealthy) {
    try {
      checks.live = await checkPublicJson(config, '/health/live', 'live', 'live', 'LIVENESS_FAILED');
      liveHealthy = true;
    } catch (error) {
      codes.push(errorCode(error, 'LIVENESS_FAILED'));
    }
  }

  if (liveHealthy) {
    try {
      checks.ready = await checkPublicJson(config, '/health/ready', 'ready', 'ready', 'READINESS_FAILED');
      readyHealthy = true;
    } catch (error) {
      codes.push(errorCode(error, 'READINESS_FAILED'));
    }
  }

  if (readyHealthy) {
    try {
      checks.operational = await checkOperationalHealth(config);
      if (!checks.operational.ok) codes.push(...checks.operational.incidents);
    } catch (error) {
      codes.push(errorCode(error, 'MONITOR_ENDPOINT_FAILED'));
    }
  }

  const uniqueCodes = [...new Set(codes)].sort();
  const report = {
    ok: uniqueCodes.length === 0,
    checkedAtMs,
    targetHost: config.baseUrl.hostname,
    codes: uniqueCodes,
    checks,
  };

  if (typeof options.notificationAdapter === 'function') {
    try {
      report.notification = await options.notificationAdapter({ ...report, codes: [...report.codes] });
      if (report.notification?.ok === false) {
        report.ok = false;
        report.codes = [
          ...new Set([...report.codes, report.notification.code || 'NOTIFICATION_DELIVERY_FAILED']),
        ].sort();
      }
    } catch {
      report.ok = false;
      report.codes = [...new Set([...report.codes, 'NOTIFICATION_ADAPTER_FAILED'])].sort();
      report.notification = { ok: false, action: 'unknown', delivered: false, code: 'NOTIFICATION_ADAPTER_FAILED' };
    }
  }

  try {
    report.signal = await sendSignal(config, report.ok, report);
  } catch (error) {
    report.ok = false;
    report.codes = [...new Set([...report.codes, errorCode(error, 'SIGNAL_DELIVERY_FAILED')])].sort();
    report.signal = { delivered: false, status: null };
  }
  return report;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    let notificationAdapter;
    try {
      const telegramConfig = loadTelegramNotificationConfig();
      if (telegramConfig.enabled) {
        notificationAdapter = (report) => notifyTelegramForReport(telegramConfig, report);
      }
    } catch (error) {
      const code = telegramNotifierErrorCode(error);
      notificationAdapter = async () => ({
        ok: false,
        action: 'configuration',
        delivered: false,
        code,
      });
    }

    const report = await runExternalMonitor(loadExternalMonitorConfig(), { notificationAdapter });
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, codes: [errorCode(error, 'MONITOR_CONFIGURATION_FAILED')] }));
    process.exitCode = 1;
  }
}

export const EXTERNAL_MONITOR_LIMITS = Object.freeze({ MAX_JSON_BYTES, MAX_HTML_BYTES });
