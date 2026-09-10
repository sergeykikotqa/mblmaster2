import { notifyConversionHealthStoreFallback, notifyConversionHealthTransition } from '~/server/leads/alerts';
import { evaluateConversionHealth } from '~/server/metrics/health-evaluator';
import { getHealthStateStoreRuntimeStats } from '~/server/metrics/state-store';
import { extractBearerToken, parseBooleanEnv, timingSafeCompare } from '~/server/utils/auth';

export const prerender = false;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const DEFAULT_HEALTH_STORE_FALLBACK_ALERT_COOLDOWN_SEC = 900;

let lastHealthStoreFallbackAlertAtMs = 0;
let lastHealthStoreFallbackAlertCount = 0;

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function resolveWorkerToken(): string {
  const dedicatedToken = (process.env.METRICS_HEALTH_WORKER_TOKEN || '').trim();
  if (dedicatedToken) return dedicatedToken;
  const metricsToken = (process.env.METRICS_WORKER_TOKEN || '').trim();
  if (metricsToken) return metricsToken;
  return (process.env.CONTACT_WORKER_TOKEN || '').trim();
}

function isDevBypassEnabled(): boolean {
  return parseBooleanEnv(process.env.ALLOW_DEV_BYPASS, false);
}

function parseDay(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  return undefined;
}

function parseBaselineDays(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.floor(parsed));
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveHealthStoreFallbackAlertCooldownMs(): number {
  const seconds = parsePositiveInt(
    process.env.METRICS_HEALTH_STORE_FALLBACK_ALERT_COOLDOWN_SEC,
    DEFAULT_HEALTH_STORE_FALLBACK_ALERT_COOLDOWN_SEC,
    60
  );
  return seconds * 1000;
}

async function readRequestBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== 'POST') return {};
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return {};

  try {
    const parsed = (await request.json()) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isAuthorized(request: Request): boolean {
  const expectedToken = resolveWorkerToken();
  if (!expectedToken) {
    return !import.meta.env.PROD && isDevBypassEnabled();
  }
  const bearerToken = extractBearerToken(request);
  return timingSafeCompare(expectedToken, bearerToken);
}

async function maybeNotifyHealthStoreFallbackAlert(params: {
  sendAlert: boolean;
  evaluation: Awaited<ReturnType<typeof evaluateConversionHealth>>;
  runtimeStats: ReturnType<typeof getHealthStateStoreRuntimeStats>;
}): Promise<boolean> {
  if (!params.sendAlert) return false;

  const fallbackCount = Math.max(0, Number(params.runtimeStats.redisFallbackToMemoryCount || 0));
  if (fallbackCount <= 0) return false;
  if (fallbackCount <= lastHealthStoreFallbackAlertCount) return false;

  const nowMs = Date.now();
  const cooldownMs = resolveHealthStoreFallbackAlertCooldownMs();
  if (nowMs - lastHealthStoreFallbackAlertAtMs < cooldownMs) {
    return false;
  }

  const sent = await notifyConversionHealthStoreFallback({
    targetDay: params.evaluation.targetDay,
    baselineDays: params.evaluation.baselineDays,
    generatedAtMs: params.evaluation.generatedAtMs,
    dataSource: params.evaluation.dataSource,
    metricsDegraded: params.evaluation.metricsDegraded,
    fallbackCount,
    fallbackLastAtMs: params.runtimeStats.redisFallbackToMemoryLastAtMs,
    summary: params.evaluation.summary,
  });

  if (sent) {
    lastHealthStoreFallbackAlertAtMs = nowMs;
    lastHealthStoreFallbackAlertCount = fallbackCount;
  }

  return sent;
}

async function handle(request: Request) {
  if (!isAuthorized(request)) {
    if (import.meta.env.PROD && !resolveWorkerToken()) {
      return jsonResponse(500, {
        success: false,
        code: 'WORKER_TOKEN_NOT_CONFIGURED',
      });
    }
    return jsonResponse(401, {
      success: false,
      code: 'UNAUTHORIZED',
    });
  }

  try {
    const query = new URL(request.url).searchParams;
    const body = await readRequestBody(request);
    const targetDay = parseDay(body.day) || parseDay(query.get('day'));
    const baselineDays =
      parseBaselineDays(body.baselineDays) || parseBaselineDays(query.get('baselineDays') || undefined);
    const includePageType =
      parseBooleanEnv(String(body.includePageType ?? ''), true) &&
      parseBooleanEnv(query.get('includePageType') === null ? 'true' : String(query.get('includePageType')), true);
    const sendAlert =
      parseBooleanEnv(String(body.sendAlert ?? ''), true) &&
      parseBooleanEnv(query.get('sendAlert') === null ? 'true' : String(query.get('sendAlert')), true);

    const evaluation = await evaluateConversionHealth({
      targetDay,
      baselineDays,
      includePageType,
    });
    const runtimeStats = getHealthStateStoreRuntimeStats();

    const transitions = evaluation.states
      .filter((item) => item.transition && item.transition.to !== 'HEALTHY')
      .map((item) => ({
        scope: item.scope,
        key: item.key,
        from: item.transition!.from,
        to: item.transition!.to,
        at: item.transition!.at,
        reason: item.transition!.reason,
        stableDays: item.transition!.stableDays,
        opened: item.opened,
        submitted: item.submitted,
        conversionRate: item.conversionRate,
        deltaPct: item.deltaPct,
      }));

    let alertSent = false;
    if (sendAlert && transitions.length > 0) {
      alertSent = await notifyConversionHealthTransition({
        targetDay: evaluation.targetDay,
        baselineDays: evaluation.baselineDays,
        generatedAtMs: evaluation.generatedAtMs,
        dataSource: evaluation.dataSource,
        metricsDegraded: evaluation.metricsDegraded,
        summary: evaluation.summary,
        transitions,
      });
    }
    const healthStoreFallbackAlertSent = await maybeNotifyHealthStoreFallbackAlert({
      sendAlert,
      evaluation,
      runtimeStats,
    });

    const problematic = evaluation.states
      .filter((item) => item.state !== 'HEALTHY')
      .sort((a, b) => b.opened - a.opened)
      .slice(0, 20)
      .map((item) => ({
        scope: item.scope,
        key: item.key,
        state: item.state,
        previousState: item.previousState,
        opened: item.opened,
        submitted: item.submitted,
        conversionRate: Number(item.conversionRate.toFixed(4)),
        baselineConversionRate: Number(item.baselineConversionRate.toFixed(4)),
        deltaPct: Number(item.deltaPct.toFixed(4)),
        blockedByHysteresis: item.blockedByHysteresis,
      }));

    return jsonResponse(200, {
      success: true,
      evaluation: {
        targetDay: evaluation.targetDay,
        baselineDays: evaluation.baselineDays,
        generatedAtMs: evaluation.generatedAtMs,
        dataSource: evaluation.dataSource,
        metricsDegraded: evaluation.metricsDegraded,
        runtime: runtimeStats,
        summary: evaluation.summary,
        problematic,
        transitionsTop: transitions.slice(0, 20),
      },
      alertSent,
      healthStoreFallbackAlertSent,
    });
  } catch (error) {
    console.error('[metrics-health-eval-worker] unhandled_error', error);
    return jsonResponse(500, {
      success: false,
      code: 'INTERNAL_ERROR',
    });
  }
}

export async function post({ request }: { request: Request }) {
  return handle(request);
}

export async function get({ request }: { request: Request }) {
  return handle(request);
}

export const POST = post;
export const GET = get;
