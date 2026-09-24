import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import type { LeadStore } from '../src/server/leads/store';
import type { ContactSuccessResponse, LeadRecord } from '../src/server/leads/types';

vi.mock('../src/server/leads/alerts', () => ({
  notifyLeadDeadLetter: vi.fn(async () => false),
  notifyLeadRetryRateWarning: vi.fn(async () => false),
}));

type ReceiverAttempt = {
  webhookId: string;
  leadId: string;
  attemptNumber: number;
  duplicate: boolean;
  businessAccepted: boolean;
  status: number;
  signatureValid: boolean;
  timestampFresh: boolean;
};

type ReceiverStats = {
  attempts: ReceiverAttempt[];
  actualAcceptances: number;
};

const execFileAsync = promisify(execFile);
const redisPrefix = String(process.env.CONTACT_REDIS_PREFIX || '');
const receiverBaseUrl = String(process.env.R03_RECEIVER_BASE_URL || '');
let store: LeadStore;
let processLeadQueue: typeof import('../src/server/leads/worker').processLeadQueue;
let redisCommand: <T>(...args: Array<string | number>) => Promise<T>;
let closeRedisClient: () => Promise<void>;
let redisCleanupReady = false;

function createLead(leadId: string, marker: string): LeadRecord {
  const now = new Date().toISOString();
  return {
    leadId,
    receivedAt: now,
    idempotencyHash: `idem-${leadId}`,
    payloadFingerprint: `fingerprint-${leadId}`,
    webhookPayload: { lead: { leadId, message: marker } },
    status: 'pending',
    retryCount: 0,
    nextRetryAt: Date.now() - 1,
    createdAt: now,
    updatedAt: now,
  };
}

function successResponse(leadId: string): ContactSuccessResponse {
  return { success: true, leadId, receivedAt: new Date().toISOString() };
}

async function enqueue(leadId: string, marker: string): Promise<void> {
  const leadRecord = createLead(leadId, marker);
  expect(
    await store.enqueueLeadWithIdempotency({
      idempotencyHash: leadRecord.idempotencyHash,
      idempotencyTtlSec: 300,
      successResponse: successResponse(leadId),
      leadRecord,
      leadRecordTtlSec: 300,
    })
  ).toEqual({ duplicate: false });
}

async function deletePrefixKeys(): Promise<void> {
  let cursor = '0';
  do {
    const result = await redisCommand<[string, string[]]>('SCAN', cursor, 'MATCH', `${redisPrefix}:*`, 'COUNT', 100);
    cursor = String(result[0]);
    if (result[1].length > 0) await redisCommand('DEL', ...result[1]);
  } while (cursor !== '0');
}

async function receiverStats(leadId: string): Promise<ReceiverStats> {
  const response = await fetch(`${receiverBaseUrl}/stats?leadId=${encodeURIComponent(leadId)}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ReceiverStats;
}

async function receiverControl(pathname: string, webhookId: string): Promise<void> {
  const response = await fetch(`${receiverBaseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webhookId }),
  });
  expect(response.status).toBe(200);
}

async function waitForReceiverAttempt(leadId: string, count: number): Promise<ReceiverStats> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const stats = await receiverStats(leadId);
    if (stats.attempts.length >= count) return stats;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Receiver did not observe ${count} attempt(s) for ${leadId}`);
}

function assertReceiverContract(stats: ReceiverStats, leadId: string, expectedAttempts: number): void {
  expect(stats.attempts).toHaveLength(expectedAttempts);
  expect(stats.attempts.every((attempt) => attempt.webhookId === leadId)).toBe(true);
  expect(stats.attempts.every((attempt) => attempt.leadId === leadId)).toBe(true);
  expect(stats.attempts.every((attempt) => attempt.signatureValid)).toBe(true);
  expect(stats.attempts.every((attempt) => attempt.timestampFresh)).toBe(true);
}

beforeAll(async () => {
  if (!process.env.REDIS_URL || !redisPrefix || !receiverBaseUrl) {
    throw new Error('Run this suite via npm run check:lead-faults');
  }
  const redis = await import('../src/server/redis/client');
  redisCommand = redis.redisCommand;
  closeRedisClient = redis.closeRedisClient;
  redisCleanupReady = true;
  store = (await import('../src/server/leads/store')).getLeadStore();
  processLeadQueue = (await import('../src/server/leads/worker')).processLeadQueue;
  expect(store.mode).toBe('redis');
  expect((await store.ping()).ok).toBe(true);
});

beforeEach(async () => {
  process.env.CONTACT_WEBHOOK_TIMEOUT_MS = '1000';
  await deletePrefixKeys();
});

afterAll(async () => {
  try {
    if (redisCleanupReady) await deletePrefixKeys();
  } finally {
    await closeRedisClient?.();
  }
});

test('R02-2A: lost acknowledgement repeats the HTTP POST but an idempotent receiver accepts once', async () => {
  const leadId = randomUUID();
  await enqueue(leadId, '[r03-lost-ack]');

  const first = await processLeadQueue(1);
  expect(first).toMatchObject({ retried: 1, delivered: 0 });
  expect((await store.getLeadRecord(leadId))?.status).toBe('pending');
  expect(await store.getQueueDepth()).toBe(1);

  await new Promise((resolve) => setTimeout(resolve, 900));
  await store.scheduleLead(leadId, Date.now() - 1);
  const second = await processLeadQueue(1);
  expect(second).toMatchObject({ delivered: 1 });

  const stats = await receiverStats(leadId);
  assertReceiverContract(stats, leadId, 2);
  expect(stats.attempts.map((attempt) => attempt.duplicate)).toEqual([false, true]);
  expect(stats.actualAcceptances).toBe(1);
  expect((await store.getLeadRecord(leadId))?.status).toBe('delivered');
  expect(await store.getDeliveryFence(leadId)).toBeTruthy();
  expect(await store.getQueueDepth()).toBe(0);
}, 15_000);

test('R02-2B: claim loss after receiver acceptance cannot create a false delivered state', async () => {
  const leadId = randomUUID();
  await enqueue(leadId, '[r03-claim-barrier]');

  const firstWorkerRun = processLeadQueue(1);
  await waitForReceiverAttempt(leadId, 1);
  const claimKey = `${redisPrefix}:delivery:claim:${leadId}`;
  expect(await redisCommand<string | null>('GET', claimKey)).toBeTruthy();
  await redisCommand('DEL', claimKey);
  expect(await redisCommand<string | null>('GET', claimKey)).toBeNull();
  await receiverControl('/control/release', leadId);

  const first = await firstWorkerRun;
  expect(first).toMatchObject({ skipped: 1, delivered: 0 });
  expect((await store.getLeadRecord(leadId))?.status).toBe('pending');
  expect(await store.getDeliveryFence(leadId)).toBeNull();
  expect(await store.getQueueDepth()).toBe(1);

  const second = await processLeadQueue(1);
  expect(second).toMatchObject({ delivered: 1 });
  const stats = await receiverStats(leadId);
  assertReceiverContract(stats, leadId, 2);
  expect(stats.attempts.map((attempt) => attempt.duplicate)).toEqual([false, true]);
  expect(stats.actualAcceptances).toBe(1);
  expect((await store.getLeadRecord(leadId))?.status).toBe('delivered');
  expect(await store.getDeliveryFence(leadId)).toBeTruthy();
  expect(await store.getQueueDepth()).toBe(0);
}, 15_000);

test('R02-6: DLQ replay preserves leadId, resets retry state and delivers after recovery', async () => {
  const leadId = randomUUID();
  await enqueue(leadId, '[r03-dlq]');

  expect(await processLeadQueue(1)).toMatchObject({ retried: 1 });
  await store.scheduleLead(leadId, Date.now() - 1);
  expect(await processLeadQueue(1)).toMatchObject({ failed: 1, deadLettered: 1 });
  expect((await store.getLeadRecord(leadId))?.status).toBe('failed');
  expect(await store.getQueueDepth()).toBe(0);
  const dlqKey = `${redisPrefix}:delivery:dlq:v2`;
  const dlqBefore = await redisCommand<string[]>('ZREVRANGE', dlqKey, 0, -1);
  expect(dlqBefore.map((item) => JSON.parse(item).leadId)).toContain(leadId);

  const replay = await execFileAsync(process.execPath, ['scripts/dlq-cli.mjs', 'replay', `--lead-id=${leadId}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      DLQ_CLI_ACTOR: 'mbl-r03-synthetic-operator',
      DLQ_AUDIT_LOG_PATH: process.env.R03_AUDIT_LOG_PATH,
    },
  });
  expect(replay.stdout).toContain(`replayed leadId=${leadId}`);
  const replayedRecord = await store.getLeadRecord(leadId);
  expect(replayedRecord).toMatchObject({ leadId, status: 'pending', retryCount: 0 });
  expect(await store.getQueueDepth()).toBe(1);
  const dlqAfter = await redisCommand<string[]>('ZREVRANGE', dlqKey, 0, -1);
  expect(dlqAfter.map((item) => JSON.parse(item).leadId)).not.toContain(leadId);

  await receiverControl('/control/recover', leadId);
  expect(await processLeadQueue(1)).toMatchObject({ delivered: 1 });
  const stats = await receiverStats(leadId);
  assertReceiverContract(stats, leadId, 3);
  expect(stats.attempts.map((attempt) => attempt.status)).toEqual([503, 503, 200]);
  expect(stats.actualAcceptances).toBe(1);
  expect((await store.getLeadRecord(leadId))?.status).toBe('delivered');
  expect(await store.getQueueDepth()).toBe(0);
}, 15_000);

test('R03-3: a live worker renews its processing lock while a POST outlives the base TTL', async () => {
  process.env.CONTACT_WEBHOOK_TIMEOUT_MS = '8000';
  const leadId = randomUUID();
  await enqueue(leadId, '[r03-lock-renewal]');

  const firstWorkerRun = processLeadQueue(1);
  await waitForReceiverAttempt(leadId, 1);
  const processingLockKey = `${redisPrefix}:delivery:lock:${leadId}`;
  const claimKey = `${redisPrefix}:delivery:claim:${leadId}`;
  expect(await redisCommand<string | null>('GET', processingLockKey)).toBeTruthy();
  expect(await redisCommand<string | null>('GET', claimKey)).toBeTruthy();

  await new Promise((resolve) => setTimeout(resolve, 6000));
  expect(await redisCommand<string | null>('GET', processingLockKey)).toBeTruthy();
  expect(await redisCommand<number>('TTL', processingLockKey)).toBeGreaterThan(0);
  expect(await redisCommand<string | null>('GET', claimKey)).toBeNull();

  const competingWorker = await processLeadQueue(1);
  expect(competingWorker).toMatchObject({ processed: 1, skipped: 1, delivered: 0 });
  expect((await receiverStats(leadId)).attempts).toHaveLength(1);

  await receiverControl('/control/release', leadId);
  const first = await firstWorkerRun;
  expect(first).toMatchObject({ skipped: 1, delivered: 0 });
  expect((await store.getLeadRecord(leadId))?.status).toBe('pending');
  expect(await store.getDeliveryFence(leadId)).toBeNull();

  const recovered = await processLeadQueue(1);
  expect(recovered).toMatchObject({ delivered: 1 });
  const stats = await receiverStats(leadId);
  assertReceiverContract(stats, leadId, 2);
  expect(stats.attempts.map((attempt) => attempt.duplicate)).toEqual([false, true]);
  expect(stats.actualAcceptances).toBe(1);
  expect((await store.getLeadRecord(leadId))?.status).toBe('delivered');
  expect(await store.getDeliveryFence(leadId)).toBeTruthy();
  expect(await store.getQueueDepth()).toBe(0);
}, 20_000);
