import { authorizeAdminRequest } from '~/server/admin/auth';
import { buildWorkerHealthCheck } from '~/server/admin/health-checks';

export const prerender = false;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export async function get({ request, clientAddress }: { request: Request; clientAddress?: string }) {
  const auth = await authorizeAdminRequest(request, {
    scope: 'admin_health_worker_api',
    clientAddress,
    rateLimitScope: 'admin:health',
  });
  if (!auth.ok) {
    return auth.response;
  }

  const result = await buildWorkerHealthCheck(auth.method);

  return new Response(JSON.stringify(result.payload), {
    status: result.status,
    headers: JSON_HEADERS,
  });
}

export const GET = get;
