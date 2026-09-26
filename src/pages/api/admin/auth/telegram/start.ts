import type { APIRoute } from 'astro';

import { createAdminLoginFlow, ADMIN_OIDC_FLOW_COOKIE, serializeAdminCookie, shouldUseSecureAdminCookies } from '~/server/admin/session';
import {
  buildTelegramAuthorizationUrl,
  loadTelegramOidcConfig,
  sanitizeAdminNextPath,
  TelegramOidcError,
} from '~/server/admin/telegram-oidc';

export const prerender = false;

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return new Response(null, { status: 303, headers });
}

export const GET: APIRoute = async ({ request, url }) => {
  try {
    const config = loadTelegramOidcConfig();
    const nextPath = sanitizeAdminNextPath(url.searchParams.get('next'));
    const { flowId, record } = await createAdminLoginFlow(config.redirectUri, nextPath);
    const authorizationUrl = buildTelegramAuthorizationUrl(config, record);
    return redirect(
      authorizationUrl.toString(),
      serializeAdminCookie(ADMIN_OIDC_FLOW_COOKIE, flowId, {
        maxAgeSec: Math.max(1, Math.floor((record.expiresAtMs - Date.now()) / 1000)),
        secure: shouldUseSecureAdminCookies(request),
        path: '/api/admin/auth/telegram',
      })
    );
  } catch (error) {
    const code = error instanceof TelegramOidcError ? error.code : 'TELEGRAM_LOGIN_UNAVAILABLE';
    const publicCode = code === 'TELEGRAM_OWNER_ALLOWLIST_EMPTY' ? 'not_configured' : 'unavailable';
    return redirect(`/admin/login?error=${publicCode}`);
  }
};
