import { handleAdminHealthStateRequest } from '~/server/metrics/admin-health';

export const prerender = false;

export async function get({ request, clientAddress }: { request: Request; clientAddress?: string }) {
  return handleAdminHealthStateRequest(request, 'admin_metrics_health_api', clientAddress);
}

export const GET = get;
