import { processLeadQueue } from '~/server/leads/worker';
import { extractBearerToken, parseBooleanEnv, timingSafeCompare } from '~/server/utils/auth';

export const prerender = false;

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function resolveWorkerToken(): string {
  return (process.env.CONTACT_WORKER_TOKEN || '').trim();
}

function isDevBypassEnabled(): boolean {
  return parseBooleanEnv(process.env.ALLOW_DEV_BYPASS, false);
}

function resolveRequestedLimit(request: Request, body: Record<string, unknown>): number | undefined {
  const fromBody = body?.limit;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody)) {
    return fromBody;
  }

  if (typeof fromBody === 'string') {
    const parsed = Number(fromBody);
    if (Number.isFinite(parsed)) return parsed;
  }

  const limitParam = new URL(request.url).searchParams.get('limit');
  if (!limitParam) return undefined;
  const parsed = Number(limitParam);
  return Number.isFinite(parsed) ? parsed : undefined;
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
    const body = await readRequestBody(request);
    const limit = resolveRequestedLimit(request, body);
    const summary = await processLeadQueue(limit);

    return jsonResponse(200, {
      success: true,
      summary,
    });
  } catch (error) {
    console.error('[lead-worker] unhandled_error', error);
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
