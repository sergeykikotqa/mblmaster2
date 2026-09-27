import { describe, expect, test, vi } from 'vitest';

import { checkContactRedirectContract } from '../scripts/check-metrics-smoke.mjs';

function jsonResponse(url: string, status: number, payload: unknown): Response {
  const response = new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('metrics smoke contact redirect contract', () => {
  test('preserves POST body and idempotency through the 307 alias', async () => {
    const leadId = 'lead-smoke-1';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { Location: 'http://127.0.0.1:4322/api/leads' },
        })
      )
      .mockResolvedValueOnce(jsonResponse('http://127.0.0.1:4322/api/leads', 200, { success: true, leadId }))
      .mockResolvedValueOnce(
        jsonResponse('http://127.0.0.1:4322/api/leads', 200, { success: true, duplicate: true, leadId })
      );

    const result = await checkContactRedirectContract({
      targetBaseUrl: 'http://127.0.0.1:4322',
      idempotencyKey: 'stable-key',
      fetchImpl: fetchMock,
    });

    expect(result).toMatchObject({ leadId, finalUrl: 'http://127.0.0.1:4322/api/leads' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: 'POST' });
      expect((init?.headers as Record<string, string>)['X-Idempotency-Key']).toBe('stable-key');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        name: 'Metrics Smoke',
        pageSlug: '/kuhni',
        consent: true,
      });
    }
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe('follow');
  });

  test('reports the final URL, status and safe API error without printing the request body', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { Location: 'http://127.0.0.1:4322/api/leads' },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse('http://127.0.0.1:4322/api/leads', 500, {
          success: false,
          code: 'BOT_PROTECTION_NOT_CONFIGURED',
          message: 'Protection is not configured',
        })
      );

    await expect(
      checkContactRedirectContract({
        targetBaseUrl: 'http://127.0.0.1:4322',
        idempotencyKey: 'failed-key',
        fetchImpl: fetchMock,
      })
    ).rejects.toThrow(
      'status=500, url=http://127.0.0.1:4322/api/leads, code=BOT_PROTECTION_NOT_CONFIGURED, message=Protection is not configured'
    );
  });
});
