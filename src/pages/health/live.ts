import { createHealthResponse } from '~/server/health/runtime';

export const prerender = false;

export function GET(): Response {
  return createHealthResponse(200, {
    ok: true,
    status: 'live',
  });
}
