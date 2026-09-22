import { defineMiddleware } from 'astro:middleware';

import { authorizeAdminRequest } from '~/server/admin/auth';
import { getTrailingSlashRedirect } from '~/lib/trailing-slash';

function isAdminPath(pathname: string) {
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/api/admin' ||
    pathname.startsWith('/api/admin/')
  );
}

function isPublicAdminAuthPath(pathname: string) {
  return pathname === '/admin/login' || pathname === '/admin/login/' || pathname.startsWith('/api/admin/auth/');
}

function isAdminHtmlPath(pathname: string) {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

function resolveAdminRateLimitScope(pathname: string) {
  if (pathname.startsWith('/api/admin/metrics')) return 'admin:metrics';
  if (pathname.startsWith('/api/admin/health')) return 'admin:health';
  return 'admin:shell';
}

function resolveAdminScope(pathname: string) {
  if (pathname.startsWith('/api/admin/metrics')) return 'admin_metrics_api';
  if (pathname.startsWith('/api/admin/health')) return 'admin_health_api';
  return 'admin_shell';
}

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = context.url.pathname;
  const isPrerendered = context.isPrerendered === true;

  if (!isPrerendered && isAdminPath(pathname) && !isPublicAdminAuthPath(pathname)) {
    const htmlRequest = isAdminHtmlPath(pathname);
    const auth = await authorizeAdminRequest(context.request, {
      scope: resolveAdminScope(pathname),
      rateLimitScope: resolveAdminRateLimitScope(pathname),
      allowDevBypass: false,
      requireSession: htmlRequest,
      registerFailure: !htmlRequest,
      clientAddress: context.clientAddress,
    });

    if (!auth.ok) {
      if (htmlRequest && auth.status === 401) {
        const nextPath = `${context.url.pathname}${context.url.search}`;
        return context.redirect(`/admin/login?next=${encodeURIComponent(nextPath)}`, 303);
      }
      return auth.response;
    }
  }

  const targetPath = getTrailingSlashRedirect(context.url.pathname);

  if (!targetPath) {
    return next();
  }

  const destination = `${targetPath}${context.url.search}`;
  const status = context.request.method === 'GET' || context.request.method === 'HEAD' ? 301 : 308;

  return context.redirect(destination, status);
});
