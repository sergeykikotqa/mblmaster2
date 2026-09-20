import { authorizeAdminRequest } from '~/server/admin/auth';
import { buildMonitoringHealth } from '~/server/monitoring/health';

export const prerender = false;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

export async function get({ request, clientAddress }: { request: Request; clientAddress?: string }) {
  const auth = await authorizeAdminRequest(request, {
    scope: 'external_monitoring_health_api',
    clientAddress,
    rateLimitScope: 'monitoring:health',
    token: process.env.MBL_MONITORING_TOKEN,
    tokenConfigName: 'MBL_MONITORING_TOKEN',
    allowAllowlist: false,
    allowDevBypass: false,
    requireToken: true,
  });
  if (!auth.ok) return auth.response;

  try {
    const payload = await buildMonitoringHealth();
    return new Response(JSON.stringify(payload), {
      status: payload.ok ? 200 : 503,
      headers: JSON_HEADERS,
    });
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        service: 'mbl-production',
        incidents: ['MONITORING_CHECK_FAILED'],
      }),
      { status: 503, headers: JSON_HEADERS }
    );
  }
}

export const GET = get;
