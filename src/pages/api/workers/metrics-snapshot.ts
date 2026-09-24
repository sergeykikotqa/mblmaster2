import {
  generateDailyConversionSnapshot,
  type DailySnapshotAnomaly,
  type DailySnapshotAnomalyReason,
} from '~/server/metrics/snapshot';
import { extractBearerToken, parseBooleanEnv, timingSafeCompare } from '~/server/utils/auth';

export const prerender = false;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const VOLUME_DIAGNOSTIC_REASONS = ['opened_spike', 'submitted_spike'] as const satisfies readonly DailySnapshotAnomalyReason[];
const SUPPRESSED_CONVERSION_REASONS = [
  'cr_drop',
  'zero_submitted',
  'opened_up_submitted_down',
] as const satisfies readonly DailySnapshotAnomalyReason[];

const volumeDiagnosticReasons = new Set<DailySnapshotAnomalyReason>(VOLUME_DIAGNOSTIC_REASONS);
const suppressedConversionReasons = new Set<DailySnapshotAnomalyReason>(SUPPRESSED_CONVERSION_REASONS);

function summarizeReasons<T extends DailySnapshotAnomalyReason>(
  anomalies: DailySnapshotAnomaly[],
  reasons: readonly T[]
): Record<T, number> {
  const summary = Object.fromEntries(reasons.map((reason) => [reason, 0])) as Record<T, number>;
  for (const anomaly of anomalies) {
    if (anomaly.reason in summary) summary[anomaly.reason as T] += 1;
  }
  return summary;
}

function toVolumeDiagnostic(anomaly: DailySnapshotAnomaly) {
  return {
    reason: anomaly.reason,
    classification: 'VOLUME_ONLY' as const,
    healthSignal: false as const,
    conversionSignal: false as const,
    opened: anomaly.opened,
    submitted: anomaly.submitted,
    baselineAvgOpened: anomaly.baselineAvgOpened,
    baselineAvgSubmitted: anomaly.baselineAvgSubmitted,
    message: 'Volume-only diagnostic; not a site-health or conversion signal.',
  };
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function resolveWorkerToken(): string {
  const dedicatedToken = (process.env.METRICS_WORKER_TOKEN || '').trim();
  if (dedicatedToken) return dedicatedToken;
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

    const snapshot = await generateDailyConversionSnapshot({
      targetDay,
      baselineDays,
    });
    const volumeDiagnostics = snapshot.anomalies
      .filter((anomaly) => volumeDiagnosticReasons.has(anomaly.reason))
      .slice(0, 10)
      .map(toVolumeDiagnostic);
    const suppressedConversionAnomalies = snapshot.anomalies.filter((anomaly) =>
      suppressedConversionReasons.has(anomaly.reason)
    );
    const rawTotals = snapshot.rows.reduce(
      (totals, row) => ({
        opened: totals.opened + row.opened,
        submitted: totals.submitted + row.submitted,
      }),
      { opened: 0, submitted: 0 }
    );

    return jsonResponse(200, {
      success: true,
      snapshot: {
        targetDay: snapshot.targetDay,
        baselineDays: snapshot.baselineDays,
        generatedAtMs: snapshot.generatedAtMs,
        dataSource: snapshot.dataSource,
        storageSource: snapshot.storageSource,
        metricsDegraded: snapshot.metricsDegraded,
        conversion: {
          available: false,
          reason: 'CONSENT_SCOPE_MISMATCH',
        },
        raw: {
          rows: snapshot.rows.length,
          opened: rawTotals.opened,
          submitted: rawTotals.submitted,
        },
        volumeDiagnostics,
        volumeDiagnosticsSummary: {
          total: snapshot.anomalies.filter((anomaly) => volumeDiagnosticReasons.has(anomaly.reason)).length,
          byReason: summarizeReasons(snapshot.anomalies, VOLUME_DIAGNOSTIC_REASONS),
        },
        suppressedConversionAnomalies: {
          total: suppressedConversionAnomalies.length,
          byReason: summarizeReasons(snapshot.anomalies, SUPPRESSED_CONVERSION_REASONS),
        },
      },
      alertSent: false,
      conversionAlertsSuppressed: true,
    });
  } catch (error) {
    console.error('[metrics-snapshot-worker] unhandled_error', error);
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
