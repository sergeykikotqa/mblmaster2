import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';

import type { LeadStore } from '../src/server/leads/store';
import type { ContactSuccessResponse, LeadRecord } from '../src/server/leads/types';

type BarrierPhase = 'claim_acquired_before_post' | 'receiver_accepted_before_redis_commit';
type ChildMessage = {
  type: 'barrier' | 'complete' | 'error';
  phase?: BarrierPhase;
  pid: number;
  result?: Record<string, number>;
  message?: string;
};
type ReceiverAttempt = {
  webhookId: string;
  duplicate: boolean;
  businessAccepted: boolean;
};
type ReceiverStats = { attempts: ReceiverAttempt[]; actualAcceptances: number };
type WorkerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};
type WorkerChild = {
  child: ChildProcess;
  pid: number;
  stderr: string[];
  exit: Promise<WorkerExit>;
  processError: Promise<Error>;
  lastProcessError: Error | null;
  spawnFailed: boolean;
  outcome: WorkerExit | null;
};
type TerminationEvidence = WorkerExit & {
  pid: number;
  killRequested: boolean;
  processError: string | null;
  exitConfirmed: true;
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const childScript = path.join(repoRoot, 'scripts', 'lead-delivery-process-kill-worker-child.mjs');
const redisPrefix = String(process.env.CONTACT_REDIS_PREFIX || '');
const receiverBaseUrl = String(process.env.R04_RECEIVER_BASE_URL || '');
const receiverTarget = String(process.env.R04_RECEIVER_TARGET || '');
let store: LeadStore;
let redisCommand: <T>(...args: Array<string | number>) => Promise<T>;
let closeRedisClient: () => Promise<void>;
const activeWorkers = new Set<WorkerChild>();

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

function startWorker(mode: 'before_post' | 'after_accept' | 'proxy'): WorkerChild {
  const stderr: string[] = [];
  const child = fork(childScript, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      R04_BARRIER_MODE: mode,
      R04_RECEIVER_TARGET: receiverTarget,
      CONTACT_WEBHOOK_URL: 'https://mbl-test-webhook.invalid/webhook',
      CONTACT_WEBHOOK_SECRET: String(process.env.CONTACT_WEBHOOK_SECRET || ''),
      CONTACT_WEBHOOK_TIMEOUT_MS: '15000',
      CONTACT_WORKER_PROCESSING_LOCK_TTL_SEC: '5',
      CONTACT_WORKER_DELIVERY_CLAIM_TTL_SEC: '5',
      CONTACT_DELIVERY_MAX_RETRIES: '2',
      CONTACT_RETRY_BASE_DELAY_SEC: '1',
      CONTACT_ALERT_WEBHOOK_URL: '',
      CONTACT_ALERT_WEBHOOK_URL_SECONDARY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  let resolveProcessError: (error: Error) => void = () => {};
  const processError = new Promise<Error>((resolve) => {
    resolveProcessError = resolve;
  });
  const exit = new Promise<WorkerExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const worker: WorkerChild = {
    child,
    pid: child.pid ?? -1,
    stderr,
    exit,
    processError,
    lastProcessError: null,
    spawnFailed: false,
    outcome: null,
  };
  activeWorkers.add(worker);
  child.on('error', (error) => {
    worker.lastProcessError ??= error;
    if (worker.pid <= 0) {
      worker.spawnFailed = true;
      activeWorkers.delete(worker);
    }
    resolveProcessError(error);
  });
  void exit.then((outcome) => {
    worker.outcome = outcome;
    activeWorkers.delete(worker);
  });
  expect(worker.pid).toBeGreaterThan(0);
  return worker;
}

async function waitForExit(worker: WorkerChild, timeoutMs = 5000): Promise<WorkerExit> {
  if (worker.outcome) return worker.outcome;
  if (worker.spawnFailed) {
    throw new Error(`Worker process was not created: ${worker.lastProcessError?.message || 'unknown spawn failure'}`);
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      worker.exit,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const processError = worker.lastProcessError ? `; processError=${worker.lastProcessError.message}` : '';
          reject(new Error(`Worker ${worker.pid} did not confirm exit within ${timeoutMs}ms${processError}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isAbnormalExit(exit: WorkerExit): boolean {
  return exit.signal !== null || (exit.code !== null && exit.code !== 0);
}

async function terminateOwnedWorker(worker: WorkerChild): Promise<TerminationEvidence> {
  if (worker.spawnFailed) {
    throw new Error(`Worker process was not created: ${worker.lastProcessError?.message || 'unknown spawn failure'}`);
  }
  if (worker.outcome) {
    return {
      pid: worker.pid,
      killRequested: false,
      processError: worker.lastProcessError?.message || null,
      exitConfirmed: true,
      ...worker.outcome,
    };
  }
  const killRequested = worker.child.kill('SIGKILL');
  const outcome = await waitForExit(worker);
  if (!killRequested && !isAbnormalExit(outcome)) {
    throw new Error(`Worker ${worker.pid} rejected SIGKILL and exited normally`);
  }
  return {
    pid: worker.pid,
    killRequested,
    processError: worker.lastProcessError?.message || null,
    exitConfirmed: true,
    ...outcome,
  };
}

async function cleanupOwnedWorkers(): Promise<TerminationEvidence[]> {
  const evidence: TerminationEvidence[] = [];
  const failures: Error[] = [];
  for (const worker of [...activeWorkers]) {
    try {
      evidence.push(await terminateOwnedWorker(worker));
    } catch (error) {
      failures.push(new Error(`Failed to clean R04 worker ${worker.pid}`, { cause: error }));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'One or more R04 worker processes could not be cleaned');
  return evidence;
}

async function waitForMessage(
  worker: WorkerChild,
  predicate: (message: ChildMessage) => boolean
): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(() =>
        reject(new Error(`Timed out waiting for worker ${worker.pid}; stderr=${worker.stderr.join('').slice(0, 500)}`))
      );
    }, 20_000);
    const onMessage = (message: ChildMessage) => {
      if (message?.type === 'error') {
        finish(() => reject(new Error(`Worker ${worker.pid} failed: ${message.message || 'unknown error'}`)));
        return;
      }
      if (!predicate(message)) return;
      finish(() => resolve(message));
    };
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.child.off('message', onMessage);
      complete();
    };
    worker.child.on('message', onMessage);
    void worker.processError.then((error) => {
      finish(() =>
        reject(
          new Error(
            `Worker ${worker.pid} emitted a process error before the expected IPC message: ${error.message}; exit is not assumed`
          )
        )
      );
    });
    void worker.exit.then((outcome) => {
      setImmediate(() => {
        finish(() =>
          reject(
            new Error(
              `Worker ${worker.pid} exited before the expected IPC message: code=${String(outcome.code)} signal=${String(outcome.signal)} processError=${worker.lastProcessError?.message || 'none'} stderr=${worker.stderr.join('').slice(0, 500)}`
            )
          )
        );
      });
    });
  });
}

async function waitForBarrier(worker: WorkerChild, phase: BarrierPhase): Promise<void> {
  const message = await waitForMessage(
    worker,
    (candidate) => candidate.type === 'barrier' && candidate.phase === phase
  );
  expect(message.pid).toBe(worker.pid);
}

async function forceKill(worker: WorkerChild): Promise<TerminationEvidence> {
  const exit = await terminateOwnedWorker(worker);
  expect(exit.killRequested).toBe(true);
  expect(exit.exitConfirmed).toBe(true);
  expect(exit.processError).toBeNull();
  expect(isAbnormalExit(exit)).toBe(true);
  return exit;
}

async function runRecoveryWorker(): Promise<{ pid: number; result: Record<string, number> }> {
  const worker = startWorker('proxy');
  const message = await waitForMessage(worker, (candidate) => candidate.type === 'complete');
  const exit = await waitForExit(worker);
  expect(exit.code).toBe(0);
  expect(message.result).toMatchObject({ delivered: 1 });
  return { pid: worker.pid, result: message.result || {} };
}

async function waitForLocksToExpire(leadId: string): Promise<{ processingTtl: number; claimTtl: number }> {
  const processingKey = `${redisPrefix}:delivery:lock:${leadId}`;
  const claimKey = `${redisPrefix}:delivery:claim:${leadId}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const processingTtl = await redisCommand<number>('TTL', processingKey);
    const claimTtl = await redisCommand<number>('TTL', claimKey);
    if (processingTtl === -2 && claimTtl === -2) return { processingTtl, claimTtl };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`R04 locks did not expire for synthetic lead ${leadId}`);
}

async function redisState(leadId: string) {
  return {
    status: (await store.getLeadRecord(leadId))?.status || null,
    queueDepth: await store.getQueueDepth(),
    processingLock: Boolean(await redisCommand<string | null>('GET', `${redisPrefix}:delivery:lock:${leadId}`)),
    deliveryClaim: Boolean(await redisCommand<string | null>('GET', `${redisPrefix}:delivery:claim:${leadId}`)),
    fence: Boolean(await store.getDeliveryFence(leadId)),
  };
}

beforeAll(async () => {
  if (!process.env.REDIS_URL || !redisPrefix || !receiverBaseUrl || !receiverTarget) {
    throw new Error('Run this suite via npm run check:lead-process-kills');
  }
  const redis = await import('../src/server/redis/client');
  redisCommand = redis.redisCommand;
  closeRedisClient = redis.closeRedisClient;
  store = (await import('../src/server/leads/store')).getLeadStore();
  expect(store.mode).toBe('redis');
  expect((await store.ping()).ok).toBe(true);
});

beforeEach(async () => deletePrefixKeys());

afterEach(async () => {
  await cleanupOwnedWorkers();
});

afterAll(async () => {
  try {
    if (redisCommand) await deletePrefixKeys();
  } finally {
    await closeRedisClient?.();
  }
});

test('R04-1: SIGKILL after claim and before POST recovers without a pre-crash delivery', async () => {
  const leadId = randomUUID();
  await enqueue(leadId, '[r04-before-post]');
  const firstWorker = startWorker('before_post');
  await waitForBarrier(firstWorker, 'claim_acquired_before_post');

  const beforeKill = await redisState(leadId);
  expect(beforeKill).toEqual({
    status: 'pending',
    queueDepth: 1,
    processingLock: true,
    deliveryClaim: true,
    fence: false,
  });
  expect((await receiverStats(leadId)).attempts).toHaveLength(0);

  const killed = await forceKill(firstWorker);
  expect((await receiverStats(leadId)).attempts).toHaveLength(0);
  const afterKill = await redisState(leadId);
  expect(afterKill).toMatchObject({ status: 'pending', queueDepth: 1, fence: false });
  const expired = await waitForLocksToExpire(leadId);
  const recovery = await runRecoveryWorker();

  const stats = await receiverStats(leadId);
  expect(stats.attempts).toHaveLength(1);
  expect(stats.actualAcceptances).toBe(1);
  const finalState = await redisState(leadId);
  expect(finalState).toEqual({
    status: 'delivered',
    queueDepth: 0,
    processingLock: false,
    deliveryClaim: false,
    fence: true,
  });
  console.log(
    JSON.stringify({
      scenario: 'R04-1',
      killedPid: firstWorker.pid,
      killed,
      beforeKill,
      afterKill,
      expired,
      recovery,
      stats,
      finalState,
    })
  );
}, 40_000);

test('R04-2: SIGKILL after receiver acceptance retries the same webhook id without double acceptance', async () => {
  const leadId = randomUUID();
  await enqueue(leadId, '[r04-after-accept]');
  const firstWorker = startWorker('after_accept');
  await waitForBarrier(firstWorker, 'receiver_accepted_before_redis_commit');

  const firstStats = await receiverStats(leadId);
  expect(firstStats.attempts).toHaveLength(1);
  expect(firstStats.actualAcceptances).toBe(1);
  expect(firstStats.attempts[0]).toMatchObject({ webhookId: leadId, duplicate: false, businessAccepted: true });
  const beforeKill = await redisState(leadId);
  expect(beforeKill).toEqual({
    status: 'pending',
    queueDepth: 1,
    processingLock: true,
    deliveryClaim: true,
    fence: false,
  });

  const killed = await forceKill(firstWorker);
  const afterKill = await redisState(leadId);
  expect(afterKill).toMatchObject({ status: 'pending', queueDepth: 1, fence: false });
  const expired = await waitForLocksToExpire(leadId);
  const recovery = await runRecoveryWorker();

  const stats = await receiverStats(leadId);
  expect(stats.attempts).toHaveLength(2);
  expect(stats.attempts.every((attempt) => attempt.webhookId === leadId)).toBe(true);
  expect(stats.attempts.map((attempt) => attempt.duplicate)).toEqual([false, true]);
  expect(stats.actualAcceptances).toBe(1);
  const finalState = await redisState(leadId);
  expect(finalState).toEqual({
    status: 'delivered',
    queueDepth: 0,
    processingLock: false,
    deliveryClaim: false,
    fence: true,
  });
  console.log(
    JSON.stringify({
      scenario: 'R04-2',
      killedPid: firstWorker.pid,
      killed,
      beforeKill,
      afterKill,
      expired,
      recovery,
      stats,
      finalState,
    })
  );
}, 40_000);

test('R04 lifecycle: early exit is diagnosed and an assertion failure after a barrier cannot leak the worker', async () => {
  const earlyExitWorker = startWorker('proxy');
  const waitStartedAt = Date.now();
  await expect(waitForBarrier(earlyExitWorker, 'claim_acquired_before_post')).rejects.toThrow(
    /exited before the expected IPC message/u
  );
  expect(Date.now() - waitStartedAt).toBeLessThan(20_000);
  const earlyExit = await waitForExit(earlyExitWorker);
  expect(earlyExit).toMatchObject({ code: 0, signal: null });

  const leadId = randomUUID();
  await enqueue(leadId, '[r04-cleanup-failure-path]');
  const barrierWorker = startWorker('before_post');
  await waitForBarrier(barrierWorker, 'claim_acquired_before_post');

  let artificialAssertion: unknown;
  try {
    expect('actual-after-barrier').toBe('intentionally-different');
  } catch (error) {
    artificialAssertion = error;
  }
  expect(artificialAssertion).toBeInstanceOf(Error);
  const cleanup = await cleanupOwnedWorkers();
  const barrierCleanup = cleanup.find((item) => item.pid === barrierWorker.pid);
  expect(barrierCleanup).toBeDefined();
  expect(barrierCleanup?.killRequested).toBe(true);
  expect(barrierCleanup?.exitConfirmed).toBe(true);
  expect(barrierCleanup?.processError).toBeNull();
  expect(barrierCleanup ? isAbnormalExit(barrierCleanup) : false).toBe(true);
  expect(activeWorkers.has(barrierWorker)).toBe(false);
  console.log(
    JSON.stringify({ scenario: 'R04-lifecycle', earlyExitPid: earlyExitWorker.pid, earlyExit, barrierCleanup })
  );
}, 30_000);

test('R04 lifecycle: a process error from a live worker does not remove it before confirmed exit', async () => {
  const leadId = randomUUID();
  await enqueue(leadId, '[r04-live-process-error]');
  const worker = startWorker('before_post');
  await waitForBarrier(worker, 'claim_acquired_before_post');

  const syntheticProcessError = new Error('synthetic live child-process error');
  worker.child.emit('error', syntheticProcessError);
  await expect(worker.processError).resolves.toBe(syntheticProcessError);
  expect(worker.outcome).toBeNull();
  expect(activeWorkers.has(worker)).toBe(true);

  const cleanup = await cleanupOwnedWorkers();
  const evidence = cleanup.find((item) => item.pid === worker.pid);
  expect(evidence).toMatchObject({
    pid: worker.pid,
    killRequested: true,
    processError: syntheticProcessError.message,
    exitConfirmed: true,
  });
  expect(evidence ? isAbnormalExit(evidence) : false).toBe(true);
  expect(worker.outcome).not.toBeNull();
  expect(activeWorkers.has(worker)).toBe(false);
  console.log(JSON.stringify({ scenario: 'R04-live-process-error', cleanup: evidence }));
}, 30_000);
