import { describe, expect, test, vi } from 'vitest';

import { resolveWorkerTriggerConfig, runWorkerCycle, runWorkerLoop } from '../scripts/worker-trigger.mjs';

describe('local worker trigger', () => {
  test('requires a token and keeps credentials out of the URL', () => {
    expect(() => resolveWorkerTriggerConfig({})).toThrow('CONTACT_WORKER_TOKEN is required');
    expect(() =>
      resolveWorkerTriggerConfig({
        CONTACT_WORKER_TOKEN: 'secret',
        WORKER_TRIGGER_URL: 'http://user:password@mbl-web:4321/worker',
      })
    ).toThrow('must not contain credentials');
    expect(() =>
      resolveWorkerTriggerConfig({
        CONTACT_WORKER_TOKEN: 'secret',
        WORKER_TRIGGER_URL: 'http://mbl-web:4321/worker?token=secret',
      })
    ).toThrow('only through CONTACT_WORKER_TOKEN');
  });

  test('uses production-safe defaults and clamps invalid numeric values', () => {
    const config = resolveWorkerTriggerConfig({
      CONTACT_WORKER_TOKEN: 'worker-secret',
      WORKER_TRIGGER_INTERVAL_MS: '-1',
      WORKER_TRIGGER_TIMEOUT_MS: 'bad',
      WORKER_TRIGGER_BATCH_LIMIT: '0',
    });

    expect(config.workerUrl.toString()).toBe('http://mbl-web:4321/api/workers/lead-delivery');
    expect(config.intervalMs).toBe(250);
    expect(config.requestTimeoutMs).toBe(10_000);
    expect(config.batchLimit).toBe(1);
  });

  test('posts an authenticated bounded cycle and normalizes its summary', async () => {
    const fetchImpl = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer worker-secret',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init.body))).toEqual({ limit: 7 });
      return new Response(
        JSON.stringify({
          success: true,
          summary: { processed: 3, delivered: 2, retried: 1, failed: 0 },
        }),
        { status: 200 }
      );
    });
    const config = resolveWorkerTriggerConfig({
      CONTACT_WORKER_TOKEN: 'worker-secret',
      WORKER_TRIGGER_BATCH_LIMIT: '7',
    });

    await expect(runWorkerCycle(config, fetchImpl as typeof fetch)).resolves.toMatchObject({
      processed: 3,
      delivered: 2,
      retried: 1,
      failed: 0,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test('returns safe stable failure codes for HTTP and invalid JSON responses', async () => {
    const config = resolveWorkerTriggerConfig({ CONTACT_WORKER_TOKEN: 'worker-secret' });

    await expect(
      runWorkerCycle(config, vi.fn(async () => new Response('{"success":false}', { status: 503 })) as typeof fetch)
    ).rejects.toThrow('WORKER_HTTP_503');
    await expect(
      runWorkerCycle(config, vi.fn(async () => new Response('proxy error', { status: 502 })) as typeof fetch)
    ).rejects.toThrow('WORKER_INVALID_JSON_502');
  });

  test('does not overlap cycles and never logs the token or URL query', async () => {
    const abortController = new AbortController();
    let active = 0;
    let maximumActive = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      abortController.abort();
      return new Response(JSON.stringify({ success: true, summary: {} }), { status: 200 });
    });
    const messages: unknown[] = [];
    const logger = {
      info: (...args: unknown[]) => messages.push(args),
      error: (...args: unknown[]) => messages.push(args),
    };
    const config = resolveWorkerTriggerConfig({
      CONTACT_WORKER_TOKEN: 'never-log-this-token',
      WORKER_TRIGGER_URL: 'http://mbl-web:4321/api/workers/lead-delivery?limit=5&private=never-log-query',
      WORKER_TRIGGER_INTERVAL_MS: '250',
    });

    await runWorkerLoop(config, {
      signal: abortController.signal,
      fetchImpl: fetchImpl as typeof fetch,
      logger,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(1);
    const serializedLogs = JSON.stringify(messages);
    expect(serializedLogs).not.toContain('never-log-this-token');
    expect(serializedLogs).not.toContain('never-log-query');
  });
});
