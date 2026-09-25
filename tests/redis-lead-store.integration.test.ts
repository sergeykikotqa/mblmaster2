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

const redisIntegrationRequested = process.env.REDIS_INTEGRATION === '1';
const configuredRedisUrl = String(process.env.REDIS_URL || '').trim();
if (redisIntegrationRequested && !configuredRedisUrl) {
  throw new Error('REDIS_INTEGRATION=1 requires a non-empty REDIS_URL');
}
const runAgainstRedis = redisIntegrationRequested && Boolean(configuredRedisUrl);
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
  let generateDailyMetricsSnapshotV2: typeof import('../src/server/metrics/snapshot').generateDailyMetricsSnapshotV2;
  let getStoredDailyMetricsSnapshotV2: typeof import('../src/server/metrics/snapshot').getStoredDailyMetricsSnapshotV2;
  let probeRedisReadiness: typeof import('../src/server/health/runtime').probeRedisReadiness;
  let resetRedisReadinessCacheForTests: typeof import('../src/server/health/runtime').resetRedisReadinessCacheForTests;
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
      'REDIS_READINESS_SUCCESS_CACHE_MS',
      'REDIS_READINESS_FAILURE_CACHE_MS',
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
    const metricsSnapshot = await import('../src/server/metrics/snapshot');
    generateDailyMetricsSnapshotV2 = metricsSnapshot.generateDailyMetricsSnapshotV2;
    getStoredDailyMetricsSnapshotV2 = metricsSnapshot.getStoredDailyMetricsSnapshotV2;
    const redisReadiness = await import('../src/server/health/runtime');
    probeRedisReadiness = redisReadiness.probeRedisReadiness;
    resetRedisReadinessCacheForTests = redisReadiness.resetRedisReadinessCacheForTests;
    expect((await store.ping()).ok).toBe(true);
    expect(store.mode).toBe('redis');
    expect(store.hasDurableStorage).toBe(true);
  }, 30_000);

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

    const dlq = await redisCommand<string[]>('ZREVRANGE', `${prefix}:delivery:dlq:v2`, 0, -1);
    expect(dlq.map((item) => JSON.parse(item).leadId)).toContain(leadId);
    const health = await store.getLeadPipelineHealth();
    expect(health.counters.delivery_retry_total).toBe(1);
    expect(health.counters.delivery_failed_total).toBe(1);
    expect(health.counters.delivery_dlq_total).toBe(1);
  }, 15_000);

  test('DLQ entries expire by individual age without affecting active leads', async () => {
    const nowMs = Date.now();
    const activeLeadId = randomUUID();
    const activeLead = createLead(activeLeadId, nowMs);
    await store.enqueueLeadWithIdempotency({
      idempotencyHash: activeLead.idempotencyHash,
      idempotencyTtlSec: 120,
      successResponse: successResponse(activeLeadId),
      leadRecord: activeLead,
      leadRecordTtlSec: 120,
    });
    const deliveredLeadId = randomUUID();
    const deliveredAt = new Date(nowMs).toISOString();
    await store.markDeliveryFence(deliveredLeadId, deliveredAt, 120);

    const oldEntry = {
      leadId: randomUUID(),
      failedAt: new Date(nowMs - 30_000).toISOString(),
      retryCount: 2,
      maxRetries: 2,
      errorCode: 'SYNTHETIC_OLD_FAILURE',
      webhookPayload: { lead: { leadId: 'synthetic-old' } },
    };
    const freshEntry = {
      ...oldEntry,
      leadId: randomUUID(),
      failedAt: new Date(nowMs).toISOString(),
      errorCode: 'SYNTHETIC_FRESH_FAILURE',
      webhookPayload: { lead: { leadId: 'synthetic-fresh' } },
    };

    try {
      await store.pushDeadLetter(oldEntry, 60);
      await store.pushDeadLetter(freshEntry, 60);
      const beforeBoundary = await redisCommand<string[]>('ZREVRANGE', `${prefix}:delivery:dlq:v2`, 0, -1);
      expect(beforeBoundary.map((item) => JSON.parse(item).leadId)).toEqual(
        expect.arrayContaining([oldEntry.leadId, freshEntry.leadId])
      );

      await store.pruneDeadLetters(nowMs + 30_000, 60);
      const atBoundary = await redisCommand<string[]>('ZREVRANGE', `${prefix}:delivery:dlq:v2`, 0, -1);
      const boundaryLeadIds = atBoundary.map((item) => JSON.parse(item).leadId);
      expect(boundaryLeadIds).not.toContain(oldEntry.leadId);
      expect(boundaryLeadIds).toContain(freshEntry.leadId);
      expect(await store.getLeadRecord(activeLeadId)).toMatchObject({ leadId: activeLeadId, status: 'pending' });
      expect(await store.listDueLeadIds(nowMs + 30_000, 10)).toContain(activeLeadId);
      expect(
        await redisCommand<string | null>('GET', `${prefix}:idempotency:${activeLead.idempotencyHash}`)
      ).toBeTruthy();
      expect(await store.getDeliveryFence(deliveredLeadId)).toBe(deliveredAt);

      await store.pruneDeadLetters(nowMs + 60_001, 60);
      const afterExpiry = await redisCommand<string[]>('ZREVRANGE', `${prefix}:delivery:dlq:v2`, 0, -1);
      expect(afterExpiry.map((item) => JSON.parse(item).leadId)).not.toContain(freshEntry.leadId);
      expect(await store.getLeadRecord(activeLeadId)).toMatchObject({ leadId: activeLeadId, status: 'pending' });
      expect(
        await redisCommand<string | null>('GET', `${prefix}:idempotency:${activeLead.idempotencyHash}`)
      ).toBeTruthy();
      expect(await store.getDeliveryFence(deliveredLeadId)).toBe(deliveredAt);
    } finally {
      await store.removeFromSchedule(activeLeadId);
    }
  });

  test('migrates the legacy DLQ list without dropping replayable entries', async () => {
    const nowMs = Date.now();
    const legacyEntry = {
      leadId: randomUUID(),
      failedAt: new Date(nowMs).toISOString(),
      retryCount: 2,
      maxRetries: 2,
      errorCode: 'SYNTHETIC_LEGACY_FAILURE',
      webhookPayload: { lead: { leadId: 'synthetic-legacy' } },
    };
    await redisCommand('LPUSH', `${prefix}:delivery:dlq`, JSON.stringify(legacyEntry));
    await redisCommand('EXPIRE', `${prefix}:delivery:dlq`, 60);

    await store.pruneDeadLetters(nowMs, 60);

    expect(await redisCommand<string>('TYPE', `${prefix}:delivery:dlq`)).toBe('none');
    const migrated = await redisCommand<string[]>('ZREVRANGE', `${prefix}:delivery:dlq:v2`, 0, -1);
    expect(migrated.map((item) => JSON.parse(item).leadId)).toContain(legacyEntry.leadId);
  });

  test('bounds the DLQ and leaves no successful readiness probe keys behind', async () => {
    const dlqKey = `${prefix}:delivery:dlq:v2`;
    const nowMs = Date.now();
    const bulk: Array<string | number> = [];
    for (let index = 0; index < 1005; index += 1) {
      bulk.push(
        nowMs + index,
        JSON.stringify({
          leadId: `bulk-${index}`,
          failedAt: new Date(nowMs).toISOString(),
          retryCount: 1,
          maxRetries: 1,
          errorCode: 'SYNTHETIC_BULK_FAILURE',
          webhookPayload: { lead: { leadId: `bulk-${index}` } },
        })
      );
    }
    await redisCommand('ZADD', dlqKey, ...bulk);
    await store.pruneDeadLetters(nowMs, 3600);
    expect(await redisCommand<number>('ZCARD', dlqKey)).toBe(1000);

    resetRedisReadinessCacheForTests();
    await expect(probeRedisReadiness()).resolves.toEqual({ ok: true });
    const probeKeys = await redisCommand<string[]>('KEYS', `${prefix}:health:write-read-probe:*`);
    expect(probeKeys).toEqual([]);
  });

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
    const snapshot = await generateDailyMetricsSnapshotV2({ targetDay: today });
    expect(snapshot.storageSource).toBe('redis');
    expect(snapshot.snapshot.schemaVersion).toBe(2);
    expect(snapshot.snapshot.counters.opened).toBeGreaterThanOrEqual(0);
    expect(snapshot.snapshot.counters.submitted).toBeGreaterThanOrEqual(0);
    const snapshotKey = `${prefix}:metrics:snapshot:v2:day:${today}`;
    const rawSnapshot = await redisCommand<string | null>('GET', snapshotKey);
    expect(rawSnapshot).not.toBeNull();
    if (rawSnapshot === null) throw new Error('SNAPSHOT_V2_NOT_PERSISTED');
    const persistedSnapshot: unknown = JSON.parse(rawSnapshot);
    expect(persistedSnapshot).toEqual({
      schemaVersion: 2,
      targetDay: today,
      generatedAtMs: snapshot.snapshot.generatedAtMs,
      dataSource: snapshot.snapshot.dataSource,
      metricsDegraded: snapshot.snapshot.metricsDegraded,
      counters: {
        opened: snapshot.snapshot.counters.opened,
        submitted: snapshot.snapshot.counters.submitted,
      },
    });
    expect(persistedSnapshot).toEqual(snapshot.snapshot);
    expect(persistedSnapshot).not.toHaveProperty('storageSource');
    expect(JSON.stringify(persistedSnapshot)).not.toMatch(
      /"baselineDays"|"baselineAvgOpened"|"baselineAvgSubmitted"|"volumeDiagnostics"|"conversionRate"|"cr_drop"|"zero_submitted"|"opened_up_submitted_down"/
    );

    const readSnapshot = await getStoredDailyMetricsSnapshotV2(today);
    expect(readSnapshot).toEqual({ snapshot: persistedSnapshot, storageSource: 'redis' });
    expect(await redisCommand<number>('TTL', snapshotKey)).toBeGreaterThan(0);
    expect(await redisCommand<number>('EXISTS', `${prefix}:metrics:snapshot:day:${today}`)).toBe(0);

    const mismatchedKeyDay = '2000-01-01';
    const mismatchedPayload = { ...snapshot.snapshot, targetDay: '2000-01-02' };
    await redisCommand(
      'SET',
      `${prefix}:metrics:snapshot:v2:day:${mismatchedKeyDay}`,
      JSON.stringify(mismatchedPayload),
      'EX',
      60
    );
    expect(await getStoredDailyMetricsSnapshotV2(mismatchedKeyDay)).toBeNull();
  });
});
