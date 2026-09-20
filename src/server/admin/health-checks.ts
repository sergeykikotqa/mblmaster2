import { getFallbackLeadPipelineHealth } from '~/server/leads/metrics-fallback';
import { hasLeadAlertChannelConfig, probeLeadAlertEndpointReachability } from '~/server/leads/alerts';
import { getWorkerRuntimeHealth, type WorkerRuntimeHealth } from '~/server/leads/runtime-health';
import {
  isSmartCaptchaReady as isSmartCaptchaRuntimeReady,
  isSmartCaptchaRequired as isSmartCaptchaRuntimeRequired,
} from '~/server/leads/smartcaptcha';
import { getLeadStore, hasRedisLeadStoreConfig, isRedisRuntimeError } from '~/server/leads/store';
import { hasWebhookSecretConfig, isWebhookConfigured } from '~/server/leads/webhook';
import { getFunnelRollup } from '~/server/metrics/funnel';
import { parseBooleanEnv } from '~/server/utils/auth';

import { getAdminAuthConfigurationSnapshot, type AdminAuthMethod } from './auth';

const DEFAULT_RETRY_RATE_ALERT_THRESHOLD = 0.1;
const DEFAULT_PIPELINE_STRICT_STATUS = false;
const DEFAULT_MIN_CONVERSION_RATE = 0.03;
const DEFAULT_MIN_PAGE_VIEWS = 30;
const DEFAULT_METRICS_STRICT_STATUS = false;
const DEFAULT_ADMIN_HEALTH_CHECK_TIMEOUT_MS = 1500;
const DEFAULT_QUEUE_MAX_DEPTH = 1000;
const STRICT_STATUS_ENV_CANONICAL = 'METRICS_HEALTH_STRICT_STATUS';
const STRICT_STATUS_ENV_LEGACY = 'LEAD_METRICS_HEALTH_STRICT_STATUS';

let strictStatusEnvWarned = false;

type AdminHealthCheckTiming = {
  checkedAtMs: number;
  latencyMs: number;
};

export type AdminHealthCheckErrorPayload = {
  ok: false;
  service: string;
  authMethod: AdminAuthMethod;
  code: 'INTERNAL_ERROR' | 'TIMEOUT';
  timedOut?: boolean;
  timeoutMs?: number;
} & AdminHealthCheckTiming;

export type AdminSystemHealthPayload = {
  ok: true;
  service: 'system';
  authMethod: AdminAuthMethod;
  now: number;
  runtimeConfig: {
    trustProxyHeaders: {
      contact: boolean;
      track: boolean;
      admin: boolean;
    };
  };
  tokenConfigured: boolean;
  allowlistConfigured: boolean;
  invalidAllowlistEntriesCount: number;
  trustProxyHeaders: boolean;
} & AdminHealthCheckTiming;

export type AdminWorkerHealthPayload = {
  ok: boolean;
  service: 'lead-worker';
  status: 'ok' | 'degraded';
  authMethod: AdminAuthMethod;
  now: number;
  dependencies?: {
    workerTokenConfigured: boolean;
    redisConfigured: boolean;
    webhookConfigured: boolean;
    webhookSecretConfigured: boolean;
    alertChannelConfigured: boolean;
    alertEndpointReachable: boolean;
    smartCaptchaRequired: boolean;
    smartCaptchaReady: boolean;
    workerPaused: boolean;
  };
  runtime: WorkerRuntimeHealth;
} & AdminHealthCheckTiming;

export type AdminPipelineHealthPayload =
  | ({
      ok: boolean;
      service: 'lead-pipeline';
      strictMode: boolean;
      authMethod: AdminAuthMethod;
      metricsDataSource: 'redis' | 'memory' | 'fallback_memory';
      metricsDegraded?: boolean;
      generatedAtMs: number;
      retryRateLastHour: number;
      dlqLastHour: number;
      dlqLast24Hours: number;
      p95LatencyMs: number | null;
      queueDepth: number | null;
      queueBackpressureThreshold: number;
      workerPaused: boolean;
      counters: Record<string, number>;
      alerts: {
        dlqIncident: boolean;
        retryRateWarning: boolean;
        retryRateAlertThreshold: number;
        alertChannelConfigured: boolean;
        alertEndpointReachable: boolean;
        queueBackpressure: boolean;
      };
    } & AdminHealthCheckTiming)
  | AdminHealthCheckErrorPayload;

export type AdminMetricsHealthPayload =
  | ({
      ok: boolean;
      service: 'lead-metrics';
      strictMode: boolean;
      authMethod: AdminAuthMethod;
      city: string | null;
      generatedAtMs: number;
      dataSource: 'redis' | 'memory';
      bucket: string;
      span: 'day';
      totals: {
        pageViews: number;
        formOpened: number;
        formSubmitted: number;
        openedRate: number;
        submitRate: number;
        conversionRate: number;
      };
      alerts: {
        lowConversion: boolean;
        minConversionRate: number;
        minPageViews: number;
      };
      sampledPages: number;
    } & AdminHealthCheckTiming)
  | AdminHealthCheckErrorPayload;

export type AdminHealthCheckEntry<TPayload> = {
  status: number;
  payload: TPayload;
};

export type AdminHealthAggregateChecks = {
  system: AdminHealthCheckEntry<AdminSystemHealthPayload | AdminHealthCheckErrorPayload>;
  worker: AdminHealthCheckEntry<AdminWorkerHealthPayload | AdminHealthCheckErrorPayload>;
  pipeline: AdminHealthCheckEntry<AdminPipelineHealthPayload>;
  metrics: AdminHealthCheckEntry<AdminMetricsHealthPayload>;
};

export type AdminHealthSummary = {
  status: 'ok' | 'warning' | 'degraded';
  ok: boolean;
  degraded: boolean;
  warning: boolean;
  authMethod: AdminAuthMethod;
  redis: {
    ok: boolean;
    label: string;
    source: string | null;
  };
  snapshot: {
    ok: boolean;
    label: string;
    source: string | null;
  };
  worker: {
    ok: boolean;
    label: string;
    status: string | null;
    heartbeatState: string | null;
    oldestPendingState: string | null;
    oldestPendingAgeMs: number | null;
  };
  failOpen: boolean;
  systemAuth: {
    status: 'OK' | 'WARNING';
    tokenConfigured: boolean;
    allowlistConfigured: boolean;
    invalidAllowlistEntriesCount: number;
  };
  proxyTrust: {
    enabled: boolean;
    label: 'enabled' | 'disabled';
  };
};

export type AdminHealthAggregatePayload = {
  ok: boolean;
  authMethod: AdminAuthMethod;
  generatedAtMs: number;
  checks: AdminHealthAggregateChecks;
  summary: AdminHealthSummary;
};

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveAdminHealthCheckTimeoutMs(): number {
  return parsePositiveInt(process.env.ADMIN_HEALTH_CHECK_TIMEOUT_MS, DEFAULT_ADMIN_HEALTH_CHECK_TIMEOUT_MS, 50);
}

function resolveQueueBackpressureThreshold(): number {
  return parsePositiveInt(process.env.CONTACT_QUEUE_MAX_DEPTH, DEFAULT_QUEUE_MAX_DEPTH, 1);
}

function parseThreshold(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseFraction(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function createCheckTiming(startedAtMs: number, checkedAtMs = Date.now()): AdminHealthCheckTiming {
  return {
    checkedAtMs,
    latencyMs: Math.max(0, checkedAtMs - startedAtMs),
  };
}

function hasWorkerTokenConfig(): boolean {
  return Boolean((process.env.CONTACT_WORKER_TOKEN || '').trim());
}

function isWorkerPaused(): boolean {
  return parseBooleanEnv(process.env.CONTACT_WORKER_PAUSED, false);
}

async function getWorkerDependencyStatus() {
  const smartCaptchaRequired = isSmartCaptchaRuntimeRequired();
  const smartCaptchaReady = isSmartCaptchaRuntimeReady();
  const alertReachability = await probeLeadAlertEndpointReachability();

  return {
    workerTokenConfigured: hasWorkerTokenConfig(),
    redisConfigured: hasRedisLeadStoreConfig(),
    webhookConfigured: isWebhookConfigured(),
    webhookSecretConfigured: hasWebhookSecretConfig(),
    alertChannelConfigured: hasLeadAlertChannelConfig(),
    alertEndpointReachable: alertReachability.reachable,
    smartCaptchaRequired,
    smartCaptchaReady,
    workerPaused: isWorkerPaused(),
  };
}

function isWorkerRuntimeReady(
  dependencies: NonNullable<AdminWorkerHealthPayload['dependencies']>,
  runtime: WorkerRuntimeHealth
): boolean {
  return (
    dependencies.workerTokenConfigured &&
    dependencies.redisConfigured &&
    dependencies.webhookConfigured &&
    dependencies.webhookSecretConfigured &&
    dependencies.smartCaptchaReady &&
    dependencies.alertChannelConfigured &&
    dependencies.alertEndpointReachable &&
    !dependencies.workerPaused &&
    runtime.ok
  );
}

function warnStrictStatusEnv(message: string) {
  if (strictStatusEnvWarned) return;
  strictStatusEnvWarned = true;
  console.warn(`[lead-metrics-health] ${message}`);
}

function resolveMetricsStrictStatusByEnv(): boolean {
  const canonicalRaw = String(process.env[STRICT_STATUS_ENV_CANONICAL] || '').trim();
  const legacyRaw = String(process.env[STRICT_STATUS_ENV_LEGACY] || '').trim();

  const hasCanonical = canonicalRaw.length > 0;
  const hasLegacy = legacyRaw.length > 0;

  if (hasCanonical && hasLegacy) {
    const canonicalValue = parseBooleanEnv(canonicalRaw, DEFAULT_METRICS_STRICT_STATUS);
    const legacyValue = parseBooleanEnv(legacyRaw, DEFAULT_METRICS_STRICT_STATUS);
    if (canonicalValue !== legacyValue) {
      warnStrictStatusEnv(
        `both ${STRICT_STATUS_ENV_CANONICAL} and ${STRICT_STATUS_ENV_LEGACY} are set with conflicting values; ${STRICT_STATUS_ENV_CANONICAL} takes precedence`
      );
    } else {
      warnStrictStatusEnv(
        `${STRICT_STATUS_ENV_LEGACY} is deprecated and ignored when ${STRICT_STATUS_ENV_CANONICAL} is set`
      );
    }
    return canonicalValue;
  }

  if (hasCanonical) {
    return parseBooleanEnv(canonicalRaw, DEFAULT_METRICS_STRICT_STATUS);
  }

  if (hasLegacy) {
    warnStrictStatusEnv(`${STRICT_STATUS_ENV_LEGACY} is deprecated; migrate to ${STRICT_STATUS_ENV_CANONICAL}`);
    return parseBooleanEnv(legacyRaw, DEFAULT_METRICS_STRICT_STATUS);
  }

  return DEFAULT_METRICS_STRICT_STATUS;
}

class AdminHealthCheckTimeoutError extends Error {
  constructor(
    readonly service: string,
    readonly timeoutMs: number
  ) {
    super(`${service} timed out after ${timeoutMs}ms`);
    this.name = 'AdminHealthCheckTimeoutError';
  }
}

async function withTimeout<T>(service: string, operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timerId = setTimeout(() => reject(new AdminHealthCheckTimeoutError(service, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timerId) {
      clearTimeout(timerId);
    }
  }
}

function isTimeoutPayload(payload: unknown): payload is AdminHealthCheckErrorPayload {
  return typeof payload === 'object' && payload !== null && 'code' in payload && payload.code === 'TIMEOUT';
}

function createInternalErrorCheck(
  service: string,
  authMethod: AdminAuthMethod,
  startedAtMs = Date.now()
): AdminHealthCheckEntry<AdminHealthCheckErrorPayload> {
  const timing = createCheckTiming(startedAtMs);
  return {
    status: 500,
    payload: {
      ok: false,
      service,
      authMethod,
      code: 'INTERNAL_ERROR',
      ...timing,
    },
  };
}

function createTimeoutCheck(
  service: string,
  authMethod: AdminAuthMethod,
  startedAtMs: number,
  timeoutMs: number
): AdminHealthCheckEntry<AdminHealthCheckErrorPayload> {
  const timing = createCheckTiming(startedAtMs);
  return {
    status: 503,
    payload: {
      ok: false,
      service,
      authMethod,
      code: 'TIMEOUT',
      timedOut: true,
      timeoutMs,
      ...timing,
    },
  };
}

export function buildSystemHealthCheck(authMethod: AdminAuthMethod): AdminHealthCheckEntry<AdminSystemHealthPayload> {
  const startedAtMs = Date.now();
  const runtimeConfig = {
    trustProxyHeaders: {
      contact: parseBooleanEnv(process.env.CONTACT_TRUST_PROXY_HEADERS, false),
      track: parseBooleanEnv(
        process.env.TRACK_TRUST_PROXY_HEADERS,
        parseBooleanEnv(process.env.CONTACT_TRUST_PROXY_HEADERS, false)
      ),
      admin: parseBooleanEnv(process.env.ADMIN_TRUST_PROXY_HEADERS, false),
    },
  };
  const authConfig = getAdminAuthConfigurationSnapshot();
  const timing = createCheckTiming(startedAtMs);

  return {
    status: 200,
    payload: {
      ok: true,
      service: 'system',
      authMethod,
      now: timing.checkedAtMs,
      runtimeConfig,
      tokenConfigured: authConfig.tokenConfigured,
      allowlistConfigured: authConfig.allowlistConfigured,
      invalidAllowlistEntriesCount: authConfig.invalidAllowlistEntriesCount,
      trustProxyHeaders: authConfig.trustProxyHeaders,
      ...timing,
    },
  };
}

export async function buildWorkerHealthCheck(
  authMethod: AdminAuthMethod
): Promise<AdminHealthCheckEntry<AdminWorkerHealthPayload>> {
  const startedAtMs = Date.now();
  const [dependencies, runtime] = await Promise.all([getWorkerDependencyStatus(), getWorkerRuntimeHealth()]);
  const ok = isWorkerRuntimeReady(dependencies, runtime);
  const status = import.meta.env.PROD && !ok ? 503 : 200;
  const timing = createCheckTiming(startedAtMs);

  return {
    status,
    payload: {
      ok,
      service: 'lead-worker',
      status: ok ? 'ok' : 'degraded',
      authMethod,
      now: timing.checkedAtMs,
      dependencies,
      runtime,
      ...timing,
    },
  };
}

export async function buildPipelineHealthCheck(
  authMethod: AdminAuthMethod,
  options: { strictMode?: boolean } = {}
): Promise<AdminHealthCheckEntry<AdminPipelineHealthPayload>> {
  const startedAtMs = Date.now();
  const strictMode =
    options.strictMode === true ||
    parseBooleanEnv(process.env.CONTACT_LEAD_PIPELINE_HEALTH_STRICT_STATUS, DEFAULT_PIPELINE_STRICT_STATUS);

  try {
    const store = getLeadStore();
    const [health, alertReachability] = await Promise.all([
      store.getLeadPipelineHealth(Date.now()),
      probeLeadAlertEndpointReachability(),
    ]);
    const retryRateAlertThreshold = parseThreshold(
      process.env.CONTACT_RETRY_RATE_ALERT_THRESHOLD,
      DEFAULT_RETRY_RATE_ALERT_THRESHOLD
    );
    const queueBackpressureThreshold = resolveQueueBackpressureThreshold();
    const queueDepth = health.queueDepth ?? null;
    const workerPaused = isWorkerPaused();
    const alertChannelConfigured = hasLeadAlertChannelConfig();
    const alertEndpointReachable = alertReachability.reachable;

    const dlqIncident = health.dlqLastHour > 0;
    const retryRateWarning = health.retryRateLastHour >= retryRateAlertThreshold;
    const queueBackpressure = queueDepth !== null && queueDepth >= queueBackpressureThreshold;
    const ok = !dlqIncident && !queueBackpressure && !workerPaused && alertChannelConfigured && alertEndpointReachable;
    const status = import.meta.env.PROD && (strictMode ? dlqIncident || !ok : !ok) ? 503 : 200;
    const timing = createCheckTiming(startedAtMs);

    return {
      status,
      payload: {
        ok,
        service: 'lead-pipeline',
        strictMode,
        authMethod,
        metricsDataSource: store.mode === 'redis' ? 'redis' : 'memory',
        generatedAtMs: health.generatedAtMs,
        retryRateLastHour: Number(health.retryRateLastHour.toFixed(4)),
        dlqLastHour: health.dlqLastHour,
        dlqLast24Hours: health.dlqLast24Hours,
        p95LatencyMs: health.p95LatencyMs,
        queueDepth,
        queueBackpressureThreshold,
        workerPaused,
        counters: health.counters,
        alerts: {
          dlqIncident,
          retryRateWarning,
          retryRateAlertThreshold,
          alertChannelConfigured,
          alertEndpointReachable,
          queueBackpressure,
        },
        ...timing,
      },
    };
  } catch (error) {
    if (isRedisRuntimeError(error)) {
      const [health, alertReachability] = await Promise.all([
        Promise.resolve(getFallbackLeadPipelineHealth(Date.now())),
        probeLeadAlertEndpointReachability(),
      ]);
      const retryRateAlertThreshold = parseThreshold(
        process.env.CONTACT_RETRY_RATE_ALERT_THRESHOLD,
        DEFAULT_RETRY_RATE_ALERT_THRESHOLD
      );
      const queueBackpressureThreshold = resolveQueueBackpressureThreshold();
      const queueDepth = health.queueDepth ?? null;
      const workerPaused = isWorkerPaused();
      const alertChannelConfigured = hasLeadAlertChannelConfig();
      const alertEndpointReachable = alertReachability.reachable;
      const dlqIncident = health.dlqLastHour > 0;
      const retryRateWarning = health.retryRateLastHour >= retryRateAlertThreshold;
      const queueBackpressure = queueDepth !== null && queueDepth >= queueBackpressureThreshold;
      const ok =
        !dlqIncident && !queueBackpressure && !workerPaused && alertChannelConfigured && alertEndpointReachable;
      const status = import.meta.env.PROD && (strictMode ? dlqIncident || !ok : !ok) ? 503 : 200;
      const timing = createCheckTiming(startedAtMs);

      console.warn('[lead-pipeline-health] primary_metrics_unavailable_using_fallback', {
        code: error instanceof Error ? error.message : 'UNKNOWN',
      });

      return {
        status,
        payload: {
          ok,
          service: 'lead-pipeline',
          strictMode,
          authMethod,
          metricsDataSource: 'fallback_memory',
          metricsDegraded: true,
          generatedAtMs: health.generatedAtMs,
          retryRateLastHour: Number(health.retryRateLastHour.toFixed(4)),
          dlqLastHour: health.dlqLastHour,
          dlqLast24Hours: health.dlqLast24Hours,
          p95LatencyMs: health.p95LatencyMs,
          queueDepth,
          queueBackpressureThreshold,
          workerPaused,
          counters: health.counters,
          alerts: {
            dlqIncident,
            retryRateWarning,
            retryRateAlertThreshold,
            alertChannelConfigured,
            alertEndpointReachable,
            queueBackpressure,
          },
          ...timing,
        },
      };
    }

    console.error('[lead-pipeline-health] unhandled_error', error);
    return createInternalErrorCheck('lead-pipeline', authMethod, startedAtMs);
  }
}

export async function buildMetricsHealthCheck(
  authMethod: AdminAuthMethod,
  options: { strictMode?: boolean; city?: string } = {}
): Promise<AdminHealthCheckEntry<AdminMetricsHealthPayload>> {
  const startedAtMs = Date.now();
  const city = String(options.city || '').trim();
  const strictMode = options.strictMode === true || resolveMetricsStrictStatusByEnv();

  try {
    const minConversionRate = parseFraction(process.env.LEAD_METRICS_MIN_CONVERSION_RATE, DEFAULT_MIN_CONVERSION_RATE);
    const minPageViews = parsePositiveInt(process.env.LEAD_METRICS_MIN_PAGE_VIEWS, DEFAULT_MIN_PAGE_VIEWS, 1);

    const rollup = await getFunnelRollup({
      span: 'day',
      city: city || undefined,
      limit: 10,
    });

    const pageViews = rollup.totalPageViews;
    const opened = rollup.totalOpened;
    const submitted = rollup.totalSubmitted;
    const openedRate = pageViews > 0 ? opened / pageViews : 0;
    const submitRate = opened > 0 ? submitted / opened : 0;
    const conversionRate = pageViews > 0 ? submitted / pageViews : 0;
    const lowConversion = pageViews >= minPageViews && conversionRate < minConversionRate;
    const status = strictMode && import.meta.env.PROD && lowConversion ? 503 : 200;
    const timing = createCheckTiming(startedAtMs);

    return {
      status,
      payload: {
        ok: !lowConversion,
        service: 'lead-metrics',
        strictMode,
        authMethod,
        city: city || null,
        generatedAtMs: rollup.generatedAtMs,
        dataSource: rollup.dataSource,
        bucket: rollup.bucket,
        span: 'day',
        totals: {
          pageViews,
          formOpened: opened,
          formSubmitted: submitted,
          openedRate: Number(openedRate.toFixed(4)),
          submitRate: Number(submitRate.toFixed(4)),
          conversionRate: Number(conversionRate.toFixed(4)),
        },
        alerts: {
          lowConversion,
          minConversionRate,
          minPageViews,
        },
        sampledPages: rollup.entries.length,
        ...timing,
      },
    };
  } catch (error) {
    console.error('[lead-metrics-health] unhandled_error', error);
    return createInternalErrorCheck('lead-metrics', authMethod, startedAtMs);
  }
}

export function buildAdminHealthSummary(
  checks: AdminHealthAggregateChecks,
  authMethod: AdminAuthMethod
): AdminHealthSummary {
  const systemPayload = checks.system.payload;
  const workerPayload = checks.worker.payload;
  const pipelinePayload = checks.pipeline.payload;
  const metricsPayload = checks.metrics.payload;

  const pipelineStatus = checks.pipeline.status;
  const metricsStatus = checks.metrics.status;
  const workerStatusCode = checks.worker.status;
  const systemStatusCode = checks.system.status;

  const redisSource =
    typeof pipelinePayload === 'object' && pipelinePayload && 'metricsDataSource' in pipelinePayload
      ? String(pipelinePayload.metricsDataSource || '')
      : '';
  const redisOk = pipelineStatus < 500 && redisSource === 'redis';
  const redisLabel = isTimeoutPayload(pipelinePayload)
    ? 'DEGRADED (timeout)'
    : pipelineStatus >= 500
      ? 'ERROR'
      : redisSource === 'redis'
        ? 'OK'
        : redisSource
          ? `DEGRADED (${redisSource})`
          : 'UNKNOWN';

  const snapshotSource =
    typeof metricsPayload === 'object' && metricsPayload && 'dataSource' in metricsPayload
      ? String(metricsPayload.dataSource || '')
      : '';
  const snapshotOk = metricsStatus < 500 && metricsPayload.ok === true;
  const snapshotLabel = isTimeoutPayload(metricsPayload)
    ? 'DEGRADED (timeout)'
    : metricsStatus >= 500
      ? 'ERROR'
      : snapshotOk
        ? 'OK'
        : `DEGRADED (${snapshotSource || 'unknown'})`;

  const workerOk = workerStatusCode < 500 && workerPayload.ok === true;
  const workerLabel = isTimeoutPayload(workerPayload)
    ? 'DEGRADED (timeout)'
    : workerStatusCode >= 500
      ? 'ERROR'
      : workerOk
        ? 'OK'
        : String(('status' in workerPayload && workerPayload.status) || 'degraded').toUpperCase();
  const workerStatus =
    typeof workerPayload === 'object' && workerPayload && 'status' in workerPayload
      ? String(workerPayload.status || '')
      : null;
  const workerDependencies =
    typeof workerPayload === 'object' && workerPayload && 'dependencies' in workerPayload
      ? workerPayload.dependencies
      : undefined;
  const workerRuntime =
    typeof workerPayload === 'object' && workerPayload && 'runtime' in workerPayload
      ? workerPayload.runtime
      : undefined;
  const workerPaused = Boolean(workerDependencies?.workerPaused);
  const alertChannelConfigured = Boolean(workerDependencies?.alertChannelConfigured);
  const alertEndpointReachable = Boolean(workerDependencies?.alertEndpointReachable);
  const heartbeatState = workerRuntime?.heartbeat.state || null;
  const heartbeatStatus = workerRuntime?.heartbeat.value?.status || null;
  const oldestPendingState = workerRuntime?.oldestPending.state || null;
  const oldestPendingAgeMs = workerRuntime?.oldestPending.ageMs ?? null;

  const failOpen =
    redisSource === 'fallback_memory' ||
    Boolean('metricsDegraded' in pipelinePayload && pipelinePayload.metricsDegraded);
  const pipelineOk =
    typeof pipelinePayload === 'object' &&
    pipelinePayload !== null &&
    'ok' in pipelinePayload &&
    typeof pipelinePayload.ok === 'boolean'
      ? pipelinePayload.ok
      : false;
  const pipelineQueueBackpressure =
    typeof pipelinePayload === 'object' &&
    pipelinePayload !== null &&
    'alerts' in pipelinePayload &&
    pipelinePayload.alerts &&
    typeof pipelinePayload.alerts === 'object' &&
    'queueBackpressure' in pipelinePayload.alerts
      ? Boolean(pipelinePayload.alerts.queueBackpressure)
      : false;

  const tokenConfigured =
    typeof systemPayload === 'object' && systemPayload && 'tokenConfigured' in systemPayload
      ? Boolean(systemPayload.tokenConfigured)
      : false;
  const allowlistConfigured =
    typeof systemPayload === 'object' && systemPayload && 'allowlistConfigured' in systemPayload
      ? Boolean(systemPayload.allowlistConfigured)
      : false;
  const invalidAllowlistEntriesCount =
    typeof systemPayload === 'object' && systemPayload && 'invalidAllowlistEntriesCount' in systemPayload
      ? Number(systemPayload.invalidAllowlistEntriesCount || 0)
      : 0;
  const systemAuthWarning = systemStatusCode < 500 && (!tokenConfigured || invalidAllowlistEntriesCount > 0);
  const systemAuthStatus = systemStatusCode >= 500 || systemAuthWarning ? 'WARNING' : 'OK';

  const proxyTrustEnabled =
    typeof systemPayload === 'object' && systemPayload && 'trustProxyHeaders' in systemPayload
      ? Boolean(systemPayload.trustProxyHeaders)
      : false;

  const degraded =
    systemStatusCode >= 500 ||
    pipelineStatus >= 500 ||
    metricsStatus >= 500 ||
    workerStatusCode >= 500 ||
    !redisOk ||
    !snapshotOk ||
    !workerOk ||
    !pipelineOk ||
    failOpen;
  const warning = !degraded && systemAuthWarning;
  const status = degraded ? 'degraded' : warning ? 'warning' : 'ok';
  const workerLabelSuffix = [
    workerPaused ? 'paused' : '',
    heartbeatState === 'stale' ? 'heartbeat_stale' : '',
    heartbeatState === 'missing' ? 'heartbeat_missing' : '',
    heartbeatState === 'unavailable' ? 'redis_unavailable' : '',
    heartbeatStatus === 'error' ? 'last_cycle_error' : '',
    oldestPendingState === 'warning' ? 'oldest_pending_warning' : '',
    oldestPendingState === 'critical' ? 'oldest_pending_critical' : '',
    !alertChannelConfigured ? 'alerts_unconfigured' : '',
    alertChannelConfigured && !alertEndpointReachable ? 'alerts_unreachable' : '',
    pipelineQueueBackpressure ? 'queue_backpressure' : '',
  ]
    .filter(Boolean)
    .join(',');

  return {
    status,
    ok: status === 'ok',
    degraded,
    warning,
    authMethod,
    redis: {
      ok: redisOk,
      label: redisLabel,
      source: redisSource || null,
    },
    snapshot: {
      ok: snapshotOk,
      label: snapshotLabel,
      source: snapshotSource || null,
    },
    worker: {
      ok: workerOk,
      label: workerLabelSuffix ? `${workerLabel} (${workerLabelSuffix})` : workerLabel,
      status: workerStatus,
      heartbeatState,
      oldestPendingState,
      oldestPendingAgeMs,
    },
    failOpen,
    systemAuth: {
      status: systemAuthStatus,
      tokenConfigured,
      allowlistConfigured,
      invalidAllowlistEntriesCount,
    },
    proxyTrust: {
      enabled: proxyTrustEnabled,
      label: proxyTrustEnabled ? 'enabled' : 'disabled',
    },
  };
}

export function buildAdminHealthAggregatePayload(
  authMethod: AdminAuthMethod,
  checks: AdminHealthAggregateChecks
): AdminHealthAggregatePayload {
  const summary = buildAdminHealthSummary(checks, authMethod);

  return {
    ok: summary.ok,
    authMethod,
    generatedAtMs: Date.now(),
    checks,
    summary,
  };
}

function normalizeTimeoutMs(timeoutMs?: number): number {
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return resolveAdminHealthCheckTimeoutMs();
  }

  return Math.max(50, Math.floor(parsed));
}

export async function runHealthCheckWithTimeout<TPayload>(
  service: string,
  authMethod: AdminAuthMethod,
  factory: () => Promise<AdminHealthCheckEntry<TPayload>> | AdminHealthCheckEntry<TPayload>,
  options: { timeoutMs?: number } = {}
): Promise<AdminHealthCheckEntry<TPayload | AdminHealthCheckErrorPayload>> {
  const startedAtMs = Date.now();
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);

  try {
    return await withTimeout(service, Promise.resolve().then(factory), timeoutMs);
  } catch (error) {
    if (error instanceof AdminHealthCheckTimeoutError) {
      console.warn(`[admin-health] ${service}_check_timed_out`, {
        timeoutMs,
      });
      return createTimeoutCheck(service, authMethod, startedAtMs, timeoutMs);
    }

    console.error(`[admin-health] ${service}_check_failed`, error);
    return createInternalErrorCheck(service, authMethod, startedAtMs);
  }
}

export async function buildAdminHealthAggregateCheck(
  authMethod: AdminAuthMethod
): Promise<AdminHealthCheckEntry<AdminHealthAggregatePayload>> {
  const results = await Promise.allSettled([
    runHealthCheckWithTimeout('system', authMethod, () => buildSystemHealthCheck(authMethod)),
    runHealthCheckWithTimeout('lead-worker', authMethod, () => buildWorkerHealthCheck(authMethod)),
    runHealthCheckWithTimeout('lead-pipeline', authMethod, () => buildPipelineHealthCheck(authMethod)),
    runHealthCheckWithTimeout('lead-metrics', authMethod, () => buildMetricsHealthCheck(authMethod)),
  ]);

  const [systemResult, workerResult, pipelineResult, metricsResult] = results;
  const system =
    systemResult.status === 'fulfilled' ? systemResult.value : createInternalErrorCheck('system', authMethod);
  const worker =
    workerResult.status === 'fulfilled' ? workerResult.value : createInternalErrorCheck('lead-worker', authMethod);
  const pipeline =
    pipelineResult.status === 'fulfilled'
      ? pipelineResult.value
      : createInternalErrorCheck('lead-pipeline', authMethod);
  const metrics =
    metricsResult.status === 'fulfilled' ? metricsResult.value : createInternalErrorCheck('lead-metrics', authMethod);

  return {
    status: 200,
    payload: buildAdminHealthAggregatePayload(authMethod, {
      system,
      worker,
      pipeline,
      metrics,
    }),
  };
}
