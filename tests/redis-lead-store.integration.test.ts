import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { LeadStore } from '../src/server/leads/store';
import type { ContactSuccessResponse, LeadRecord } from '../src/server/leads/types';

const deliverLeadWebhookMock = vi.hoisted(() => vi.fn());

vi.mock('../src/server/leads/webhook', () => ({
  deliverLeadWebhook: (...args: unknown[]) => deliverLeadWebhookMock(...args),
}));

vi.mock('../src/server/leads/alerts', () => ({
  notifyLeadDeadLetter: vi.fn(async () => false),
  notifyLeadRetryRateWarning: vi.fn(async () => false),
}));

const runAgainstRedis = process.env.REDIS_INTEGRATION === '1' && Boolean(process.env.REDIS_URL);
const redisDescribe = runAgainstRedis ? describe : describe.skip;
const prefix = `mbl-o22-test-${randomUUID().replaceAll('-', '')}`;

function createLead(leadId: string, dueAtMs = Date.now() - 1000): LeadRecord {
  const nowIso = new Date(dueAtMs).toISOString();
  return {
    leadId,
    receivedAt: nowIso,
    idempotencyHash: `idem-${leadId}`,
    payloadFingerprint: `fingerprint-${leadId}`,
    webhookPayload: { lead: { leadId } },
    status: 'pending',
    retryCount: 0,
    nextRetryAt: dueAtMs,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function successResponse(leadId: string): ContactSuccessResponse {
  return { success: true, leadId, receivedAt: new Date().toISOString() };
}

redisDescribe('native Redis lead pipeline integration', () => {
  let store: LeadStore;
  let redisCommand: <T>(...args: Array<string | number>) => Promise<T>;
  let closeRedisClient: () => Promise<void>;
  let processLeadQueue: typeof import('../src/server/leads/worker').processLeadQueue;
  let recordWorkerCycleHeartbeat: typeof import('../src/server/leads/runtime-health').recordWorkerCycleHeartbeat;
  let getWorkerRuntimeHealth: typeof import('../src/server/leads/runtime-health').getWorkerRuntimeHealth;
  let recordFunnelMetric: typeof import('../src/server/metrics/funnel').recordFunnelMetric;
  let getFunnelRollupFull: typeof import('../src/server/metrics/funnel').getFunnelRollupFull;
  let authorizeAdminRequest: typeof import('../src/server/admin/auth').authorizeAdminRequest;
  let upsertHealthState: typeof import('../src/server/metrics/state-store').upsertHealthState;
  let getHealthState: typeof import('../src/server/metrics/state-store').getHealthState;
  let appendHealthTransition: typeof import('../src/server/metrics/state-store').appendHealthTransition;
  let getHealthTransitionHistory: typeof import('../src/server/metrics/state-store').getHealthTransitionHistory;
  let generateDailyConversionSnapshot: typeof import('../src/server/metrics/snapshot').generateDailyConversionSnapshot;
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const key of [
      'CONTACT_REDIS_PREFIX',
      'CONTACT_WORKER_PAUSED',
      'CONTACT_ALERT_WEBHOOK_URL',
      'CONTACT_ALERT_WEBHOOK_URL_SECONDARY',
      'CONTACT_DELIVERY_MAX_RETRIES',
      'CONTACT_RETRY_BASE_DELAY_SEC',
      'CONTACT_WORKER_HEARTBEAT_STALE_SEC',
      'CONTACT_QUEUE_OLDEST_NORMAL_SEC',
      'CONTACT_QUEUE_OLDEST_WARNING_SEC',
      'CONTACT_QUEUE_OLDEST_CRITICAL_SEC',
      'METRICS_ADMIN_TOKEN',
      'ADMIN_AUTH_FORCE_PROD_MODE',
      'ADMIN_AUTH_FAIL_MAX_ATTEMPTS',
      'ADMIN_AUTH_FAIL_BLOCK_SEC',
    ]) {
      originalEnv.set(key, process.env[key]);
    }
    process.env.CONTACT_REDIS_PREFIX = prefix;
    process.env.CONTACT_WORKER_PAUSED = 'false';
    process.env.CONTACT_ALERT_WEBHOOK_URL = '';
    process.env.CONTACT_ALERT_WEBHOOK_URL_SECONDARY = '';
    process.env.CONTACT_DELIVERY_MAX_RETRIES = '2';
    process.env.CONTACT_RETRY_BASE_DELAY_SEC = '1';
    process.env.CONTACT_WORKER_HEARTBEAT_STALE_SEC = '60';
    process.env.CONTACT_QUEUE_OLDEST_NORMAL_SEC = '60';
    process.env.CONTACT_QUEUE_OLDEST_WARNING_SEC = '120';
    process.env.CONTACT_QUEUE_OLDEST_CRITICAL_SEC = '600';
    process.env.METRICS_ADMIN_TOKEN = 'redis-integration-admin-token';
    process.env.ADMIN_AUTH_FORCE_PROD_MODE = 'true';
    process.env.ADMIN_AUTH_FAIL_MAX_ATTEMPTS = '2';
    process.env.ADMIN_AUTH_FAIL_BLOCK_SEC = '10';

    const redisModule = await import('../src/server/redis/client');
    redisCommand = redisModule.redisCommand;
    closeRedisClient = redisModule.closeRedisClient;
    store = (await import('../src/server/leads/store')).getLeadStore();
    processLeadQueue = (await import('../src/server/leads/worker')).processLeadQueue;
    const runtimeHealth = await import('../src/server/leads/runtime-health');
    recordWorkerCycleHeartbeat = runtimeHealth.recordWorkerCycleHeartbeat;
    getWorkerRuntimeHealth = runtimeHealth.getWorkerRuntimeHealth;
    const funnel = await import('../src/server/metrics/funnel');
    recordFunnelMetric = funnel.recordFunnelMetric;
    getFunnelRollupFull = funnel.getFunnelRollupFull;
    authorizeAdminRequest = (await import('../src/server/admin/auth')).authorizeAdminRequest;
    const healthState = await import('../src/server/metrics/state-store');
    upsertHealthState = healthState.upsertHealthState;
    getHealthState = healthState.getHealthState;
    appendHealthTransition = healthState.appendHealthTransition;
    getHealthTransitionHistory = healthState.getHealthTransitionHistory;
    generateDailyConversionSnapshot = (await import('../src/server/metrics/snapshot')).generateDailyConversionSnapshot;
    expect((await store.ping()).ok).toBe(true);
    expect(store.mode).toBe('redis');
    expect(store.hasDurableStorage).toBe(true);
  }, 15_000);

  afterAll(async () => {
    try {
      if (redisCommand) {
        let cursor = '0';
        do {
          const result = await redisCommand<[string, string[]]>('SCAN', cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
          cursor = String(result[0]);
          if (result[1].length > 0) await redisCommand('DEL', ...result[1]);
        } while (cursor !== '0');
      }
    } finally {
      await closeRedisClient?.();
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 15_000);

  test('PING, atomic rate limit, concurrent idempotency, queue and TTL', async () => {
    const rateKey = `ip-${randomUUID()}`;
    const limits = await Promise.all([
      store.checkRateLimit(rateKey, 2, 30),
      store.checkRateLimit(rateKey, 2, 30),
      store.checkRateLimit(rateKey, 2, 30),
    ]);
    expect(limits.map((result) => result.count).sort()).toEqual([1, 2, 3]);
    expect(limits.filter((result) => result.allowed)).toHaveLength(2);

    const leadId = randomUUID();
    const leadRecord = createLead(leadId);
    const response = successResponse(leadId);
    const params = {
      idempotencyHash: leadRecord.idempotencyHash,
      idempotencyTtlSec: 3,
      successResponse: response,
      leadRecord,
      leadRecordTtlSec: 3,
    };
    const results = await Promise.all([
      store.enqueueLeadWithIdempotency(params),
      store.enqueueLeadWithIdempotency(params),
    ]);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results.find((result) => result.duplicate)).toMatchObject({
      response: { leadId, duplicate: true },
    });

    const conflictingLeadId = randomUUID();
    const conflictingLead = {
      ...createLead(conflictingLeadId),
      idempotencyHash: leadRecord.idempotencyHash,
      payloadFingerprint: 'different-payload-fingerprint',
    };
    expect(
      await store.enqueueLeadWithIdempotency({
        ...params,
        successResponse: successResponse(conflictingLeadId),
        leadRecord: conflictingLead,
      })
    ).toEqual({ duplicate: false, conflict: true });
    expect(await store.getLeadRecord(conflictingLeadId)).toBeNull();

    expect((await store.getLeadRecord(leadId))?.leadId).toBe(leadId);
    expect(await store.listDueLeadIds(Date.now(), 10)).toContain(leadId);
    expect(await redisCommand<number>('PTTL', `${prefix}:record:${leadId}`)).toBeGreaterThan(0);
    expect(await redisCommand<number>('PTTL', `${prefix}:idempotency:${leadRecord.idempotencyHash}`)).toBeGreaterThan(
      0
    );

    await store.removeFromSchedule(leadId);
    await vi.waitFor(async () => expect(await store.getLeadRecord(leadId)).toBeNull(), {
      timeout: 5000,
      interval: 100,
    });
    expect(await redisCommand<string | null>('GET', `${prefix}:idempotency:${leadRecord.idempotencyHash}`)).toBeNull();
  }, 10_000);

  test('processing locks, delivery claims and fenced commit are atomic', async () => {
    const leadId = randomUUID();
    const pending = createLead(leadId);
    await store.enqueueLeadWithIdempotency({
      idempotencyHash: pending.idempotencyHash,
      idempotencyTtlSec: 30,
      successResponse: successResponse(leadId),
      leadRecord: pending,
      leadRecordTtlSec: 30,
    });

    const lockResults = await Promise.all(Array.from({ length: 8 }, () => store.acquireProcessingLock(leadId, 10)));
    const ownerToken = lockResults.find((token) => token !== null);
    expect(lockResults.filter((token) => token !== null)).toHaveLength(1);
    expect(ownerToken).toBeTruthy();
    expect(await store.renewProcessingLock(leadId, 'not-owner', 10)).toBe(false);
    expect(await store.renewProcessingLock(leadId, ownerToken!, 10)).toBe(true);

    const claimResults = await Promise.all(
      Array.from({ length: 8 }, (_, index) => store.acquireDeliveryClaim(leadId, `claim-${index}`, 10))
    );
    expect(claimResults.filter(Boolean)).toHaveLength(1);
    const claimId = `claim-${claimResults.findIndex(Boolean)}`;
    const deliveredAtIso = new Date().toISOString();
    const deliveredRecord: LeadRecord = { ...pending, status: 'delivered', deliveredAt: deliveredAtIso };
    expect(
      await store.commitDeliveredIfClaimOwned({
        leadId,
        claimId: 'not-owner',
        deliveredAtIso,
        deliveredRecord,
        leadRecordTtlSec: 30,
      })
    ).toMatchObject({ status: 'claim_missing' });
    expect(
      await store.commitDeliveredIfClaimOwned({
        leadId,
        claimId,
        deliveredAtIso,
        deliveredRecord,
        leadRecordTtlSec: 30,
      })
    ).toMatchObject({ status: 'committed', deliveredAtIso });
    expect(await store.getDeliveryFence(leadId)).toBe(deliveredAtIso);
    expect((await store.getLeadRecord(leadId))?.status).toBe('delivered');
    expect(await store.listDueLeadIds(Date.now(), 10)).not.toContain(leadId);
    await store.releaseProcessingLock(leadId, ownerToken!);
  }, 10_000);

  test('parallel workers deliver one queued lead once', async () => {
    deliverLeadWebhookMock.mockReset();
    deliverLeadWebhookMock.mockImplementation(async () => {
      await delay(50);
      return { ok: true, status: 200 };
    });
    const leadId = randomUUID();
    const pending = createLead(leadId);
    await store.enqueueLeadWithIdempotency({
      idempotencyHash: pending.idempotencyHash,
      idempotencyTtlSec: 30,
      successResponse: successResponse(leadId),
      leadRecord: pending,
      leadRecordTtlSec: 30,
    });

    const results = await Promise.all([processLeadQueue(1), processLeadQueue(1)]);
    expect(results.reduce((count, result) => count + result.delivered, 0)).toBe(1);
    expect(deliverLeadWebhookMock).toHaveBeenCalledTimes(1);
    expect((await store.getLeadRecord(leadId))?.status).toBe('delivered');
    expect(await store.getDeliveryFence(leadId)).toBeTruthy();
    expect(await store.getQueueDepth()).toBe(0);
  }, 15_000);

  test('failed delivery retries, reaches DLQ and updates health counters', async () => {
    deliverLeadWebhookMock.mockReset();
    deliverLeadWebhookMock.mockResolvedValue({ ok: false, code: 'WEBHOOK_HTTP_500', status: 500, message: 'mock' });
    const leadId = randomUUID();
    const pending = createLead(leadId);
    await store.enqueueLeadWithIdempotency({
      idempotencyHash: pending.idempotencyHash,
      idempotencyTtlSec: 30,
      successResponse: successResponse(leadId),
      leadRecord: pending,
      leadRecordTtlSec: 30,
    });

    const first = await processLeadQueue(1);
    expect(first.retried).toBe(1);
    expect((await store.getLeadRecord(leadId))?.retryCount).toBe(1);
    await store.scheduleLead(leadId, Date.now() - 1);
    const second = await processLeadQueue(1);
    expect(second.failed).toBe(1);
    expect(second.deadLettered).toBe(1);
    expect((await store.getLeadRecord(leadId))?.status).toBe('failed');
    expect(await store.getQueueDepth()).toBe(0);
    expect(deliverLeadWebhookMock).toHaveBeenCalledTimes(2);

    const dlq = await redisCommand<string[]>('LRANGE', `${prefix}:delivery:dlq`, 0, -1);
    expect(dlq.map((item) => JSON.parse(item).leadId)).toContain(leadId);
    const health = await store.getLeadPipelineHealth();
    expect(health.counters.delivery_retry_total).toBe(1);
    expect(health.counters.delivery_failed_total).toBe(1);
    expect(health.counters.delivery_dlq_total).toBe(1);
  }, 15_000);

  test('persists worker heartbeat and exposes stale cycles plus oldest pending age', async () => {
    const nowMs = Date.now();
    await recordWorkerCycleHeartbeat({
      status: 'ok',
      processed: 3,
      delivered: 2,
      lastCycleAtMs: nowMs - 10_000,
    });
    expect(
      await redisCommand<string[]>('HMGET', `${prefix}:worker:heartbeat`, 'status', 'processed', 'delivered', 'error')
    ).toEqual(['ok', '3', '2', '']);

    const leadId = randomUUID();
    const pending = createLead(leadId, nowMs - 180_000);
    await store.enqueueLeadWithIdempotency({
      idempotencyHash: pending.idempotencyHash,
      idempotencyTtlSec: 30,
      successResponse: successResponse(leadId),
      leadRecord: pending,
      leadRecordTtlSec: 30,
    });

    const warning = await getWorkerRuntimeHealth(nowMs);
    expect(warning.redisLive).toBe(true);
    expect(warning.heartbeat).toMatchObject({ state: 'cycling', ageMs: 10_000 });
    expect(warning.oldestPending.state).toBe('warning');
    expect(warning.oldestPending.ageMs).toBeGreaterThanOrEqual(180_000);
    expect(warning.ok).toBe(false);

    await store.scheduleLead(leadId, nowMs + 60_000);
    const warningAfterRetryReschedule = await getWorkerRuntimeHealth(nowMs);
    expect(warningAfterRetryReschedule.oldestPending.state).toBe('warning');
    expect(warningAfterRetryReschedule.oldestPending.ageMs).toBeGreaterThanOrEqual(180_000);

    await store.removeFromSchedule(leadId);
    await recordWorkerCycleHeartbeat({
      status: 'error',
      processed: 0,
      delivered: 0,
      error: new Error('REDIS_NETWORK_ERROR'),
      lastCycleAtMs: nowMs - 61_000,
    });
    const stale = await getWorkerRuntimeHealth(nowMs);
    expect(stale.heartbeat).toMatchObject({ state: 'stale', ageMs: 61_000 });
    expect(stale.heartbeat.value).toMatchObject({ status: 'error', error: 'REDIS_NETWORK_ERROR' });
    expect(stale.oldestPending.state).toBe('empty');
    expect(stale.ok).toBe(false);
  });

  test('funnel counters use the same Redis namespace', async () => {
    const timestampMs = Date.now();
    const bucket = new Date(timestampMs).toISOString().slice(0, 10);
    expect(await recordFunnelMetric({ eventName: 'form_submitted', pageSlug: '/kuhni', timestampMs })).toEqual({
      dataSource: 'redis',
    });
    const rollup = await getFunnelRollupFull({ span: 'day', bucket, pageSlug: '/kuhni' });
    expect(rollup.dataSource).toBe('redis');
    expect(rollup.totalSubmitted).toBeGreaterThanOrEqual(1);
  });

  test('admin throttling, health state and snapshots use native Redis', async () => {
    const request = new Request('http://local.test/api/admin/health', {
      headers: { authorization: 'Bearer wrong-token', 'user-agent': `redis-test-${randomUUID()}` },
    });
    const first = await authorizeAdminRequest(request, { scope: 'redis-integration', clientAddress: '127.0.0.91' });
    const second = await authorizeAdminRequest(request, { scope: 'redis-integration', clientAddress: '127.0.0.91' });
    const blocked = await authorizeAdminRequest(request, { scope: 'redis-integration', clientAddress: '127.0.0.91' });
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(blocked).toMatchObject({ ok: false, status: 429, code: 'TOO_MANY_REQUESTS' });

    const state = {
      scope: 'global' as const,
      key: 'redis-integration',
      state: 'HEALTHY' as const,
      since: new Date().toISOString(),
      previousState: null,
      stableDays: 1,
      updatedAtMs: Date.now(),
    };
    expect(await upsertHealthState(state)).toMatchObject({ dataSource: 'redis', degraded: false });
    expect(await getHealthState('global', state.key)).toMatchObject({
      dataSource: 'redis',
      degraded: false,
      value: { key: state.key, state: 'HEALTHY' },
    });
    await appendHealthTransition({
      scope: 'global',
      key: state.key,
      from: 'DEGRADED',
      to: 'HEALTHY',
      at: new Date().toISOString(),
      reason: 'redis_integration',
      stableDays: 1,
    });
    expect((await getHealthTransitionHistory({ limit: 10 })).value).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: state.key, to: 'HEALTHY' })])
    );

    const today = new Date().toISOString().slice(0, 10);
    const snapshot = await generateDailyConversionSnapshot({ targetDay: today, baselineDays: 1 });
    expect(snapshot.storageSource).toBe('redis');
    expect(await redisCommand<number>('TTL', `${prefix}:metrics:snapshot:day:${today}`)).toBeGreaterThan(0);
  });
});
