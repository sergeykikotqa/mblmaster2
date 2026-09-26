import type { DailySnapshotAnomaly, DailySnapshotAnomalyReason } from '~/server/metrics/snapshot';
import type { HealthState, HealthScope } from '~/server/metrics/health-types';

type DeadLetterAlertPayload = {
  leadId: string;
  failedAt: string;
  attempts: number;
  maxRetries: number;
  finalStatus: string;
  errorCode: string;
  errorStatus?: number;
};

type RetryRateAlertPayload = {
  retryRateLastHour: number;
  retryRateThreshold: number;
  dlqLastHour: number;
  dlqLast24Hours: number;
  p95LatencyMs: number | null;
  generatedAtMs: number;
};

type BotProtectionDegradedAlertPayload = {
  provider: 'smartcaptcha';
  failureMode: 'closed';
  code: string;
  message: string;
  generatedAtMs: number;
};

type LeadStoreDegradedAlertPayload = {
  code: string;
  message: string;
  operation: string;
  generatedAtMs: number;
};

type ConversionSnapshotAlertPayload = {
  targetDay: string;
  baselineDays: number;
  generatedAtMs: number;
  dataSource: string;
  storageSource: string;
  metricsDegraded: boolean;
  anomalies: DailySnapshotAnomaly[];
  summary: {
    rows: number;
    anomalies: number;
    critical: number;
    warnings: number;
    byReason: Record<DailySnapshotAnomalyReason, number>;
  };
};

type ConversionHealthTransitionAlertPayload = {
  targetDay: string;
  baselineDays: number;
  generatedAtMs: number;
  dataSource: string;
  metricsDegraded: boolean;
  summary: {
    slicesEvaluated: number;
    transitions: number;
    blockedByHysteresis: number;
    byState: Record<HealthState, number>;
    byScope: Record<HealthScope, number>;
  };
  transitions: Array<{
    scope: HealthScope;
    key: string;
    from: HealthState;
    to: HealthState;
    at: string;
    reason: string;
    stableDays: number;
    opened: number;
    submitted: number;
    conversionRate: number;
    deltaPct: number;
  }>;
};

type ConversionHealthStoreFallbackAlertPayload = {
  targetDay: string;
  baselineDays: number;
  generatedAtMs: number;
  dataSource: string;
  metricsDegraded: boolean;
  fallbackCount: number;
  fallbackLastAtMs: number;
  summary: {
    slicesEvaluated: number;
    transitions: number;
    blockedByHysteresis: number;
    byState: Record<HealthState, number>;
    byScope: Record<HealthScope, number>;
  };
};

const DEFAULT_ALERT_TIMEOUT_MS = 3000;
const DEFAULT_ALERT_MAX_RETRIES = 1;
const DEFAULT_ALERT_RETRY_BASE_DELAY_MS = 500;
const ALERT_REACHABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

export type AlertChannelReachability = {
  configured: boolean;
  reachable: boolean;
  checkedAtMs: number;
  statusCode: number | null;
  errorCode: string | null;
};

let alertReachabilityCache:
  | {
      expiresAtMs: number;
      value: AlertChannelReachability;
    }
  | undefined;

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveAlertWebhookUrl(): string {
  return (process.env.CONTACT_ALERT_WEBHOOK_URL || '').trim();
}

function resolveSecondaryAlertWebhookUrl(): string {
  return (process.env.CONTACT_ALERT_WEBHOOK_URL_SECONDARY || '').trim();
}

function resolveAlertWebhookUrls(): string[] {
  return [resolveAlertWebhookUrl(), resolveSecondaryAlertWebhookUrl()].filter(Boolean);
}

export function hasLeadAlertChannelConfig(): boolean {
  return resolveAlertWebhookUrls().length > 0;
}

function resolveAlertToken(): string {
  return (process.env.CONTACT_ALERT_WEBHOOK_TOKEN || '').trim();
}

function resolveAlertTimeoutMs(): number {
  return parsePositiveInt(process.env.CONTACT_ALERT_TIMEOUT_MS, DEFAULT_ALERT_TIMEOUT_MS, 500);
}

function resolveAlertMaxRetries(): number {
  return parsePositiveInt(process.env.CONTACT_ALERT_MAX_RETRIES, DEFAULT_ALERT_MAX_RETRIES, 0);
}

function resolveAlertRetryBaseDelayMs(): number {
  return parsePositiveInt(process.env.CONTACT_ALERT_RETRY_BASE_DELAY_MS, DEFAULT_ALERT_RETRY_BASE_DELAY_MS, 100);
}

function isReachableProbeStatus(status: number): boolean {
  return (status >= 200 && status < 400) || status === 401 || status === 403 || status === 405;
}

async function probeAlertEndpoint(url: string, timeoutMs: number): Promise<AlertChannelReachability> {
  const methods: Array<'HEAD' | 'GET'> = ['HEAD', 'GET'];
  for (const method of methods) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
      });
      if (isReachableProbeStatus(response.status)) {
        return {
          configured: true,
          reachable: true,
          checkedAtMs: Date.now(),
          statusCode: response.status,
          errorCode: null,
        };
      }
      if (response.status >= 500) {
        return {
          configured: true,
          reachable: false,
          checkedAtMs: Date.now(),
          statusCode: response.status,
          errorCode: `HTTP_${response.status}`,
        };
      }
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      return {
        configured: true,
        reachable: false,
        checkedAtMs: Date.now(),
        statusCode: null,
        errorCode: aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    configured: true,
    reachable: false,
    checkedAtMs: Date.now(),
    statusCode: null,
    errorCode: 'UNREACHABLE',
  };
}

export async function probeLeadAlertEndpointReachability(force = false): Promise<AlertChannelReachability> {
  const nowMs = Date.now();
  if (!force && alertReachabilityCache && alertReachabilityCache.expiresAtMs > nowMs) {
    return alertReachabilityCache.value;
  }

  const urls = resolveAlertWebhookUrls();
  if (urls.length === 0) {
    const value = {
      configured: false,
      reachable: false,
      checkedAtMs: nowMs,
      statusCode: null,
      errorCode: 'ALERT_WEBHOOK_NOT_CONFIGURED',
    } satisfies AlertChannelReachability;
    alertReachabilityCache = {
      expiresAtMs: nowMs + ALERT_REACHABILITY_CACHE_TTL_MS,
      value,
    };
    return value;
  }

  let lastFailure: AlertChannelReachability | undefined;
  for (const url of urls) {
    const probe = await probeAlertEndpoint(url, resolveAlertTimeoutMs());
    if (probe.reachable) {
      alertReachabilityCache = {
        expiresAtMs: nowMs + ALERT_REACHABILITY_CACHE_TTL_MS,
        value: probe,
      };
      return probe;
    }
    lastFailure = probe;
  }

  const value =
    lastFailure ||
    ({
      configured: true,
      reachable: false,
      checkedAtMs: nowMs,
      statusCode: null,
      errorCode: 'UNREACHABLE',
    } satisfies AlertChannelReachability);
  alertReachabilityCache = {
    expiresAtMs: nowMs + ALERT_REACHABILITY_CACHE_TTL_MS,
    value,
  };
  return value;
}

function buildAlertBody(alert: DeadLetterAlertPayload) {
  return {
    event: 'lead_dead_letter_alert',
    timestamp: new Date().toISOString(),
    environment: import.meta.env.PROD ? 'production' : 'development',
    leadId: alert.leadId,
    failedAt: alert.failedAt,
    attempts: alert.attempts,
    maxRetries: alert.maxRetries,
    finalStatus: alert.finalStatus,
    errorCode: alert.errorCode,
    errorStatus: alert.errorStatus,
  };
}

function buildRetryRateAlertBody(alert: RetryRateAlertPayload) {
  return {
    event: 'lead_retry_rate_alert',
    timestamp: new Date().toISOString(),
    environment: import.meta.env.PROD ? 'production' : 'development',
    retryRateLastHour: Number(alert.retryRateLastHour.toFixed(4)),
    retryRateThreshold: Number(alert.retryRateThreshold.toFixed(4)),
    dlqLastHour: alert.dlqLastHour,
    dlqLast24Hours: alert.dlqLast24Hours,
    p95LatencyMs: alert.p95LatencyMs,
    generatedAtMs: alert.generatedAtMs,
  };
}

function buildBotProtectionDegradedBody(alert: BotProtectionDegradedAlertPayload) {
  return {
    event: 'bot_protection_degraded',
    timestamp: new Date().toISOString(),
    environment: import.meta.env.PROD ? 'production' : 'development',
    provider: alert.provider,
    failureMode: alert.failureMode,
    code: alert.code,
    message: alert.message,
    generatedAtMs: alert.generatedAtMs,
  };
}

function buildLeadStoreDegradedBody(alert: LeadStoreDegradedAlertPayload) {
  return {
    event: 'lead_store_degraded',
    timestamp: new Date().toISOString(),
    environment: import.meta.env.PROD ? 'production' : 'development',
    code: alert.code,
    message: alert.message,
    operation: alert.operation,
    generatedAtMs: alert.generatedAtMs,
  };
}

function buildConversionSnapshotAlertBody(alert: ConversionSnapshotAlertPayload) {
  return {
    event: 'conversion_snapshot_anomaly_alert',
    timestamp: new Date().toISOString(),
    environment: import.meta.env.PROD ? 'production' : 'development',
    targetDay: alert.targetDay,
    baselineDays: alert.baselineDays,
    generatedAtMs: alert.generatedAtMs,
    dataSource: alert.dataSource,
    storageSource: alert.storageSource,
    metricsDegraded: alert.metricsDegraded,
    summary: alert.summary,
    anomalies: alert.anomalies.slice(0, 25).map((item) => ({
      scope: item.scope,
      key: item.key,
      city: item.city,
      service: item.service,
      pageType: item.pageType,
      reason: item.reason,
      severity: item.severity,
      opened: item.opened,
      submitted: item.submitted,
      conversionRate: Number(item.conversionRate.toFixed(4)),
      baselineAvgOpened: Number(item.baselineAvgOpened.toFixed(2)),
      baselineAvgSubmitted: Number(item.baselineAvgSubmitted.toFixed(2)),
      baselineAvgConversionRate: Number(item.baselineAvgConversionRate.toFixed(4)),
      deltaConversionPct:
        typeof item.deltaConversionPct === 'number' ? Number(item.deltaConversionPct.toFixed(4)) : null,
    })),
  };
}

function buildConversionHealthTransitionAlertBody(alert: ConversionHealthTransitionAlertPayload) {
  return {
    event: 'conversion_health_transition_alert',
    timestamp: new Date().toISOString(),
    environment: import.meta.env.PROD ? 'production' : 'development',
    targetDay: alert.targetDay,
    baselineDays: alert.baselineDays,
    generatedAtMs: alert.generatedAtMs,
    dataSource: alert.dataSource,
    metricsDegraded: alert.metricsDegraded,
    summary: alert.summary,
    transitions: alert.transitions.slice(0, 50).map((item) => ({
      scope: item.scope,
      key: item.key,
      from: item.from,
      to: item.to,
      at: item.at,
      reason: item.reason,
      stableDays: item.stableDays,
      opened: item.opened,
      submitted: item.submitted,
      conversionRate: Number(item.conversionRate.toFixed(4)),
      deltaPct: Number(item.deltaPct.toFixed(4)),
    })),
  };
}

function buildConversionHealthStoreFallbackAlertBody(alert: ConversionHealthStoreFallbackAlertPayload) {
  return {
    event: 'conversion_health_store_fallback_alert',
    timestamp: new Date().toISOString(),
    environment: import.meta.env.PROD ? 'production' : 'development',
    targetDay: alert.targetDay,
    baselineDays: alert.baselineDays,
    generatedAtMs: alert.generatedAtMs,
    dataSource: alert.dataSource,
    metricsDegraded: alert.metricsDegraded,
    fallbackCount: alert.fallbackCount,
    fallbackLastAtMs: alert.fallbackLastAtMs,
    summary: alert.summary,
  };
}

async function postAlert(
  url: string,
  token: string,
  timeoutMs: number,
  body: Record<string, unknown>
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverAlertWithRetry(
  endpointName: string,
  webhookUrl: string,
  token: string,
  timeoutMs: number,
  maxRetries: number,
  retryBaseDelayMs: number,
  body: Record<string, unknown>
): Promise<boolean> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const sent = await postAlert(webhookUrl, token, timeoutMs, body);
    if (sent) {
      return true;
    }

    if (attempt < maxRetries) {
      const delayMs = retryBaseDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.error('[lead-alert] endpoint_exhausted', {
    endpointName,
    leadId: String(body.leadId || ''),
  });
  return false;
}

export async function notifyLeadDeadLetter(alert: DeadLetterAlertPayload): Promise<boolean> {
  const primaryWebhookUrl = resolveAlertWebhookUrl();
  const secondaryWebhookUrl = resolveSecondaryAlertWebhookUrl();

  if (!primaryWebhookUrl && !secondaryWebhookUrl) {
    console.error(
      JSON.stringify({
        event: 'lead_alert_channel_missing',
        timestamp: new Date().toISOString(),
        leadId: alert.leadId,
        severity: 'critical',
      })
    );
    return false;
  }

  const token = resolveAlertToken();
  const timeoutMs = resolveAlertTimeoutMs();
  const maxRetries = resolveAlertMaxRetries();
  const retryBaseDelayMs = resolveAlertRetryBaseDelayMs();
  const body = buildAlertBody(alert);

  let primarySent = false;
  let secondarySent = false;

  if (primaryWebhookUrl) {
    primarySent = await deliverAlertWithRetry(
      'primary',
      primaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  if (!primarySent && secondaryWebhookUrl) {
    secondarySent = await deliverAlertWithRetry(
      'secondary',
      secondaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  if (primarySent || secondarySent) {
    return true;
  }

  console.error(
    JSON.stringify({
      event: 'lead_alert_delivery_critical',
      timestamp: new Date().toISOString(),
      leadId: alert.leadId,
      severity: 'critical',
      primaryConfigured: Boolean(primaryWebhookUrl),
      secondaryConfigured: Boolean(secondaryWebhookUrl),
      retries: maxRetries,
    })
  );
  return false;
}

export async function notifyLeadRetryRateWarning(alert: RetryRateAlertPayload): Promise<boolean> {
  const primaryWebhookUrl = resolveAlertWebhookUrl();
  const secondaryWebhookUrl = resolveSecondaryAlertWebhookUrl();

  if (!primaryWebhookUrl && !secondaryWebhookUrl) {
    return false;
  }

  const token = resolveAlertToken();
  const timeoutMs = resolveAlertTimeoutMs();
  const maxRetries = resolveAlertMaxRetries();
  const retryBaseDelayMs = resolveAlertRetryBaseDelayMs();
  const body = buildRetryRateAlertBody(alert);

  let primarySent = false;
  let secondarySent = false;

  if (primaryWebhookUrl) {
    primarySent = await deliverAlertWithRetry(
      'primary',
      primaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  if (!primarySent && secondaryWebhookUrl) {
    secondarySent = await deliverAlertWithRetry(
      'secondary',
      secondaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  return primarySent || secondarySent;
}

export async function notifyBotProtectionDegraded(alert: BotProtectionDegradedAlertPayload): Promise<boolean> {
  const primaryWebhookUrl = resolveAlertWebhookUrl();
  const secondaryWebhookUrl = resolveSecondaryAlertWebhookUrl();

  if (!primaryWebhookUrl && !secondaryWebhookUrl) {
    return false;
  }

  const token = resolveAlertToken();
  const timeoutMs = resolveAlertTimeoutMs();
  const maxRetries = resolveAlertMaxRetries();
  const retryBaseDelayMs = resolveAlertRetryBaseDelayMs();
  const body = buildBotProtectionDegradedBody(alert);

  let primarySent = false;
  let secondarySent = false;

  if (primaryWebhookUrl) {
    primarySent = await deliverAlertWithRetry(
      'primary',
      primaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  if (!primarySent && secondaryWebhookUrl) {
    secondarySent = await deliverAlertWithRetry(
      'secondary',
      secondaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  return primarySent || secondarySent;
}

export async function notifyLeadStoreDegraded(alert: LeadStoreDegradedAlertPayload): Promise<boolean> {
  const primaryWebhookUrl = resolveAlertWebhookUrl();
  const secondaryWebhookUrl = resolveSecondaryAlertWebhookUrl();

  if (!primaryWebhookUrl && !secondaryWebhookUrl) {
    return false;
  }

  const token = resolveAlertToken();
  const timeoutMs = resolveAlertTimeoutMs();
  const maxRetries = resolveAlertMaxRetries();
  const retryBaseDelayMs = resolveAlertRetryBaseDelayMs();
  const body = buildLeadStoreDegradedBody(alert);

  let primarySent = false;
  let secondarySent = false;

  if (primaryWebhookUrl) {
    primarySent = await deliverAlertWithRetry(
      'primary',
      primaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  if (!primarySent && secondaryWebhookUrl) {
    secondarySent = await deliverAlertWithRetry(
      'secondary',
      secondaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  return primarySent || secondarySent;
}

export async function notifyConversionSnapshotAnomaly(alert: ConversionSnapshotAlertPayload): Promise<boolean> {
  const primaryWebhookUrl = resolveAlertWebhookUrl();
  const secondaryWebhookUrl = resolveSecondaryAlertWebhookUrl();

  if (!primaryWebhookUrl && !secondaryWebhookUrl) {
    return false;
  }

  const token = resolveAlertToken();
  const timeoutMs = resolveAlertTimeoutMs();
  const maxRetries = resolveAlertMaxRetries();
  const retryBaseDelayMs = resolveAlertRetryBaseDelayMs();
  const body = buildConversionSnapshotAlertBody(alert);

  let primarySent = false;
  let secondarySent = false;

  if (primaryWebhookUrl) {
    primarySent = await deliverAlertWithRetry(
      'primary',
      primaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  if (!primarySent && secondaryWebhookUrl) {
    secondarySent = await deliverAlertWithRetry(
      'secondary',
      secondaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  return primarySent || secondarySent;
}

export async function notifyConversionHealthTransition(
  alert: ConversionHealthTransitionAlertPayload
): Promise<boolean> {
  const primaryWebhookUrl = resolveAlertWebhookUrl();
  const secondaryWebhookUrl = resolveSecondaryAlertWebhookUrl();

  if (!primaryWebhookUrl && !secondaryWebhookUrl) {
    return false;
  }

  const token = resolveAlertToken();
  const timeoutMs = resolveAlertTimeoutMs();
  const maxRetries = resolveAlertMaxRetries();
  const retryBaseDelayMs = resolveAlertRetryBaseDelayMs();
  const body = buildConversionHealthTransitionAlertBody(alert);

  let primarySent = false;
  let secondarySent = false;

  if (primaryWebhookUrl) {
    primarySent = await deliverAlertWithRetry(
      'primary',
      primaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  if (!primarySent && secondaryWebhookUrl) {
    secondarySent = await deliverAlertWithRetry(
      'secondary',
      secondaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  return primarySent || secondarySent;
}

export async function notifyConversionHealthStoreFallback(
  alert: ConversionHealthStoreFallbackAlertPayload
): Promise<boolean> {
  const primaryWebhookUrl = resolveAlertWebhookUrl();
  const secondaryWebhookUrl = resolveSecondaryAlertWebhookUrl();

  if (!primaryWebhookUrl && !secondaryWebhookUrl) {
    return false;
  }

  const token = resolveAlertToken();
  const timeoutMs = resolveAlertTimeoutMs();
  const maxRetries = resolveAlertMaxRetries();
  const retryBaseDelayMs = resolveAlertRetryBaseDelayMs();
  const body = buildConversionHealthStoreFallbackAlertBody(alert);

  let primarySent = false;
  let secondarySent = false;

  if (primaryWebhookUrl) {
    primarySent = await deliverAlertWithRetry(
      'primary',
      primaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  if (!primarySent && secondaryWebhookUrl) {
    secondarySent = await deliverAlertWithRetry(
      'secondary',
      secondaryWebhookUrl,
      token,
      timeoutMs,
      maxRetries,
      retryBaseDelayMs,
      body
    );
  }

  return primarySent || secondarySent;
}
