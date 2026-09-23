import type { APIRoute } from 'astro';

import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  resolveAdminSessionTtlSec,
  serializeAdminCookie,
  serializeAdminCsrfCookie,
  shouldUseSecureAdminCookies,
} from '~/server/admin/session';
import { loadTelegramOidcConfig, sanitizeAdminNextPath } from '~/server/admin/telegram-oidc';
import { isProd, parseBooleanEnv } from '~/server/utils/auth';

export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  const enabled =
    import.meta.env.DEV &&
    !isProd('ADMIN_AUTH_FORCE_PROD_MODE') &&
    parseBooleanEnv(process.env.TELEGRAM_LOGIN_MOCK_MODE, false);
  if (!enabled) return new Response(null, { status: 404 });

  try {
    const config = loadTelegramOidcConfig();
    const ownerId = String(process.env.TELEGRAM_LOGIN_MOCK_USER_ID || '').trim();
    if (!config.allowedOwnerIds.has(ownerId)) return new Response(null, { status: 403 });
    const session = await createAdminSession(request, ownerId);
    const headers = new Headers({
      Location: sanitizeAdminNextPath(url.searchParams.get('next')),
      'Cache-Control': 'no-store',
    });
    headers.append(
      'Set-Cookie',
      serializeAdminCookie(ADMIN_SESSION_COOKIE, session.sessionId, {
        maxAgeSec: resolveAdminSessionTtlSec(),
        secure: shouldUseSecureAdminCookies(request),
        path: '/',
      })
    );
    headers.append(
      'Set-Cookie',
      serializeAdminCsrfCookie(session.csrfToken, {
        maxAgeSec: resolveAdminSessionTtlSec(),
        secure: shouldUseSecureAdminCookies(request),
      })
    );
    return new Response(null, { status: 303, headers });
  } catch {
    return new Response(null, { status: 503 });
  }
};
