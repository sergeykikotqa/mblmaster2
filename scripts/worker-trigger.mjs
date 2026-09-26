import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_WORKER_URL = 'http://mbl-web:4321/api/workers/lead-delivery';
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_LIMIT = 20;

function parsePositiveInt(value, fallback, minimum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

export function resolveWorkerTriggerConfig(env = process.env) {
  const token = String(env.CONTACT_WORKER_TOKEN || '').trim();
  if (!token) {
    throw new Error('CONTACT_WORKER_TOKEN is required');
  }

  let workerUrl;
  try {
    workerUrl = new URL(String(env.WORKER_TRIGGER_URL || DEFAULT_WORKER_URL).trim());
  } catch {
    throw new Error('WORKER_TRIGGER_URL must be a valid absolute URL');
  }

  if (!['http:', 'https:'].includes(workerUrl.protocol)) {
    throw new Error('WORKER_TRIGGER_URL must use http or https');
  }
  if (workerUrl.username || workerUrl.password) {
    throw new Error('WORKER_TRIGGER_URL must not contain credentials');
  }
  if (workerUrl.searchParams.has('token') || workerUrl.searchParams.has('access_token')) {
    throw new Error('Worker credentials must be supplied only through CONTACT_WORKER_TOKEN');
  }
  workerUrl.hash = '';

  return {
    token,
    workerUrl,
    intervalMs: parsePositiveInt(env.WORKER_TRIGGER_INTERVAL_MS, DEFAULT_INTERVAL_MS, 250),
    requestTimeoutMs: parsePositiveInt(env.WORKER_TRIGGER_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 250),
    batchLimit: parsePositiveInt(env.WORKER_TRIGGER_BATCH_LIMIT, DEFAULT_BATCH_LIMIT, 1),
  };
}

function safeEndpointLabel(url) {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

async function readJson(response) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`WORKER_INVALID_JSON_${response.status}`);
  }
}

export async function runWorkerCycle(config, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const startedAtMs = Date.now();

  try {
    const response = await fetchImpl(config.workerUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: config.batchLimit }),
      signal: controller.signal,
    });
    const payload = await readJson(response);

    if (!response.ok || payload?.success !== true) {
      throw new Error(`WORKER_HTTP_${response.status}`);
    }

    const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
    return {
      durationMs: Date.now() - startedAtMs,
      processed: Number(summary.processed || 0),
      delivered: Number(summary.delivered || 0),
      retried: Number(summary.retried || 0),
      failed: Number(summary.failed || 0),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('WORKER_REQUEST_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runWorkerLoop(config, options = {}) {
  const signal = options.signal;
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const endpoint = safeEndpointLabel(config.workerUrl);

  logger.info('[worker-trigger] started', {
    endpoint,
    cadenceMs: config.intervalMs,
    batchLimit: config.batchLimit,
  });

  while (!signal?.aborted) {
    const cycleStartedAtMs = Date.now();
    try {
      const result = await runWorkerCycle(config, fetchImpl);
      logger.info('[worker-trigger] cycle_ok', result);
    } catch (error) {
      logger.error('[worker-trigger] cycle_failed', {
        code: error instanceof Error ? error.message : 'UNKNOWN',
      });
    }

    const waitMs = Math.max(0, config.intervalMs - (Date.now() - cycleStartedAtMs));
    if (waitMs > 0 && !signal?.aborted) {
      try {
        await delay(waitMs, undefined, { signal });
      } catch (error) {
        if (!signal?.aborted) throw error;
      }
    }
  }

  logger.info('[worker-trigger] stopped');
}

async function main() {
  const config = resolveWorkerTriggerConfig();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await runWorkerLoop(config, { signal: controller.signal });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[worker-trigger] fatal', {
      code: error instanceof Error ? error.message : 'UNKNOWN',
    });
    process.exitCode = 1;
  });
}
