import type { APIRoute } from 'astro';

import {
  ADMIN_OIDC_FLOW_COOKIE,
  ADMIN_SESSION_COOKIE,
  consumeAdminLoginFlow,
  createAdminSession,
  readAdminLoginFlowId,
  resolveAdminSessionTtlSec,
  serializeAdminCookie,
  serializeAdminCsrfCookie,
  shouldUseSecureAdminCookies,
} from '~/server/admin/session';
import {
  exchangeTelegramAuthorizationCode,
  loadTelegramOidcConfig,
  TelegramOidcError,
  verifyTelegramIdToken,
} from '~/server/admin/telegram-oidc';
import { timingSafeCompare } from '~/server/utils/auth';

export const prerender = false;

function responseWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function clearedFlowCookie(request: Request): string {
  return serializeAdminCookie(ADMIN_OIDC_FLOW_COOKIE, '', {
    maxAgeSec: 0,
    secure: shouldUseSecureAdminCookies(request),
    path: '/api/admin/auth/telegram',
  });
}

function loginFailure(request: Request, code: string): Response {
  return responseWithCookies(`/admin/login?error=${encodeURIComponent(code)}`, [clearedFlowCookie(request)]);
}

export const GET: APIRoute = async ({ request, url }) => {
  const flowId = readAdminLoginFlowId(request);
  if (!flowId) return loginFailure(request, 'invalid_flow');

  let flow;
  try {
    flow = await consumeAdminLoginFlow(flowId);
  } catch {
    return loginFailure(request, 'unavailable');
  }
  if (!flow) return loginFailure(request, 'invalid_flow');

  const state = (url.searchParams.get('state') || '').trim();
  const code = (url.searchParams.get('code') || '').trim();
  const providerError = (url.searchParams.get('error') || '').trim();
  if (providerError) return loginFailure(request, 'cancelled');
  if (!state || !timingSafeCompare(flow.state, state) || !code) return loginFailure(request, 'invalid_flow');

  try {
    const config = loadTelegramOidcConfig();
    if (config.redirectUri !== flow.redirectUri) throw new TelegramOidcError('TELEGRAM_REDIRECT_URI_INVALID');
    const idToken = await exchangeTelegramAuthorizationCode(config, code, flow.codeVerifier);
    const verified = await verifyTelegramIdToken(idToken, config, flow.nonce);
    const session = await createAdminSession(request, verified.ownerTelegramId);
    const sessionCookie = serializeAdminCookie(ADMIN_SESSION_COOKIE, session.sessionId, {
      maxAgeSec: resolveAdminSessionTtlSec(),
      secure: shouldUseSecureAdminCookies(request),
      path: '/',
    });
    const csrfCookie = serializeAdminCsrfCookie(session.csrfToken, {
      maxAgeSec: resolveAdminSessionTtlSec(),
      secure: shouldUseSecureAdminCookies(request),
    });
    return responseWithCookies(flow.nextPath, [sessionCookie, csrfCookie, clearedFlowCookie(request)]);
  } catch (error) {
    const code =
      error instanceof TelegramOidcError && error.code === 'TELEGRAM_OWNER_NOT_ALLOWED'
        ? 'owner_not_allowed'
        : 'verification_failed';
    return loginFailure(request, code);
  }
};
