import { createHash, timingSafeEqual } from 'node:crypto';

export type RequireAdminTokenResult =
  | {
      ok: true;
      token: string;
    }
  | {
      ok: false;
      code: 'ADMIN_AUTH_NOT_CONFIGURED';
    };

export function extractBearerToken(request: Request): string {
  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export function timingSafeCompare(secret: string, candidate: string): boolean {
  if (!secret || !candidate) return false;
  const left = createHash('sha256').update(secret).digest();
  const right = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(left, right);
}

export function parseBooleanEnv(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function isProd(forceProdModeEnvKey?: string): boolean {
  if (import.meta.env.PROD) return true;
  if (!forceProdModeEnvKey) return false;
  return parseBooleanEnv(process.env[forceProdModeEnvKey], false);
}

export function requireAdminToken(): RequireAdminTokenResult {
  const token = (process.env.METRICS_ADMIN_TOKEN || '').trim();
  if (!token) {
    return {
      ok: false,
      code: 'ADMIN_AUTH_NOT_CONFIGURED',
    };
  }

  return {
    ok: true,
    token,
  };
}
