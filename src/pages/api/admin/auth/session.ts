import type { APIRoute } from 'astro';

import { authorizeAdminRequest } from '~/server/admin/auth';
import { validateAdminSession } from '~/server/admin/session';

export const prerender = false;

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const GET: APIRoute = async ({ request, clientAddress }) => {
  const auth = await authorizeAdminRequest(request, {
    scope: 'admin_session_api',
    rateLimitScope: 'admin:session',
    clientAddress,
    requireSession: true,
    allowDevBypass: false,
    registerFailure: false,
  });
  if (!auth.ok) return auth.response;
  const session = await validateAdminSession(request);
  if (!session.ok) {
    return new Response(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }), { status: 401, headers: HEADERS });
  }
  return new Response(
    JSON.stringify({
      ok: true,
      authMethod: 'session',
      expiresAt: new Date(session.record.expiresAtMs).toISOString(),
    }),
    { status: 200, headers: HEADERS }
  );
};
