import { checkTrackRateLimit, recordFunnelMetric, resolveFunnelDimensions } from '~/server/metrics/funnel';
import { parseBooleanEnv } from '~/server/utils/auth';
import { resolveClientIp as resolveClientIpFromRequest } from '~/server/utils/ip';

export const prerender = false;

type TrackBody = {
  event?: string;
  payload?: Record<string, unknown>;
  sentAt?: string;
  page?: string;
};

type RumMetric = {
  metricName: string;
  value: number | null;
  rating: string;
  metricId: string;
};

type RumLcpWindowSample = {
  timestampMs: number;
  valueMs: number;
  exceedsThreshold: boolean;
};

type RumLcpAlertState = {
  windowSamples: RumLcpWindowSample[];
  metricIdSeenAtMs: Map<string, number>;
  lastAlertAtMs: number;
};

type RumLcpAlertDecision = {
  shouldAlert: boolean;
  reason:
    | 'not_lcp'
    | 'invalid_metric'
    | 'below_threshold'
    | 'duplicate_metric'
    | 'below_min_samples'
    | 'below_violation_rate'
    | 'cooldown_active'
    | 'alert_ready';
  thresholdMs: number;
  sampleAccepted: boolean;
  duplicateMetric: boolean;
  windowSamples: number;
  windowViolations: number;
  windowViolationRate: number;
  windowP95Ms: number | null;
  minSamples: number;
  minViolationRate: number;
  windowMs: number;
  cooldownRemainingMs: number;
};

declare global {
  var __rumLcpAlertState: RumLcpAlertState | undefined;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const KNOWN_EVENTS = new Set([
  'page_view',
  'ttfi',
  'cta_click',
  'form_opened',
  'form_view',
  'form_focus',
  'form_first_input_focus',
  'form_start',
  'form_progress',
  'form_phone_valid',
  'form_validation_error',
  'form_submit_blocked',
  'form_submit_attempt',
  'form_submit_success',
  'form_abandoned',
  'lead_submit_start',
  'lead_submit_success',
  'lead_submit_error',
  'scroll_depth',
  'call_click',
  'web_vital',
]);
const DEFAULT_RUM_ALERT_TIMEOUT_MS = 3000;
const DEFAULT_RUM_LCP_ALERT_THRESHOLD_MS = 3000;
const DEFAULT_RUM_ALERT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_RUM_ALERT_MIN_SAMPLES = 30;
const DEFAULT_RUM_ALERT_MIN_VIOLATION_RATE = 0.25;
const DEFAULT_RUM_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_RUM_ALERT_METRIC_ID_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TRACK_RATE_LIMIT_RETRY_AFTER_SEC = 60;

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function parseQueryPayload(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sanitizeString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function sanitizeEventName(value: unknown): string {
  const event = sanitizeString(value, 80).toLowerCase();
  return /^[a-z0-9_:-]+$/.test(event) ? event : '';
}

function sanitizePage(value: unknown): string {
  const page = sanitizeString(value, 200);
  if (!page) return '';
  if (page.startsWith('/')) return page;
  try {
    const parsed = new URL(page);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '';
  }
}

function sanitizeReason(value: unknown): string {
  return sanitizeString(value, 64)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '');
}

function shouldTrustProxyHeaders(): boolean {
  const fallback = parseBooleanEnv(process.env.CONTACT_TRUST_PROXY_HEADERS, false);
  return parseBooleanEnv(process.env.TRACK_TRUST_PROXY_HEADERS, fallback);
}

function sanitizeTimestamp(value: unknown): string {
  const ts = sanitizeString(value, 100);
  if (!ts) return '';
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

async function readTrackBody(request: Request): Promise<TrackBody> {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/json')) {
    return (await request.json()) as TrackBody;
  }

  const raw = await request.text();
  if (!raw.trim()) return {};

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    return {
      event: params.get('event') || undefined,
      payload: parseQueryPayload(params.get('payload')),
      sentAt: params.get('sentAt') || undefined,
      page: params.get('page') || undefined,
    };
  }

  try {
    return JSON.parse(raw) as TrackBody;
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function sanitizePayloadMeta(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return { payloadKeys: [] as string[] };
  }

  const record = payload as Record<string, unknown>;
  return {
    payloadKeys: Object.keys(record).slice(0, 20),
    hasFormId: typeof record.form_id === 'string' && record.form_id.length > 0,
    hasPlacement: typeof record.placement === 'string' && record.placement.length > 0,
  };
}

function parsePayloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload as Record<string, unknown>;
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function parseFraction(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function resolveRumAlertWebhookUrl(): string {
  return (process.env.RUM_ALERT_WEBHOOK_URL || '').trim();
}

function resolveRumAlertWebhookToken(): string {
  return (process.env.RUM_ALERT_WEBHOOK_TOKEN || '').trim();
}

function resolveRumAlertTimeoutMs(): number {
  return parsePositiveInt(process.env.RUM_ALERT_TIMEOUT_MS, DEFAULT_RUM_ALERT_TIMEOUT_MS, 500);
}

function resolveRumLcpAlertThresholdMs(): number {
  return parsePositiveInt(process.env.RUM_LCP_ALERT_THRESHOLD_MS, DEFAULT_RUM_LCP_ALERT_THRESHOLD_MS, 500);
}

function resolveRumAlertWindowMs(): number {
  return parsePositiveInt(process.env.RUM_ALERT_WINDOW_MS, DEFAULT_RUM_ALERT_WINDOW_MS, 10_000);
}

function resolveRumAlertMinSamples(): number {
  return parsePositiveInt(process.env.RUM_ALERT_MIN_SAMPLES, DEFAULT_RUM_ALERT_MIN_SAMPLES, 1);
}

function resolveRumAlertMinViolationRate(): number {
  return parseFraction(process.env.RUM_ALERT_MIN_VIOLATION_RATE, DEFAULT_RUM_ALERT_MIN_VIOLATION_RATE);
}

function resolveRumAlertCooldownMs(): number {
  return parsePositiveInt(process.env.RUM_ALERT_COOLDOWN_MS, DEFAULT_RUM_ALERT_COOLDOWN_MS, 1_000);
}

function resolveRumAlertMetricIdTtlMs(): number {
  return parsePositiveInt(process.env.RUM_ALERT_METRIC_ID_TTL_MS, DEFAULT_RUM_ALERT_METRIC_ID_TTL_MS, 60_000);
}

function sanitizeRumMetric(payload: unknown): RumMetric | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const metricName = sanitizeString(record.metric_name ?? record.metricName, 20).toUpperCase();
  const rawValue = Number(record.value);
  const value = Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : null;
  const rating = sanitizeString(record.rating, 20).toLowerCase();
  const metricId = sanitizeString(record.metric_id ?? record.metricId, 120);

  if (!metricName) return null;
  return {
    metricName,
    value,
    rating,
    metricId,
  };
}

function getRumLcpAlertState(): RumLcpAlertState {
  if (!globalThis.__rumLcpAlertState) {
    globalThis.__rumLcpAlertState = {
      windowSamples: [],
      metricIdSeenAtMs: new Map<string, number>(),
      lastAlertAtMs: 0,
    };
  }

  return globalThis.__rumLcpAlertState;
}

function computePercentile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  const clamped = Math.min(sorted.length - 1, Math.max(0, index));
  return sorted[clamped];
}

function pruneRumLcpState(state: RumLcpAlertState, nowMs: number, windowMs: number, metricIdTtlMs: number): void {
  const minWindowTimestamp = nowMs - windowMs;
  state.windowSamples = state.windowSamples.filter((sample) => sample.timestampMs >= minWindowTimestamp);

  const minMetricTimestamp = nowMs - metricIdTtlMs;
  for (const [metricId, seenAtMs] of state.metricIdSeenAtMs.entries()) {
    if (seenAtMs < minMetricTimestamp) {
      state.metricIdSeenAtMs.delete(metricId);
    }
  }
}

function evaluateRumLcpAlert(rumMetric: RumMetric, thresholdMs: number): RumLcpAlertDecision {
  const windowMs = resolveRumAlertWindowMs();
  const minSamples = resolveRumAlertMinSamples();
  const minViolationRate = resolveRumAlertMinViolationRate();
  const cooldownMs = resolveRumAlertCooldownMs();
  const metricIdTtlMs = resolveRumAlertMetricIdTtlMs();

  const state = getRumLcpAlertState();
  const nowMs = Date.now();
  pruneRumLcpState(state, nowMs, windowMs, metricIdTtlMs);

  if (rumMetric.metricName !== 'LCP') {
    return {
      shouldAlert: false,
      reason: 'not_lcp',
      thresholdMs,
      sampleAccepted: false,
      duplicateMetric: false,
      windowSamples: state.windowSamples.length,
      windowViolations: state.windowSamples.filter((sample) => sample.exceedsThreshold).length,
      windowViolationRate: 0,
      windowP95Ms: computePercentile(
        state.windowSamples.map((sample) => sample.valueMs),
        95
      ),
      minSamples,
      minViolationRate,
      windowMs,
      cooldownRemainingMs: Math.max(0, state.lastAlertAtMs + cooldownMs - nowMs),
    };
  }

  if (typeof rumMetric.value !== 'number') {
    return {
      shouldAlert: false,
      reason: 'invalid_metric',
      thresholdMs,
      sampleAccepted: false,
      duplicateMetric: false,
      windowSamples: state.windowSamples.length,
      windowViolations: state.windowSamples.filter((sample) => sample.exceedsThreshold).length,
      windowViolationRate: 0,
      windowP95Ms: computePercentile(
        state.windowSamples.map((sample) => sample.valueMs),
        95
      ),
      minSamples,
      minViolationRate,
      windowMs,
      cooldownRemainingMs: Math.max(0, state.lastAlertAtMs + cooldownMs - nowMs),
    };
  }

  let duplicateMetric = false;
  if (rumMetric.metricId) {
    const seenAtMs = state.metricIdSeenAtMs.get(rumMetric.metricId);
    if (typeof seenAtMs === 'number' && nowMs - seenAtMs < metricIdTtlMs) {
      duplicateMetric = true;
    } else {
      state.metricIdSeenAtMs.set(rumMetric.metricId, nowMs);
    }
  }

  const exceedsThreshold = rumMetric.value >= thresholdMs;
  let sampleAccepted = false;
  if (!duplicateMetric) {
    state.windowSamples.push({
      timestampMs: nowMs,
      valueMs: rumMetric.value,
      exceedsThreshold,
    });
    sampleAccepted = true;
  }

  pruneRumLcpState(state, nowMs, windowMs, metricIdTtlMs);

  const windowSamples = state.windowSamples.length;
  const windowViolations = state.windowSamples.filter((sample) => sample.exceedsThreshold).length;
  const windowViolationRate = windowSamples > 0 ? windowViolations / windowSamples : 0;
  const windowP95Ms = computePercentile(
    state.windowSamples.map((sample) => sample.valueMs),
    95
  );
  const cooldownRemainingMs = Math.max(0, state.lastAlertAtMs + cooldownMs - nowMs);

  let reason: RumLcpAlertDecision['reason'] = 'alert_ready';
  let shouldAlert = true;

  if (!exceedsThreshold) {
    shouldAlert = false;
    reason = 'below_threshold';
  } else if (duplicateMetric) {
    shouldAlert = false;
    reason = 'duplicate_metric';
  } else if (windowSamples < minSamples) {
    shouldAlert = false;
    reason = 'below_min_samples';
  } else if (windowViolationRate < minViolationRate) {
    shouldAlert = false;
    reason = 'below_violation_rate';
  } else if (cooldownRemainingMs > 0) {
    shouldAlert = false;
    reason = 'cooldown_active';
  }

  if (shouldAlert) {
    state.lastAlertAtMs = nowMs;
  }

  return {
    shouldAlert,
    reason,
    thresholdMs,
    sampleAccepted,
    duplicateMetric,
    windowSamples,
    windowViolations,
    windowViolationRate,
    windowP95Ms,
    minSamples,
    minViolationRate,
    windowMs,
    cooldownRemainingMs,
  };
}

async function notifyRumLcpAlert(params: {
  page: string;
  sentAt: string;
  lcpMs: number;
  thresholdMs: number;
  metricId: string;
  rating: string;
  userAgent: string;
  aggregate: {
    windowMs: number;
    windowSamples: number;
    windowViolations: number;
    windowViolationRate: number;
    windowP95Ms: number | null;
    minSamples: number;
    minViolationRate: number;
  };
}): Promise<boolean> {
  const webhookUrl = resolveRumAlertWebhookUrl();
  if (!webhookUrl) return false;

  const token = resolveRumAlertWebhookToken();
  const timeoutMs = resolveRumAlertTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    event: 'rum_lcp_alert',
    timestamp: new Date().toISOString(),
    environment: import.meta.env.PROD ? 'production' : 'development',
    page: params.page,
    sentAt: params.sentAt,
    lcpMs: Math.round(params.lcpMs),
    thresholdMs: Math.round(params.thresholdMs),
    metricId: params.metricId,
    rating: params.rating,
    userAgent: params.userAgent.slice(0, 200),
    aggregate: {
      windowMs: params.aggregate.windowMs,
      windowSamples: params.aggregate.windowSamples,
      windowViolations: params.aggregate.windowViolations,
      windowViolationRate: Number(params.aggregate.windowViolationRate.toFixed(4)),
      windowP95Ms: params.aggregate.windowP95Ms === null ? null : Math.round(params.aggregate.windowP95Ms),
      minSamples: params.aggregate.minSamples,
      minViolationRate: Number(params.aggregate.minViolationRate.toFixed(4)),
    },
  };

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(webhookUrl, {
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

export async function post({ request, clientAddress }: { request: Request; clientAddress?: string }) {
  try {
    const body = await readTrackBody(request);
    const event = sanitizeEventName(body?.event);
    if (!event) {
      return jsonResponse(400, { success: false, code: 'EVENT_REQUIRED' });
    }

    const page = sanitizePage(body?.page);
    const receivedAtMs = Date.now();
    const receivedAt = new Date(receivedAtMs).toISOString();
    const clientSentAt = sanitizeTimestamp(body?.sentAt);
    const knownEvent = KNOWN_EVENTS.has(event);
    const userAgent = request.headers.get('user-agent') || '';
    const rumMetric = event === 'web_vital' ? sanitizeRumMetric(body?.payload) : null;
    let rumLcpAlertSent = false;
    let rumLcpAlertDecision: RumLcpAlertDecision | null = null;
    let funnelMetricRecorded = false;
    let funnelMetricSource: 'redis' | 'memory' | '' = '';
    let funnelMetricEvent = '';

    const clientIp = resolveClientIpFromRequest(request, shouldTrustProxyHeaders(), clientAddress);
    const rateLimit = await checkTrackRateLimit({
      ip: clientIp || 'unknown',
      pageSlug: page || '/',
    });

    if (!rateLimit.allowed) {
      const retryAfterSec = Math.max(
        1,
        Number.isFinite(rateLimit.retryAfterSec) && rateLimit.retryAfterSec > 0
          ? Math.floor(rateLimit.retryAfterSec)
          : DEFAULT_TRACK_RATE_LIMIT_RETRY_AFTER_SEC
      );
      return new Response(
        JSON.stringify({
          success: false,
          code: 'RATE_LIMITED',
          retryAfterSec,
        }),
        {
          status: 429,
          headers: {
            ...JSON_HEADERS,
            'Retry-After': String(retryAfterSec),
          },
        }
      );
    }

    if (rumMetric?.metricName === 'LCP' && typeof rumMetric.value === 'number') {
      const thresholdMs = resolveRumLcpAlertThresholdMs();
      rumLcpAlertDecision = evaluateRumLcpAlert(rumMetric, thresholdMs);
      if (rumLcpAlertDecision.shouldAlert) {
        rumLcpAlertSent = await notifyRumLcpAlert({
          page,
          sentAt: receivedAt,
          lcpMs: rumMetric.value,
          thresholdMs,
          metricId: rumMetric.metricId,
          rating: rumMetric.rating,
          userAgent,
          aggregate: {
            windowMs: rumLcpAlertDecision.windowMs,
            windowSamples: rumLcpAlertDecision.windowSamples,
            windowViolations: rumLcpAlertDecision.windowViolations,
            windowViolationRate: rumLcpAlertDecision.windowViolationRate,
            windowP95Ms: rumLcpAlertDecision.windowP95Ms,
            minSamples: rumLcpAlertDecision.minSamples,
            minViolationRate: rumLcpAlertDecision.minViolationRate,
          },
        });
      }
    }

    if (
      event === 'page_view' ||
      event === 'form_opened' ||
      event === 'form_view' ||
      event === 'form_focus' ||
      event === 'form_first_input_focus' ||
      event === 'form_start' ||
      event === 'form_progress' ||
      event === 'form_phone_valid' ||
      event === 'form_submit_attempt' ||
      event === 'form_submit_success' ||
      event === 'form_validation_error' ||
      event === 'form_submit_blocked' ||
      event === 'form_abandoned'
    ) {
      const payload = parsePayloadRecord(body?.payload);
      const dimensions = resolveFunnelDimensions({
        pageSlug: payload.page_slug ?? payload.pageSlug,
        city: payload.city,
        district: payload.district,
        service: payload.service,
        pageType: payload.lead_page_type ?? payload.pageType ?? payload.page_type,
        fallbackPage: page,
      });

      if (dimensions) {
        const metricResult = await recordFunnelMetric({
          eventName: event,
          pageSlug: dimensions.pageSlug,
          city: dimensions.city,
          district: dimensions.district,
          service: dimensions.service,
          pageType: dimensions.pageType,
          timestampMs: receivedAtMs,
          reason: sanitizeReason(payload.reason),
        });
        funnelMetricRecorded = true;
        funnelMetricSource = metricResult.dataSource;
        funnelMetricEvent = event;
      }
    }

    console.info('[track] event_received', {
      event,
      knownEvent,
      page,
      receivedAt,
      clientSentAt,
      userAgent,
      rumMetricName: rumMetric?.metricName || '',
      rumMetricValue: rumMetric?.value ?? null,
      rumMetricRating: rumMetric?.rating || '',
      rumLcpAlertSent,
      rumLcpAlertReason: rumLcpAlertDecision?.reason || '',
      rumLcpWindowSamples: rumLcpAlertDecision?.windowSamples ?? null,
      rumLcpWindowViolationRate: rumLcpAlertDecision
        ? Number(rumLcpAlertDecision.windowViolationRate.toFixed(4))
        : null,
      rumLcpCooldownRemainingMs: rumLcpAlertDecision?.cooldownRemainingMs ?? null,
      funnelMetricRecorded,
      funnelMetricSource,
      funnelMetricEvent,
      ...sanitizePayloadMeta(body?.payload),
    });

    return jsonResponse(200, {
      success: true,
      knownEvent,
      rumLcpAlertSent,
      rumLcpAlertReason: rumLcpAlertDecision?.reason || null,
      funnelMetricRecorded,
      funnelMetricSource: funnelMetricSource || null,
      funnelMetricEvent: funnelMetricEvent || null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_JSON') {
      return jsonResponse(400, { success: false, code: 'INVALID_JSON' });
    }

    console.error('[track] unhandled_error', error);
    return jsonResponse(500, { success: false, code: 'INTERNAL_ERROR' });
  }
}

export const POST = post;
