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
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const isPrerendered = context.isPrerendered === true;

  if (isProd && !isPrerendered && isAdminPath(pathname)) {
    const auth = await authorizeAdminRequest(context.request, {
      scope: resolveAdminScope(pathname),
      rateLimitScope: resolveAdminRateLimitScope(pathname),
      allowDevBypass: false,
    });

    if (!auth.ok) {
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
