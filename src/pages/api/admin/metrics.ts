import { handleAdminMetricsRollupRequest } from '~/server/metrics/admin-rollup';

export const prerender = false;

export async function get({ request, clientAddress }: { request: Request; clientAddress?: string }) {
  return handleAdminMetricsRollupRequest(request, 'admin_metrics_api', clientAddress);
}

export const GET = get;
