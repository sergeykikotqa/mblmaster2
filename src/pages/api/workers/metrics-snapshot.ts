import { generateDailyMetricsSnapshotV2, isValidMetricsSnapshotDay } from '~/server/metrics/snapshot';
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
    if (Object.hasOwn(body, 'baselineDays') || query.has('baselineDays')) {
      return jsonResponse(400, {
        success: false,
        code: 'BASELINE_DAYS_NOT_SUPPORTED',
      });
    }

    const bodyHasDay = Object.hasOwn(body, 'day');
    const queryHasDay = query.has('day');
    const rawDay = bodyHasDay ? body.day : queryHasDay ? query.get('day') : undefined;
    let targetDay: string | undefined;
    if (rawDay !== undefined) {
      const normalizedDay = typeof rawDay === 'string' ? rawDay.trim() : '';
      if (!isValidMetricsSnapshotDay(normalizedDay)) {
        return jsonResponse(400, {
          success: false,
          code: 'INVALID_DAY',
        });
      }
      targetDay = normalizedDay;
    }

    const generated = await generateDailyMetricsSnapshotV2({
      targetDay,
    });
    const { snapshot } = generated;

    return jsonResponse(200, {
      success: true,
      snapshot: {
        schemaVersion: snapshot.schemaVersion,
        targetDay: snapshot.targetDay,
        generatedAtMs: snapshot.generatedAtMs,
        dataSource: snapshot.dataSource,
        storageSource: generated.storageSource,
        metricsDegraded: snapshot.metricsDegraded,
        raw: {
          opened: snapshot.counters.opened,
          submitted: snapshot.counters.submitted,
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
