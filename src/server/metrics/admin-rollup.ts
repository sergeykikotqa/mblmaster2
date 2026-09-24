import { authorizeAdminRequest } from '~/server/admin/auth';
import { getFunnelRollup } from '~/server/metrics/funnel';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

function parseSpan(value: string | null): 'hour' | 'day' {
  return value === 'hour' ? 'hour' : 'day';
}

function parseLimit(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

export async function handleAdminMetricsRollupRequest(
  request: Request,
  scope: string,
  clientAddress?: string
): Promise<Response> {
  const auth = await authorizeAdminRequest(request, {
    scope,
    clientAddress,
    rateLimitScope: 'admin:metrics',
  });

  if (!auth.ok) {
    return auth.response;
  }

  try {
    const url = new URL(request.url);
    const span = parseSpan(url.searchParams.get('span'));
    const limit = parseLimit(url.searchParams.get('limit'));
    const bucket = (url.searchParams.get('bucket') || '').trim();
    const city = (url.searchParams.get('city') || '').trim();
    const service = (url.searchParams.get('service') || '').trim();
    const pageSlug = (url.searchParams.get('pageSlug') || '').trim();

    const rollup = await getFunnelRollup({
      span,
      limit,
      bucket: bucket || undefined,
      city: city || undefined,
      service: service || undefined,
      pageSlug: pageSlug || undefined,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        authMethod: auth.method,
        report: {
          pageViews: rollup.totalPageViews,
          opened: rollup.totalOpened,
          submitted: rollup.totalSubmitted,
          openedRate: null,
          submitRate: null,
          conversionRate: null,
        },
        ...rollup,
      }),
      {
        status: 200,
        headers: JSON_HEADERS,
      }
    );
  } catch (error) {
    console.error('[admin-metrics-rollup] unhandled_error', {
      scope,
      error: error instanceof Error ? error.message : 'UNKNOWN',
    });
    return new Response(
      JSON.stringify({
        ok: false,
        code: 'INTERNAL_ERROR',
      }),
      {
        status: 500,
        headers: JSON_HEADERS,
      }
    );
  }
}
