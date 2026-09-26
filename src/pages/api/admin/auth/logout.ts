import type { APIRoute } from 'astro';

import { authorizeAdminRequest } from '~/server/admin/auth';
import {
  ADMIN_SESSION_COOKIE,
  readAdminSessionId,
  revokeAdminSession,
  serializeAdminCookie,
  serializeAdminCsrfCookie,
  shouldUseSecureAdminCookies,
} from '~/server/admin/session';

export const prerender = false;

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const auth = await authorizeAdminRequest(request, {
    scope: 'admin_logout_api',
    rateLimitScope: 'admin:session',
    clientAddress,
    requireSession: true,
    allowDevBypass: false,
    registerFailure: false,
  });
  if (!auth.ok) return auth.response;

  const sessionId = readAdminSessionId(request);
  await revokeAdminSession(sessionId);
  const headers = new Headers(HEADERS);
  headers.append(
    'Set-Cookie',
    serializeAdminCookie(ADMIN_SESSION_COOKIE, '', {
      maxAgeSec: 0,
      secure: shouldUseSecureAdminCookies(request),
      path: '/',
    })
  );
  headers.append(
    'Set-Cookie',
    serializeAdminCsrfCookie('', {
      maxAgeSec: 0,
      secure: shouldUseSecureAdminCookies(request),
    })
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
