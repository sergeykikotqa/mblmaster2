import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { LeadStore } from '../src/server/leads/store';
import type { DeliveryAttemptMetric, LeadPipelineHealth, LeadRecord } from '../src/server/leads/types';

const getLeadStoreMock = vi.fn();
const deliverLeadWebhookMock = vi.fn();

vi.mock('../src/server/leads/store', () => ({
  getLeadStore: () => getLeadStoreMock(),
}));

vi.mock('../src/server/leads/webhook', () => ({
  deliverLeadWebhook: (...args: unknown[]) => deliverLeadWebhookMock(...args),
}));

vi.mock('../src/server/leads/alerts', () => ({
  notifyLeadDeadLetter: vi.fn(async () => false),
  notifyLeadRetryRateWarning: vi.fn(async () => false),
}));

vi.mock('../src/server/leads/metrics-fallback', () => ({
  recordFallbackDeliveryMetric: vi.fn(),
}));

import { processLeadQueue } from '../src/server/leads/worker';

function createLeadRecord(nowMs: number): LeadRecord {
  const nowIso = new Date(nowMs).toISOString();
  return {
    leadId: 'lead-1',
    receivedAt: nowIso,
    idempotencyHash: 'idempotency-1',
    payloadFingerprint: 'fingerprint-1',
    webhookPayload: {
      lead: {
        leadId: 'lead-1',
      },
    },
    status: 'pending',
    retryCount: 0,
    nextRetryAt: nowMs - 1000,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function createHealth(queueDepth: number): LeadPipelineHealth {
  return {
    retryRateLastHour: 0,
    dlqLastHour: 0,
    dlqLast24Hours: 0,
    p95LatencyMs: null,
    queueDepth,
    counters: {
      delivery_success_total: 0,
      delivery_retry_total: 0,
      delivery_failed_total: 0,
      delivery_dlq_total: 0,
    },
    generatedAtMs: Date.now(),
  };
}

function createStore(options: {
  record: { current: LeadRecord | null };
  queued: { current: boolean };
  metrics: DeliveryAttemptMetric[];
  commitResults: Array<{ status: 'committed' | 'fence_exists' | 'claim_missing'; deliveredAtIso: string | null }>;
}): LeadStore {
  let lockCounter = 0;

  return {
    mode: 'memory',
    hasDurableStorage: false,
    ping: async () => ({ ok: true, code: 'MEMORY', circuitOpen: false }),
    checkRateLimit: async () => ({ allowed: true, count: 1, retryAfterSec: 0 }),
    enqueueLeadWithIdempotency: async () => ({ duplicate: false }),
    getLeadRecord: async () => options.record.current,
    saveLeadRecord: async (leadRecord) => {
      options.record.current = leadRecord;
    },
    listDueLeadIds: async () => (options.queued.current ? ['lead-1'] : []),
    acquireProcessingLock: async () => {
      if (!options.queued.current) return null;
      lockCounter += 1;
      return `lock-${lockCounter}`;
    },
    renewProcessingLock: async () => true,
    releaseProcessingLock: async () => {},
    acquireDeliveryClaim: async () => true,
    releaseDeliveryClaim: async () => {},
    markDeliveryFence: async () => {},
    getDeliveryFence: async () => null,
    commitDeliveredIfClaimOwned: async (params) => {
      const next = options.commitResults.shift();
      const result = next || { status: 'committed', deliveredAtIso: new Date().toISOString() };
      if (result.status === 'committed') {
        options.record.current = params.deliveredRecord;
        options.queued.current = false;
      }
      return result;
    },
    scheduleLead: async () => {
      options.queued.current = true;
    },
    removeFromSchedule: async () => {
      options.queued.current = false;
    },
    getQueueDepth: async () => (options.queued.current ? 1 : 0),
    pushDeadLetter: async () => {},
    recordDeliveryMetric: async (metric) => {
      options.metrics.push(metric);
    },
    getLeadPipelineHealth: async () => createHealth(options.queued.current ? 1 : 0),
  };
}

test('worker recovers delivered status from commit fence and avoids duplicate webhook send', async () => {
  const nowMs = Date.now();
  const record = { current: createLeadRecord(nowMs) };
  const queued = { current: true };
  const metrics: DeliveryAttemptMetric[] = [];

  getLeadStoreMock.mockReturnValue(
    createStore({
      record,
      queued,
      metrics,
      commitResults: [{ status: 'fence_exists', deliveredAtIso: new Date(nowMs).toISOString() }],
    })
  );
  deliverLeadWebhookMock.mockResolvedValue({ ok: true, status: 200 });

  const result = await processLeadQueue(1);

  expect(result.processed).toBe(1);
  expect(result.delivered).toBe(1);
  expect(result.skipped).toBe(0);
  expect(deliverLeadWebhookMock).toHaveBeenCalledTimes(1);
  expect(record.current?.status).toBe('delivered');
  expect(queued.current).toBe(false);
  expect(metrics.filter((metric) => metric.status === 'success')).toHaveLength(1);
});

test('worker skips success commit when claim is missing after webhook send', async () => {
  const nowMs = Date.now();
  const record = { current: createLeadRecord(nowMs) };
  const queued = { current: true };
  const metrics: DeliveryAttemptMetric[] = [];

  getLeadStoreMock.mockReturnValue(
    createStore({
      record,
      queued,
      metrics,
      commitResults: [{ status: 'claim_missing', deliveredAtIso: null }],
    })
  );
  deliverLeadWebhookMock.mockResolvedValue({ ok: true, status: 200 });

  const result = await processLeadQueue(1);

  expect(result.processed).toBe(1);
  expect(result.delivered).toBe(0);
  expect(result.skipped).toBe(1);
  expect(deliverLeadWebhookMock).toHaveBeenCalledTimes(1);
  expect(record.current?.status).toBe('pending');
  expect(queued.current).toBe(true);
  expect(metrics.filter((metric) => metric.status === 'success')).toHaveLength(0);
});

test('worker re-sends the same lead id after a post-send claim loss', async () => {
  const nowMs = Date.now();
  const record = { current: createLeadRecord(nowMs) };
  const queued = { current: true };
  const metrics: DeliveryAttemptMetric[] = [];

  getLeadStoreMock.mockReturnValue(
    createStore({
      record,
      queued,
      metrics,
      commitResults: [
        { status: 'claim_missing', deliveredAtIso: null },
        { status: 'committed', deliveredAtIso: new Date(nowMs + 1000).toISOString() },
      ],
    })
  );
  deliverLeadWebhookMock.mockResolvedValue({ ok: true, status: 200 });

  const firstRun = await processLeadQueue(1);
  const secondRun = await processLeadQueue(1);

  expect(firstRun.skipped).toBe(1);
  expect(secondRun.delivered).toBe(1);
  expect(deliverLeadWebhookMock).toHaveBeenCalledTimes(2);

  const firstPayload = deliverLeadWebhookMock.mock.calls[0]?.[0];
  const secondPayload = deliverLeadWebhookMock.mock.calls[1]?.[0];
  expect(firstPayload?.lead?.leadId).toBe('lead-1');
  expect(secondPayload?.lead?.leadId).toBe('lead-1');
  expect(record.current?.status).toBe('delivered');
  expect(queued.current).toBe(false);
});

test('worker returns paused summary without touching the store when CONTACT_WORKER_PAUSED=true', async () => {
  process.env.CONTACT_WORKER_PAUSED = 'true';

  const result = await processLeadQueue(1);

  expect(result).toEqual({
    processed: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
    paused: true,
  });
  expect(getLeadStoreMock).not.toHaveBeenCalled();
  expect(deliverLeadWebhookMock).not.toHaveBeenCalled();
});

beforeEach(() => {
  getLeadStoreMock.mockReset();
  deliverLeadWebhookMock.mockReset();
  delete process.env.CONTACT_WORKER_PAUSED;
});

afterEach(() => {
  delete process.env.CONTACT_WORKER_PAUSED;
});
