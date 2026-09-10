import { authorizeAdminRequest } from '~/server/admin/auth';
import { buildPipelineHealthCheck } from '~/server/admin/health-checks';

export const prerender = false;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export async function get({ request, clientAddress }: { request: Request; clientAddress?: string }) {
  const auth = await authorizeAdminRequest(request, {
    scope: 'admin_health_pipeline_api',
    clientAddress,
    rateLimitScope: 'admin:health',
  });
  if (!auth.ok) {
    return auth.response;
  }

  const query = new URL(request.url).searchParams;
  const strictMode = ['1', 'true'].includes((query.get('strict') || '').toLowerCase());
  const result = await buildPipelineHealthCheck(auth.method, { strictMode });

  return new Response(JSON.stringify(result.payload), {
    status: result.status,
    headers: JSON_HEADERS,
  });
}

export const GET = get;
