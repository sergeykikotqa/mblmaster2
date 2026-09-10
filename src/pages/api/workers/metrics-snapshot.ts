import { notifyConversionSnapshotAnomaly } from '~/server/leads/alerts';
import { generateDailyConversionSnapshot } from '~/server/metrics/snapshot';
import { extractBearerToken, parseBooleanEnv, timingSafeCompare } from '~/server/utils/auth';

export const prerender = false;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

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
    const sendAlert =
      parseBooleanEnv(String(body.sendAlert ?? ''), true) &&
      parseBooleanEnv(query.get('sendAlert') === null ? 'true' : String(query.get('sendAlert')), true);

    const snapshot = await generateDailyConversionSnapshot({
      targetDay,
      baselineDays,
    });

    let alertSent = false;
    if (sendAlert && snapshot.anomalies.length > 0) {
      alertSent = await notifyConversionSnapshotAnomaly({
        targetDay: snapshot.targetDay,
        baselineDays: snapshot.baselineDays,
        generatedAtMs: snapshot.generatedAtMs,
        dataSource: snapshot.dataSource,
        storageSource: snapshot.storageSource,
        metricsDegraded: snapshot.metricsDegraded,
        anomalies: snapshot.anomalies,
        summary: snapshot.summary,
      });
    }

    return jsonResponse(200, {
      success: true,
      snapshot: {
        targetDay: snapshot.targetDay,
        baselineDays: snapshot.baselineDays,
        generatedAtMs: snapshot.generatedAtMs,
        dataSource: snapshot.dataSource,
        storageSource: snapshot.storageSource,
        metricsDegraded: snapshot.metricsDegraded,
        summary: snapshot.summary,
        anomaliesTop: snapshot.anomalies.slice(0, 10),
      },
      alertSent,
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
