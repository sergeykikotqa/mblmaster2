import { randomUUID } from 'node:crypto';
import { hasRedisConfig, redisCommand } from '~/server/redis/client';

import type {
  ContactSuccessResponse,
  DeadLetterEntry,
  DeliveryCommitResult,
  DeliveryAttemptMetric,
  EnqueueLeadResult,
  LeadPipelineHealth,
  LeadRecord,
  RateLimitResult,
} from './types';

export type LeadStore = {
  mode: 'redis' | 'memory';
  hasDurableStorage: boolean;
  ping: () => Promise<{ ok: boolean; code: string; circuitOpen: boolean }>;
  checkRateLimit: (ipKey: string, limit: number, windowSec: number) => Promise<RateLimitResult>;
  enqueueLeadWithIdempotency: (params: {
    idempotencyHash: string;
    idempotencyTtlSec: number;
    successResponse: ContactSuccessResponse;
    leadRecord: LeadRecord;
    leadRecordTtlSec: number;
  }) => Promise<EnqueueLeadResult>;
  getLeadRecord: (leadId: string) => Promise<LeadRecord | null>;
  saveLeadRecord: (leadRecord: LeadRecord, leadRecordTtlSec: number) => Promise<void>;
  listDueLeadIds: (nowMs: number, limit: number) => Promise<string[]>;
  acquireProcessingLock: (leadId: string, ttlSec: number) => Promise<string | null>;
  renewProcessingLock: (leadId: string, token: string, ttlSec: number) => Promise<boolean>;
  releaseProcessingLock: (leadId: string, token: string) => Promise<void>;
  acquireDeliveryClaim: (leadId: string, claimId: string, ttlSec: number) => Promise<boolean>;
  releaseDeliveryClaim: (leadId: string, claimId: string) => Promise<void>;
  markDeliveryFence: (leadId: string, deliveredAtIso: string, ttlSec: number) => Promise<void>;
  getDeliveryFence: (leadId: string) => Promise<string | null>;
  commitDeliveredIfClaimOwned: (params: {
    leadId: string;
    claimId: string;
    deliveredAtIso: string;
    deliveredRecord: LeadRecord;
    leadRecordTtlSec: number;
  }) => Promise<DeliveryCommitResult>;
  scheduleLead: (leadId: string, dueAtMs: number) => Promise<void>;
  removeFromSchedule: (leadId: string) => Promise<void>;
  getQueueDepth: () => Promise<number>;
  pushDeadLetter: (entry: DeadLetterEntry, ttlSec: number) => Promise<void>;
  pruneDeadLetters: (nowMs: number, ttlSec: number) => Promise<void>;
  recordDeliveryMetric: (metric: DeliveryAttemptMetric) => Promise<void>;
  getLeadPipelineHealth: (nowMs?: number) => Promise<LeadPipelineHealth>;
};

const ENQUEUE_LEAD_WITH_IDEMPOTENCY_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) == false then
  local existing = redis.call('GET', KEYS[1])
  return {0, existing}
end
if tonumber(ARGV[4]) > 0 then
  redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
else
  redis.call('SET', KEYS[2], ARGV[3])
end
redis.call('ZADD', KEYS[3], ARGV[6], ARGV[5])
redis.call('ZADD', KEYS[4], ARGV[7], ARGV[5])
return {1}
`;

const REMOVE_FROM_SCHEDULE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;

const RENEW_PROCESSING_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_PROCESSING_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const COMMIT_DELIVERED_IF_CLAIM_OWNED_SCRIPT = `
local claimKey = KEYS[1]
local fenceKey = KEYS[2]
local recordKey = KEYS[3]
local queueKey = KEYS[4]
local pendingSinceKey = KEYS[5]

local claimId = ARGV[1]
local deliveredAtIso = ARGV[2]
local recordJson = ARGV[3]
local recordTtlSec = tonumber(ARGV[4])
local leadId = ARGV[5]

local currentClaim = redis.call('GET', claimKey)
local existingFence = redis.call('GET', fenceKey)

if currentClaim ~= claimId then
  if existingFence and tostring(existingFence) ~= '' then
    return {2, tostring(existingFence)}
  end
  return {0}
end

if recordTtlSec and recordTtlSec > 0 then
  redis.call('SET', recordKey, recordJson, 'EX', recordTtlSec)
  redis.call('SET', fenceKey, deliveredAtIso, 'EX', recordTtlSec)
else
  redis.call('SET', recordKey, recordJson)
  redis.call('SET', fenceKey, deliveredAtIso)
end

redis.call('ZREM', queueKey, leadId)
redis.call('ZREM', pendingSinceKey, leadId)
redis.call('DEL', claimKey)
return {1, deliveredAtIso}
`;

const STORE_DEAD_LETTER_SCRIPT = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
local count = redis.call('ZCARD', KEYS[1])
local maxEntries = tonumber(ARGV[4])
if count > maxEntries then
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - maxEntries - 1)
end
return redis.call('ZCARD', KEYS[1])
`;

const PRUNE_DEAD_LETTER_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
local maxEntries = tonumber(ARGV[2])
if count > maxEntries then
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - maxEntries - 1)
end
return redis.call('ZCARD', KEYS[1])
`;

const MIGRATE_LEGACY_DEAD_LETTERS_SCRIPT = `
local expectedCount = tonumber(ARGV[1])
local current = redis.call('LRANGE', KEYS[1], 0, -1)
if #current ~= expectedCount then
  return 0
end
for index = 1, expectedCount do
  local rawArgIndex = 2 + ((index - 1) * 2)
  if current[index] ~= ARGV[rawArgIndex] then
    return 0
  end
end
for index = 1, expectedCount do
  local rawArgIndex = 2 + ((index - 1) * 2)
  redis.call('ZADD', KEYS[2], ARGV[rawArgIndex + 1], ARGV[rawArgIndex])
end
redis.call('DEL', KEYS[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[2 + (expectedCount * 2)])
local count = redis.call('ZCARD', KEYS[2])
local maxEntries = tonumber(ARGV[3 + (expectedCount * 2)])
if count > maxEntries then
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, count - maxEntries - 1)
end
return 1
`;

const METRICS_RETENTION_SEC = 60 * 60 * 24 * 7;
const DEAD_LETTER_MAX_ENTRIES = 1000;
const DEFAULT_REDIS_MAX_ATTEMPTS = 2;
const DEFAULT_REDIS_RETRY_BASE_DELAY_MS = 120;
const DEFAULT_REDIS_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_REDIS_CIRCUIT_OPEN_MS = 15_000;

type RedisArg = string | number;

type RedisClientOptions = {
  maxAttempts: number;
  retryBaseDelayMs: number;
  circuitFailureThreshold: number;
  circuitOpenMs: number;
};

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveRedisClientOptions(): RedisClientOptions {
  return {
    maxAttempts: parsePositiveInt(process.env.CONTACT_REDIS_MAX_ATTEMPTS, DEFAULT_REDIS_MAX_ATTEMPTS, 1),
    retryBaseDelayMs: parsePositiveInt(
      process.env.CONTACT_REDIS_RETRY_BASE_DELAY_MS,
      DEFAULT_REDIS_RETRY_BASE_DELAY_MS,
      20
    ),
    circuitFailureThreshold: parsePositiveInt(
      process.env.CONTACT_REDIS_CIRCUIT_FAILURE_THRESHOLD,
      DEFAULT_REDIS_CIRCUIT_FAILURE_THRESHOLD,
      1
    ),
    circuitOpenMs: parsePositiveInt(process.env.CONTACT_REDIS_CIRCUIT_OPEN_MS, DEFAULT_REDIS_CIRCUIT_OPEN_MS, 1000),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isRetryableRedisMessage(message: string): boolean {
  return message === 'REDIS_TIMEOUT' || message === 'REDIS_NETWORK_ERROR' || message === 'REDIS_CIRCUIT_OPEN';
}

export function isRedisRuntimeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message || '';
  return (
    message === 'REDIS_NOT_CONFIGURED' ||
    message === 'REDIS_TIMEOUT' ||
    message === 'REDIS_NETWORK_ERROR' ||
    message === 'REDIS_CIRCUIT_OPEN' ||
    message === 'REDIS_COMMAND_ERROR' ||
    message.startsWith('REDIS_RESPONSE_')
  );
}

class NativeRedisClient {
  private readonly options: RedisClientOptions;
  private consecutiveFailures = 0;
  private circuitOpenUntilMs = 0;

  constructor(options: RedisClientOptions) {
    this.options = options;
  }

  private isCircuitOpen(nowMs = Date.now()): boolean {
    return this.circuitOpenUntilMs > nowMs;
  }

  private registerFailure(errorCode: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.options.circuitFailureThreshold) {
      return;
    }

    const nowMs = Date.now();
    const nextOpenUntilMs = nowMs + this.options.circuitOpenMs;
    const alreadyOpen = this.circuitOpenUntilMs > nowMs;
    if (!alreadyOpen) {
      this.circuitOpenUntilMs = nextOpenUntilMs;
      console.warn('[lead-store] redis_circuit_open', {
        errorCode,
        openMs: this.options.circuitOpenMs,
        consecutiveFailures: this.consecutiveFailures,
      });
    } else {
      this.circuitOpenUntilMs = Math.max(this.circuitOpenUntilMs, nextOpenUntilMs);
    }
  }

  private resetFailures(): void {
    if (this.consecutiveFailures > 0 || this.circuitOpenUntilMs > 0) {
      this.consecutiveFailures = 0;
      this.circuitOpenUntilMs = 0;
    }
  }

  private async executeCommand<T>(args: RedisArg[]): Promise<T> {
    return redisCommand<T>(...args);
  }

  async command<T>(...args: RedisArg[]): Promise<T> {
    if (this.isCircuitOpen()) {
      throw new Error('REDIS_CIRCUIT_OPEN');
    }

    let lastError: Error | null = null;
    const attempts = Math.max(1, this.options.maxAttempts);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await this.executeCommand<T>(args);
        this.resetFailures();
        return result;
      } catch (error) {
        lastError = toError(error);
        const canRetry = attempt < attempts && isRetryableRedisMessage(lastError.message);
        if (!canRetry) {
          this.registerFailure(lastError.message);
          throw lastError;
        }

        const delayMs = this.options.retryBaseDelayMs * Math.pow(2, attempt - 1);
        await sleep(delayMs);
      }
    }

    this.registerFailure(lastError?.message || 'REDIS_UNKNOWN_ERROR');
    throw lastError || new Error('REDIS_UNKNOWN_ERROR');
  }

  async eval<T>(script: string, numKeys: number, keys: RedisArg[], values: RedisArg[]): Promise<T> {
    return this.command<T>('EVAL', script, numKeys, ...keys, ...values);
  }

  async ping(): Promise<{ ok: boolean; code: string; circuitOpen: boolean }> {
    if (this.isCircuitOpen()) {
      return { ok: false, code: 'REDIS_CIRCUIT_OPEN', circuitOpen: true };
    }

    try {
      const result = await this.command<string>('PING');
      const pong = String(result || '').toUpperCase() === 'PONG';
      return {
        ok: pong,
        code: pong ? 'REDIS_OK' : 'REDIS_UNEXPECTED_PING',
        circuitOpen: this.isCircuitOpen(),
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof Error ? error.message : 'REDIS_UNKNOWN_ERROR',
        circuitOpen: this.isCircuitOpen(),
      };
    }
  }
}

class RedisLeadStore implements LeadStore {
  mode = 'redis' as const;
  hasDurableStorage = true;

  private readonly client: NativeRedisClient;
  private readonly prefix: string;

  constructor(client: NativeRedisClient, prefix: string) {
    this.client = client;
    this.prefix = prefix;
  }

  async ping(): Promise<{ ok: boolean; code: string; circuitOpen: boolean }> {
    return this.client.ping();
  }

  async checkRateLimit(ipKey: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const key = this.keyRateLimit(ipKey);
    const raw = await this.client.eval<unknown[]>(RATE_LIMIT_SCRIPT, 1, [key], [windowSec]);
    const count = Number(Array.isArray(raw) ? raw[0] : 0);
    const ttl = Number(Array.isArray(raw) ? raw[1] : windowSec);

    return {
      allowed: count <= limit,
      count,
      retryAfterSec: Math.max(0, Number.isFinite(ttl) ? ttl : windowSec),
    };
  }

  async enqueueLeadWithIdempotency(params: {
    idempotencyHash: string;
    idempotencyTtlSec: number;
    successResponse: ContactSuccessResponse;
    leadRecord: LeadRecord;
    leadRecordTtlSec: number;
  }): Promise<EnqueueLeadResult> {
    const idempotencyKey = this.keyIdempotency(params.idempotencyHash);
    const leadRecordKey = this.keyLeadRecord(params.leadRecord.leadId);
    const queueKey = this.keyQueue();
    const pendingSinceKey = this.keyPendingSince();
    const parsedCreatedAtMs = Date.parse(params.leadRecord.createdAt);
    const pendingSinceMs = Number.isFinite(parsedCreatedAtMs) ? Math.floor(parsedCreatedAtMs) : Date.now();

    const raw = await this.client.eval<unknown[]>(
      ENQUEUE_LEAD_WITH_IDEMPOTENCY_SCRIPT,
      4,
      [idempotencyKey, leadRecordKey, queueKey, pendingSinceKey],
      [
        JSON.stringify(params.successResponse),
        params.idempotencyTtlSec,
        JSON.stringify(params.leadRecord),
        params.leadRecordTtlSec,
        params.leadRecord.leadId,
        params.leadRecord.nextRetryAt,
        pendingSinceMs,
      ]
    );

    const created = Number(Array.isArray(raw) ? raw[0] : 0) === 1;
    if (created) {
      return { duplicate: false };
    }

    const existingPayload =
      (Array.isArray(raw) && typeof raw[1] === 'string' && raw[1]) ||
      (await this.client.command<string | null>('GET', idempotencyKey));
    const existingResponse = parseContactSuccessResponse(existingPayload);
    if (existingResponse) {
      const existingRecord = await this.getLeadRecord(existingResponse.leadId);
      if (!existingRecord || existingRecord.payloadFingerprint !== params.leadRecord.payloadFingerprint) {
        return { duplicate: false, conflict: true };
      }
      return { duplicate: true, response: { ...existingResponse, duplicate: true } };
    }

    throw new Error('IDEMPOTENCY_DUPLICATE_WITHOUT_SAVED_RESPONSE');
  }

  async getLeadRecord(leadId: string): Promise<LeadRecord | null> {
    const raw = await this.client.command<string | null>('GET', this.keyLeadRecord(leadId));
    if (!raw) return null;
    return parseLeadRecord(raw);
  }

  async saveLeadRecord(leadRecord: LeadRecord, leadRecordTtlSec: number): Promise<void> {
    if (leadRecordTtlSec > 0) {
      await this.client.command(
        'SET',
        this.keyLeadRecord(leadRecord.leadId),
        JSON.stringify(leadRecord),
        'EX',
        leadRecordTtlSec
      );
      return;
    }
    await this.client.command('SET', this.keyLeadRecord(leadRecord.leadId), JSON.stringify(leadRecord));
  }

  async listDueLeadIds(nowMs: number, limit: number): Promise<string[]> {
    const raw = await this.client.command<unknown[]>(
      'ZRANGEBYSCORE',
      this.keyQueue(),
      '-inf',
      nowMs,
      'LIMIT',
      0,
      limit
    );
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => String(item));
  }

  async scheduleLead(leadId: string, dueAtMs: number): Promise<void> {
    await this.client.command('ZADD', this.keyQueue(), dueAtMs, leadId);
  }

  async acquireProcessingLock(leadId: string, ttlSec: number): Promise<string | null> {
    const normalizedTtlSec = Math.max(1, Number.isFinite(ttlSec) ? Math.floor(ttlSec) : 1);
    const token = randomUUID();
    const result = await this.client.command<string | null>(
      'SET',
      this.keyProcessingLock(leadId),
      token,
      'NX',
      'EX',
      normalizedTtlSec
    );
    return String(result || '').toUpperCase() === 'OK' ? token : null;
  }

  async renewProcessingLock(leadId: string, token: string, ttlSec: number): Promise<boolean> {
    const normalizedTtlSec = Math.max(1, Number.isFinite(ttlSec) ? Math.floor(ttlSec) : 1);
    const raw = await this.client.eval<number>(
      RENEW_PROCESSING_LOCK_SCRIPT,
      1,
      [this.keyProcessingLock(leadId)],
      [token, normalizedTtlSec]
    );
    return Number(raw) === 1;
  }

  async releaseProcessingLock(leadId: string, token: string): Promise<void> {
    await this.client.eval<number>(RELEASE_PROCESSING_LOCK_SCRIPT, 1, [this.keyProcessingLock(leadId)], [token]);
  }

  async acquireDeliveryClaim(leadId: string, claimId: string, ttlSec: number): Promise<boolean> {
    const normalizedTtlSec = Math.max(1, Number.isFinite(ttlSec) ? Math.floor(ttlSec) : 1);
    const result = await this.client.command<string | null>(
      'SET',
      this.keyDeliveryClaim(leadId),
      claimId,
      'NX',
      'EX',
      normalizedTtlSec
    );
    return String(result || '').toUpperCase() === 'OK';
  }

  async releaseDeliveryClaim(leadId: string, claimId: string): Promise<void> {
    await this.client.eval<number>(RELEASE_PROCESSING_LOCK_SCRIPT, 1, [this.keyDeliveryClaim(leadId)], [claimId]);
  }

  async markDeliveryFence(leadId: string, deliveredAtIso: string, ttlSec: number): Promise<void> {
    const normalized = String(deliveredAtIso || '').trim() || new Date().toISOString();
    if (ttlSec > 0) {
      await this.client.command('SET', this.keyDeliveryFence(leadId), normalized, 'EX', Math.floor(ttlSec));
      return;
    }
    await this.client.command('SET', this.keyDeliveryFence(leadId), normalized);
  }

  async getDeliveryFence(leadId: string): Promise<string | null> {
    const raw = await this.client.command<string | null>('GET', this.keyDeliveryFence(leadId));
    if (!raw) return null;
    const value = String(raw).trim();
    return value || null;
  }

  async commitDeliveredIfClaimOwned(params: {
    leadId: string;
    claimId: string;
    deliveredAtIso: string;
    deliveredRecord: LeadRecord;
    leadRecordTtlSec: number;
  }): Promise<DeliveryCommitResult> {
    const raw = await this.client.eval<unknown[]>(
      COMMIT_DELIVERED_IF_CLAIM_OWNED_SCRIPT,
      5,
      [
        this.keyDeliveryClaim(params.leadId),
        this.keyDeliveryFence(params.leadId),
        this.keyLeadRecord(params.leadId),
        this.keyQueue(),
        this.keyPendingSince(),
      ],
      [
        params.claimId,
        params.deliveredAtIso,
        JSON.stringify(params.deliveredRecord),
        Math.max(0, Number.isFinite(params.leadRecordTtlSec) ? Math.floor(params.leadRecordTtlSec) : 0),
        params.leadId,
      ]
    );
    const code = Number(Array.isArray(raw) ? raw[0] : 0);
    const deliveredAtIso = typeof raw?.[1] === 'string' ? String(raw[1]).trim() : '';
    if (code === 1) {
      return {
        status: 'committed',
        deliveredAtIso: deliveredAtIso || params.deliveredAtIso,
      };
    }
    if (code === 2) {
      return {
        status: 'fence_exists',
        deliveredAtIso: deliveredAtIso || params.deliveredAtIso,
      };
    }
    return {
      status: 'claim_missing',
      deliveredAtIso: null,
    };
  }

  async removeFromSchedule(leadId: string): Promise<void> {
    await this.client.eval<number>(REMOVE_FROM_SCHEDULE_SCRIPT, 2, [this.keyQueue(), this.keyPendingSince()], [leadId]);
  }

  async getQueueDepth(): Promise<number> {
    const raw = await this.client.command<unknown>('ZCARD', this.keyQueue());
    return Math.max(0, Number.isFinite(Number(raw)) ? Math.floor(Number(raw)) : 0);
  }

  async pushDeadLetter(entry: DeadLetterEntry, ttlSec: number): Promise<void> {
    const nowMs = Date.now();
    const normalizedTtlSec = Math.max(1, Math.floor(ttlSec));
    const cutoffMs = nowMs - normalizedTtlSec * 1000;
    await this.migrateLegacyDeadLetters(nowMs, cutoffMs);
    await this.client.eval<number>(
      STORE_DEAD_LETTER_SCRIPT,
      1,
      [this.keyDeadLetterByAge()],
      [this.deadLetterScore(entry, nowMs), JSON.stringify(entry), cutoffMs, DEAD_LETTER_MAX_ENTRIES]
    );
  }

  async pruneDeadLetters(nowMs: number, ttlSec: number): Promise<void> {
    const normalizedNowMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    const normalizedTtlSec = Math.max(1, Math.floor(ttlSec));
    const cutoffMs = normalizedNowMs - normalizedTtlSec * 1000;
    await this.migrateLegacyDeadLetters(normalizedNowMs, cutoffMs);
    await this.client.eval<number>(
      PRUNE_DEAD_LETTER_SCRIPT,
      1,
      [this.keyDeadLetterByAge()],
      [cutoffMs, DEAD_LETTER_MAX_ENTRIES]
    );
  }

  async recordDeliveryMetric(metric: DeliveryAttemptMetric): Promise<void> {
    const nowMs = Number.isFinite(metric.timestampMs) ? Math.floor(metric.timestampMs) : Date.now();
    const retentionCutoff = nowMs - METRICS_RETENTION_SEC * 1000;
    const nonce = Math.random().toString(36).slice(2, 10);

    if (metric.status === 'dlq') {
      await this.client.command('INCR', this.keyMetricCounter('delivery_dlq_total'));
      await this.client.command('ZADD', this.keyMetricDlqEvents(), nowMs, `${nowMs}:${nonce}:${metric.leadId}`);
      await this.cleanupMetrics(retentionCutoff);
      return;
    }

    if (metric.status === 'success') {
      await this.client.command('INCR', this.keyMetricCounter('delivery_success_total'));
    } else if (metric.status === 'retry') {
      await this.client.command('INCR', this.keyMetricCounter('delivery_retry_total'));
      await this.client.command('ZADD', this.keyMetricRetryEvents(), nowMs, `${nowMs}:${nonce}:${metric.leadId}`);
    } else if (metric.status === 'failed') {
      await this.client.command('INCR', this.keyMetricCounter('delivery_failed_total'));
    }

    await this.client.command('ZADD', this.keyMetricAttemptEvents(), nowMs, `${nowMs}:${nonce}:${metric.leadId}`);
    if (typeof metric.latencyMs === 'number' && Number.isFinite(metric.latencyMs) && metric.latencyMs >= 0) {
      const latencyMember = JSON.stringify({
        ts: nowMs,
        latencyMs: Math.floor(metric.latencyMs),
        nonce,
      });
      await this.client.command('ZADD', this.keyMetricLatencyEvents(), nowMs, latencyMember);
    }

    await this.cleanupMetrics(retentionCutoff);
  }

  async getLeadPipelineHealth(nowMs = Date.now()): Promise<LeadPipelineHealth> {
    const hourAgoMs = nowMs - 60 * 60 * 1000;
    const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
    const retentionCutoff = nowMs - METRICS_RETENTION_SEC * 1000;

    await this.cleanupMetrics(retentionCutoff);

    const counterKeys = [
      this.keyMetricCounter('delivery_success_total'),
      this.keyMetricCounter('delivery_retry_total'),
      this.keyMetricCounter('delivery_failed_total'),
      this.keyMetricCounter('delivery_dlq_total'),
    ];
    const counterRaw = await this.client.command<unknown[]>('MGET', ...counterKeys);

    const attemptsLastHour = Number(
      await this.client.command<unknown>('ZCOUNT', this.keyMetricAttemptEvents(), hourAgoMs, '+inf')
    );
    const retriesLastHour = Number(
      await this.client.command<unknown>('ZCOUNT', this.keyMetricRetryEvents(), hourAgoMs, '+inf')
    );
    const dlqLastHour = Number(
      await this.client.command<unknown>('ZCOUNT', this.keyMetricDlqEvents(), hourAgoMs, '+inf')
    );
    const dlqLast24Hours = Number(
      await this.client.command<unknown>('ZCOUNT', this.keyMetricDlqEvents(), dayAgoMs, '+inf')
    );

    const latencyRaw = await this.client.command<unknown[]>(
      'ZRANGEBYSCORE',
      this.keyMetricLatencyEvents(),
      hourAgoMs,
      '+inf'
    );
    const latencies = (Array.isArray(latencyRaw) ? latencyRaw : [])
      .map((entry) => {
        if (typeof entry !== 'string') return null;
        try {
          const parsed = JSON.parse(entry) as { latencyMs?: unknown };
          const value = Number(parsed?.latencyMs);
          if (!Number.isFinite(value) || value < 0) return null;
          return Math.floor(value);
        } catch {
          return null;
        }
      })
      .filter((value): value is number => typeof value === 'number');

    const counters = {
      delivery_success_total: parseCounter(counterRaw?.[0]),
      delivery_retry_total: parseCounter(counterRaw?.[1]),
      delivery_failed_total: parseCounter(counterRaw?.[2]),
      delivery_dlq_total: parseCounter(counterRaw?.[3]),
    };

    return {
      retryRateLastHour: attemptsLastHour > 0 ? retriesLastHour / attemptsLastHour : 0,
      dlqLastHour: Math.max(0, dlqLastHour),
      dlqLast24Hours: Math.max(0, dlqLast24Hours),
      p95LatencyMs: computePercentile(latencies, 95),
      queueDepth: await this.getQueueDepth(),
      counters,
      generatedAtMs: nowMs,
    };
  }

  private async cleanupMetrics(retentionCutoffMs: number): Promise<void> {
    await this.client.command('ZREMRANGEBYSCORE', this.keyMetricAttemptEvents(), '-inf', retentionCutoffMs);
    await this.client.command('ZREMRANGEBYSCORE', this.keyMetricRetryEvents(), '-inf', retentionCutoffMs);
    await this.client.command('ZREMRANGEBYSCORE', this.keyMetricDlqEvents(), '-inf', retentionCutoffMs);
    await this.client.command('ZREMRANGEBYSCORE', this.keyMetricLatencyEvents(), '-inf', retentionCutoffMs);
  }

  private deadLetterScore(entry: DeadLetterEntry, nowMs: number): number {
    const parsed = Date.parse(entry.failedAt);
    if (!Number.isFinite(parsed) || parsed > nowMs) return nowMs;
    return Math.floor(parsed);
  }

  private async migrateLegacyDeadLetters(nowMs: number, cutoffMs: number): Promise<void> {
    const legacyKey = this.keyDeadLetterLegacy();
    const keyType = String(await this.client.command<unknown>('TYPE', legacyKey));
    if (keyType === 'none') return;
    if (keyType !== 'list') throw new Error('DLQ_LEGACY_KEY_TYPE_INVALID');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await this.client.command<unknown[]>('LRANGE', legacyKey, 0, -1);
      const entries = Array.isArray(raw) ? raw.map(String) : [];
      if (entries.length === 0) return;
      const values: RedisArg[] = [entries.length];
      for (const serialized of entries) {
        let score = nowMs;
        try {
          const parsed = JSON.parse(serialized) as Partial<DeadLetterEntry>;
          const failedAtMs = Date.parse(String(parsed.failedAt || ''));
          if (Number.isFinite(failedAtMs) && failedAtMs <= nowMs) score = Math.floor(failedAtMs);
        } catch {
          // Preserve malformed legacy entries for one bounded retention window.
        }
        values.push(serialized, score);
      }
      values.push(cutoffMs, DEAD_LETTER_MAX_ENTRIES);
      const migrated = await this.client.eval<number>(
        MIGRATE_LEGACY_DEAD_LETTERS_SCRIPT,
        2,
        [legacyKey, this.keyDeadLetterByAge()],
        values
      );
      if (Number(migrated) === 1) return;
    }

    throw new Error('DLQ_LEGACY_MIGRATION_CONFLICT');
  }

  private keyIdempotency(hash: string) {
    return `${this.prefix}:idempotency:${hash}`;
  }

  private keyRateLimit(ipKey: string) {
    return `${this.prefix}:ratelimit:${ipKey}`;
  }

  private keyLeadRecord(leadId: string) {
    return `${this.prefix}:record:${leadId}`;
  }

  private keyQueue() {
    return `${this.prefix}:delivery:queue`;
  }

  private keyPendingSince() {
    return `${this.prefix}:delivery:pending-since`;
  }

  private keyProcessingLock(leadId: string) {
    return `${this.prefix}:delivery:lock:${leadId}`;
  }

  private keyDeliveryClaim(leadId: string) {
    return `${this.prefix}:delivery:claim:${leadId}`;
  }

  private keyDeliveryFence(leadId: string) {
    return `${this.prefix}:delivery:fence:${leadId}`;
  }

  private keyDeadLetterLegacy() {
    return `${this.prefix}:delivery:dlq`;
  }

  private keyDeadLetterByAge() {
    return `${this.prefix}:delivery:dlq:v2`;
  }

  private keyMetricCounter(metricName: string) {
    return `${this.prefix}:metrics:counter:${metricName}`;
  }

  private keyMetricAttemptEvents() {
    return `${this.prefix}:metrics:event:attempt`;
  }

  private keyMetricRetryEvents() {
    return `${this.prefix}:metrics:event:retry`;
  }

  private keyMetricDlqEvents() {
    return `${this.prefix}:metrics:event:dlq`;
  }

  private keyMetricLatencyEvents() {
    return `${this.prefix}:metrics:event:latency`;
  }
}

type MemoryIdempotencyEntry = {
  response: ContactSuccessResponse;
  payloadFingerprint: string;
  expiresAt: number;
};

type MemoryRateLimitEntry = {
  count: number;
  expiresAt: number;
};

type MemoryLeadRecordEntry = {
  leadRecord: LeadRecord;
  expiresAt: number | null;
};

type MemoryProcessingLockEntry = {
  token: string;
  expiresAtMs: number;
};

type MemoryDeliveryFenceEntry = {
  deliveredAtIso: string;
  expiresAtMs: number | null;
};

class MemoryLeadStore implements LeadStore {
  mode = 'memory' as const;
  hasDurableStorage = false;

  private readonly idempotency = new Map<string, MemoryIdempotencyEntry>();
  private readonly rateLimit = new Map<string, MemoryRateLimitEntry>();
  private readonly leadRecords = new Map<string, MemoryLeadRecordEntry>();
  private readonly queue = new Map<string, number>();
  private readonly processingLocks = new Map<string, MemoryProcessingLockEntry>();
  private readonly deliveryClaims = new Map<string, MemoryProcessingLockEntry>();
  private readonly deliveryFences = new Map<string, MemoryDeliveryFenceEntry>();
  private readonly deadLetters: Array<{ entry: DeadLetterEntry; expiresAtMs: number }> = [];
  private readonly attemptEventTimestamps: number[] = [];
  private readonly retryEventTimestamps: number[] = [];
  private readonly dlqEventTimestamps: number[] = [];
  private readonly latencyEvents: Array<{ ts: number; latencyMs: number }> = [];
  private readonly counters = {
    delivery_success_total: 0,
    delivery_retry_total: 0,
    delivery_failed_total: 0,
    delivery_dlq_total: 0,
  };

  async ping(): Promise<{ ok: boolean; code: string; circuitOpen: boolean }> {
    return {
      ok: true,
      code: 'MEMORY_STORE',
      circuitOpen: false,
    };
  }

  async checkRateLimit(ipKey: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const now = Date.now();
    const current = this.rateLimit.get(ipKey);
    if (!current || current.expiresAt <= now) {
      const expiresAt = now + windowSec * 1000;
      this.rateLimit.set(ipKey, { count: 1, expiresAt });
      return {
        allowed: true,
        count: 1,
        retryAfterSec: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
      };
    }

    current.count += 1;
    this.rateLimit.set(ipKey, current);
    return {
      allowed: current.count <= limit,
      count: current.count,
      retryAfterSec: Math.max(0, Math.ceil((current.expiresAt - now) / 1000)),
    };
  }

  async enqueueLeadWithIdempotency(params: {
    idempotencyHash: string;
    idempotencyTtlSec: number;
    successResponse: ContactSuccessResponse;
    leadRecord: LeadRecord;
    leadRecordTtlSec: number;
  }): Promise<EnqueueLeadResult> {
    const now = Date.now();
    const current = this.idempotency.get(params.idempotencyHash);
    if (current && current.expiresAt > now) {
      if (current.payloadFingerprint !== params.leadRecord.payloadFingerprint) {
        return { duplicate: false, conflict: true };
      }
      return { duplicate: true, response: { ...current.response, duplicate: true } };
    }

    this.idempotency.set(params.idempotencyHash, {
      response: params.successResponse,
      payloadFingerprint: params.leadRecord.payloadFingerprint,
      expiresAt: now + params.idempotencyTtlSec * 1000,
    });

    const expiresAt = params.leadRecordTtlSec > 0 ? now + params.leadRecordTtlSec * 1000 : null;
    this.leadRecords.set(params.leadRecord.leadId, {
      leadRecord: params.leadRecord,
      expiresAt,
    });
    this.queue.set(params.leadRecord.leadId, params.leadRecord.nextRetryAt);

    return { duplicate: false };
  }

  async getLeadRecord(leadId: string): Promise<LeadRecord | null> {
    const now = Date.now();
    const current = this.leadRecords.get(leadId);
    if (!current) return null;
    if (current.expiresAt !== null && current.expiresAt <= now) {
      this.leadRecords.delete(leadId);
      this.queue.delete(leadId);
      return null;
    }
    return current.leadRecord;
  }

  async saveLeadRecord(leadRecord: LeadRecord, leadRecordTtlSec: number): Promise<void> {
    const now = Date.now();
    this.leadRecords.set(leadRecord.leadId, {
      leadRecord,
      expiresAt: leadRecordTtlSec > 0 ? now + leadRecordTtlSec * 1000 : null,
    });
  }

  async listDueLeadIds(nowMs: number, limit: number): Promise<string[]> {
    const dueEntries = Array.from(this.queue.entries())
      .filter(([leadId, dueAt]) => {
        if (dueAt > nowMs) return false;
        const current = this.leadRecords.get(leadId);
        if (!current) return false;
        if (current.expiresAt !== null && current.expiresAt <= Date.now()) {
          this.leadRecords.delete(leadId);
          this.queue.delete(leadId);
          return false;
        }
        return true;
      })
      .sort((a, b) => a[1] - b[1]);

    return dueEntries.slice(0, limit).map(([leadId]) => leadId);
  }

  async scheduleLead(leadId: string, dueAtMs: number): Promise<void> {
    this.queue.set(leadId, dueAtMs);
  }

  async acquireProcessingLock(leadId: string, ttlSec: number): Promise<string | null> {
    const nowMs = Date.now();
    this.cleanupProcessingLocks(nowMs);
    const currentLock = this.processingLocks.get(leadId);
    if (currentLock && currentLock.expiresAtMs > nowMs) {
      return null;
    }

    const normalizedTtlSec = Math.max(1, Number.isFinite(ttlSec) ? Math.floor(ttlSec) : 1);
    const token = randomUUID();
    this.processingLocks.set(leadId, {
      token,
      expiresAtMs: nowMs + normalizedTtlSec * 1000,
    });
    return token;
  }

  async renewProcessingLock(leadId: string, token: string, ttlSec: number): Promise<boolean> {
    const nowMs = Date.now();
    this.cleanupProcessingLocks(nowMs);
    const current = this.processingLocks.get(leadId);
    if (!current) return false;
    if (current.token !== token) return false;
    if (current.expiresAtMs <= nowMs) {
      this.processingLocks.delete(leadId);
      return false;
    }
    const normalizedTtlSec = Math.max(1, Number.isFinite(ttlSec) ? Math.floor(ttlSec) : 1);
    this.processingLocks.set(leadId, {
      token,
      expiresAtMs: nowMs + normalizedTtlSec * 1000,
    });
    return true;
  }

  async releaseProcessingLock(leadId: string, token: string): Promise<void> {
    const nowMs = Date.now();
    this.cleanupProcessingLocks(nowMs);
    const current = this.processingLocks.get(leadId);
    if (!current) return;
    if (current.token !== token) return;
    this.processingLocks.delete(leadId);
  }

  async acquireDeliveryClaim(leadId: string, claimId: string, ttlSec: number): Promise<boolean> {
    const nowMs = Date.now();
    this.cleanupProcessingLocks(nowMs);
    const currentClaim = this.deliveryClaims.get(leadId);
    if (currentClaim && currentClaim.expiresAtMs > nowMs) {
      return false;
    }

    const normalizedTtlSec = Math.max(1, Number.isFinite(ttlSec) ? Math.floor(ttlSec) : 1);
    this.deliveryClaims.set(leadId, {
      token: claimId,
      expiresAtMs: nowMs + normalizedTtlSec * 1000,
    });
    return true;
  }

  async releaseDeliveryClaim(leadId: string, claimId: string): Promise<void> {
    const nowMs = Date.now();
    this.cleanupProcessingLocks(nowMs);
    const current = this.deliveryClaims.get(leadId);
    if (!current) return;
    if (current.token !== claimId) return;
    this.deliveryClaims.delete(leadId);
  }

  async markDeliveryFence(leadId: string, deliveredAtIso: string, ttlSec: number): Promise<void> {
    const normalized = String(deliveredAtIso || '').trim() || new Date().toISOString();
    const nowMs = Date.now();
    this.deliveryFences.set(leadId, {
      deliveredAtIso: normalized,
      expiresAtMs: ttlSec > 0 ? nowMs + Math.floor(ttlSec) * 1000 : null,
    });
  }

  async getDeliveryFence(leadId: string): Promise<string | null> {
    const nowMs = Date.now();
    this.cleanupDeliveryFences(nowMs);
    const entry = this.deliveryFences.get(leadId);
    if (!entry) return null;
    return entry.deliveredAtIso;
  }

  async commitDeliveredIfClaimOwned(params: {
    leadId: string;
    claimId: string;
    deliveredAtIso: string;
    deliveredRecord: LeadRecord;
    leadRecordTtlSec: number;
  }): Promise<DeliveryCommitResult> {
    const nowMs = Date.now();
    this.cleanupProcessingLocks(nowMs);
    this.cleanupDeliveryFences(nowMs);

    const existingFence = this.deliveryFences.get(params.leadId);
    const currentClaim = this.deliveryClaims.get(params.leadId);
    if (!currentClaim || currentClaim.token !== params.claimId) {
      return existingFence
        ? {
            status: 'fence_exists',
            deliveredAtIso: existingFence.deliveredAtIso,
          }
        : {
            status: 'claim_missing',
            deliveredAtIso: null,
          };
    }

    const expiresAt = params.leadRecordTtlSec > 0 ? nowMs + params.leadRecordTtlSec * 1000 : null;
    this.leadRecords.set(params.leadId, {
      leadRecord: params.deliveredRecord,
      expiresAt,
    });
    this.deliveryFences.set(params.leadId, {
      deliveredAtIso: params.deliveredAtIso,
      expiresAtMs: expiresAt,
    });
    this.queue.delete(params.leadId);
    this.deliveryClaims.delete(params.leadId);

    return {
      status: 'committed',
      deliveredAtIso: params.deliveredAtIso,
    };
  }

  async removeFromSchedule(leadId: string): Promise<void> {
    this.queue.delete(leadId);
  }

  async getQueueDepth(): Promise<number> {
    const nowMs = Date.now();
    for (const [leadId, dueAt] of this.queue.entries()) {
      void dueAt;
      const current = this.leadRecords.get(leadId);
      if (!current) {
        this.queue.delete(leadId);
        continue;
      }
      if (current.expiresAt !== null && current.expiresAt <= nowMs) {
        this.leadRecords.delete(leadId);
        this.queue.delete(leadId);
      }
    }
    return this.queue.size;
  }

  async pushDeadLetter(entry: DeadLetterEntry, ttlSec: number): Promise<void> {
    const nowMs = Date.now();
    const failedAtMs = Date.parse(entry.failedAt);
    const createdAtMs = Number.isFinite(failedAtMs) && failedAtMs <= nowMs ? failedAtMs : nowMs;
    this.deadLetters.unshift({
      entry,
      expiresAtMs: createdAtMs + Math.max(1, Math.floor(ttlSec)) * 1000,
    });
    await this.pruneDeadLetters(nowMs, ttlSec);
    if (this.deadLetters.length > 1000) {
      this.deadLetters.length = 1000;
    }
  }

  async pruneDeadLetters(nowMs: number, ttlSec: number): Promise<void> {
    void ttlSec;
    const normalizedNowMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    for (let index = this.deadLetters.length - 1; index >= 0; index -= 1) {
      if ((this.deadLetters[index]?.expiresAtMs || 0) <= normalizedNowMs) this.deadLetters.splice(index, 1);
    }
  }

  async recordDeliveryMetric(metric: DeliveryAttemptMetric): Promise<void> {
    const nowMs = Number.isFinite(metric.timestampMs) ? Math.floor(metric.timestampMs) : Date.now();
    const retentionCutoff = nowMs - METRICS_RETENTION_SEC * 1000;

    if (metric.status === 'dlq') {
      this.counters.delivery_dlq_total += 1;
      this.dlqEventTimestamps.push(nowMs);
      this.pruneMetrics(retentionCutoff);
      return;
    }

    if (metric.status === 'success') {
      this.counters.delivery_success_total += 1;
    } else if (metric.status === 'retry') {
      this.counters.delivery_retry_total += 1;
      this.retryEventTimestamps.push(nowMs);
    } else if (metric.status === 'failed') {
      this.counters.delivery_failed_total += 1;
    }

    this.attemptEventTimestamps.push(nowMs);
    if (typeof metric.latencyMs === 'number' && Number.isFinite(metric.latencyMs) && metric.latencyMs >= 0) {
      this.latencyEvents.push({
        ts: nowMs,
        latencyMs: Math.floor(metric.latencyMs),
      });
    }

    this.pruneMetrics(retentionCutoff);
  }

  async getLeadPipelineHealth(nowMs = Date.now()): Promise<LeadPipelineHealth> {
    const hourAgoMs = nowMs - 60 * 60 * 1000;
    const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
    const retentionCutoff = nowMs - METRICS_RETENTION_SEC * 1000;
    this.pruneMetrics(retentionCutoff);

    const attemptsLastHour = countValuesSince(this.attemptEventTimestamps, hourAgoMs);
    const retriesLastHour = countValuesSince(this.retryEventTimestamps, hourAgoMs);
    const dlqLastHour = countValuesSince(this.dlqEventTimestamps, hourAgoMs);
    const dlqLast24Hours = countValuesSince(this.dlqEventTimestamps, dayAgoMs);
    const latencies = this.latencyEvents
      .filter((entry) => entry.ts >= hourAgoMs)
      .map((entry) => entry.latencyMs)
      .filter((value) => Number.isFinite(value) && value >= 0);

    return {
      retryRateLastHour: attemptsLastHour > 0 ? retriesLastHour / attemptsLastHour : 0,
      dlqLastHour,
      dlqLast24Hours,
      p95LatencyMs: computePercentile(latencies, 95),
      queueDepth: await this.getQueueDepth(),
      counters: {
        ...this.counters,
      },
      generatedAtMs: nowMs,
    };
  }

  private pruneMetrics(cutoffMs: number): void {
    pruneSortedTimestamps(this.attemptEventTimestamps, cutoffMs);
    pruneSortedTimestamps(this.retryEventTimestamps, cutoffMs);
    pruneSortedTimestamps(this.dlqEventTimestamps, cutoffMs);
    while (this.latencyEvents.length > 0 && this.latencyEvents[0]?.ts < cutoffMs) {
      this.latencyEvents.shift();
    }
  }

  private cleanupProcessingLocks(nowMs: number): void {
    for (const [leadId, entry] of this.processingLocks.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.processingLocks.delete(leadId);
      }
    }
    for (const [leadId, entry] of this.deliveryClaims.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.deliveryClaims.delete(leadId);
      }
    }
  }

  private cleanupDeliveryFences(nowMs: number): void {
    for (const [leadId, entry] of this.deliveryFences.entries()) {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs) {
        this.deliveryFences.delete(leadId);
      }
    }
  }
}

function parseCounter(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function computePercentile(values: number[], percentile: number): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((Math.max(0, Math.min(100, percentile)) / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index] ?? null;
}

function countValuesSince(timestamps: number[], thresholdMs: number): number {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return 0;
  let index = timestamps.length - 1;
  while (index >= 0 && timestamps[index] >= thresholdMs) {
    index -= 1;
  }
  return timestamps.length - (index + 1);
}

function pruneSortedTimestamps(timestamps: number[], cutoffMs: number): void {
  while (timestamps.length > 0 && timestamps[0] < cutoffMs) {
    timestamps.shift();
  }
}

const memoryStoreSingleton = new MemoryLeadStore();

let leadStoreSingleton: LeadStore | undefined;
let warnedAboutMemoryStore = false;

function parseContactSuccessResponse(raw: unknown): ContactSuccessResponse | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as ContactSuccessResponse;
    if (
      parsed &&
      parsed.success === true &&
      typeof parsed.leadId === 'string' &&
      typeof parsed.receivedAt === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function parseLeadRecord(raw: unknown): LeadRecord | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as LeadRecord;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.leadId !== 'string' || typeof parsed.status !== 'string') return null;
    if (!parsed.webhookPayload || typeof parsed.webhookPayload !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function resolveLeadRedisPrefix(rawValue = process.env.CONTACT_REDIS_PREFIX): string {
  const value = (rawValue || '').trim();
  if (!value) return 'lead';
  return value.replace(/[^a-zA-Z0-9:_-]/g, '-');
}

export function hasRedisLeadStoreConfig(): boolean {
  return hasRedisConfig();
}

export function getLeadStore(): LeadStore {
  if (leadStoreSingleton) {
    return leadStoreSingleton;
  }

  const prefix = resolveLeadRedisPrefix();

  if (hasRedisConfig()) {
    leadStoreSingleton = new RedisLeadStore(new NativeRedisClient(resolveRedisClientOptions()), prefix);
    return leadStoreSingleton;
  }

  if (import.meta.env.PROD) {
    throw new Error('REDIS_NOT_CONFIGURED');
  }

  if (!warnedAboutMemoryStore) {
    warnedAboutMemoryStore = true;
    console.warn('[lead-store] Redis is not configured; using in-memory development fallback.');
  }

  leadStoreSingleton = memoryStoreSingleton;
  return leadStoreSingleton;
}
