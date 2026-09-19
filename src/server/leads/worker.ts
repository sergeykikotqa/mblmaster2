import { notifyLeadDeadLetter, notifyLeadRetryRateWarning } from './alerts';
import { recordFallbackDeliveryMetric } from './metrics-fallback';
import { recordWorkerCycleHeartbeat, toWorkerHeartbeatErrorCode } from './runtime-health';
import { getLeadStore, type LeadStore } from './store';
import type { DeadLetterEntry, DeliveryAttemptMetric, LeadRecord } from './types';
import { deliverLeadWebhook } from './webhook';
import { parseBooleanEnv } from '~/server/utils/auth';

export type ProcessLeadQueueResult = {
  processed: number;
  delivered: number;
  retried: number;
  failed: number;
  deadLettered: number;
  skipped: number;
  paused?: boolean;
};

const DEFAULT_WORKER_BATCH_SIZE = 20;
const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_RETRY_BASE_DELAY_SEC = 30;
const DEFAULT_LEAD_RECORD_TTL_SEC = 60 * 60 * 24 * 30;
const DEFAULT_DEAD_LETTER_TTL_SEC = 60 * 60 * 24 * 30;
const DEFAULT_RETRY_RATE_ALERT_THRESHOLD = 0.1;
const DEFAULT_RETRY_RATE_ALERT_COOLDOWN_SEC = 600;
const DEFAULT_WORKER_PROCESSING_LOCK_TTL_SEC = 120;
const DEFAULT_WORKER_DELIVERY_CLAIM_TTL_SEC = 180;

let lastRetryRateAlertAtMs = 0;

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function getWorkerBatchSize(limitOverride?: number): number {
  const configValue = parsePositiveInt(process.env.CONTACT_WORKER_BATCH_SIZE, DEFAULT_WORKER_BATCH_SIZE, 1);
  if (typeof limitOverride !== 'number' || !Number.isFinite(limitOverride)) return configValue;
  return Math.min(100, Math.max(1, Math.floor(limitOverride)));
}

function getMaxRetries(): number {
  return parsePositiveInt(process.env.CONTACT_DELIVERY_MAX_RETRIES, DEFAULT_MAX_RETRIES, 1);
}

function getRetryBaseDelaySec(): number {
  return parsePositiveInt(process.env.CONTACT_RETRY_BASE_DELAY_SEC, DEFAULT_RETRY_BASE_DELAY_SEC, 1);
}

function getLeadRecordTtlSec(): number {
  return parsePositiveInt(process.env.CONTACT_LEAD_RECORD_TTL_SEC, DEFAULT_LEAD_RECORD_TTL_SEC, 0);
}

function getDeadLetterTtlSec(): number {
  return parsePositiveInt(process.env.CONTACT_DLQ_TTL_SEC, DEFAULT_DEAD_LETTER_TTL_SEC, 0);
}

function getWorkerProcessingLockTtlSec(): number {
  return parsePositiveInt(
    process.env.CONTACT_WORKER_PROCESSING_LOCK_TTL_SEC,
    DEFAULT_WORKER_PROCESSING_LOCK_TTL_SEC,
    5
  );
}

function getWorkerDeliveryClaimTtlSec(): number {
  return parsePositiveInt(process.env.CONTACT_WORKER_DELIVERY_CLAIM_TTL_SEC, DEFAULT_WORKER_DELIVERY_CLAIM_TTL_SEC, 5);
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function getRetryRateAlertThreshold(): number {
  return parseNonNegativeNumber(process.env.CONTACT_RETRY_RATE_ALERT_THRESHOLD, DEFAULT_RETRY_RATE_ALERT_THRESHOLD);
}

function getRetryRateAlertCooldownMs(): number {
  const seconds = parsePositiveInt(
    process.env.CONTACT_RETRY_RATE_ALERT_COOLDOWN_SEC,
    DEFAULT_RETRY_RATE_ALERT_COOLDOWN_SEC,
    60
  );
  return seconds * 1000;
}

function computeRetryDelayMs(nextRetryCount: number): number {
  const baseDelaySec = getRetryBaseDelaySec();
  return Math.pow(2, Math.max(0, nextRetryCount - 1)) * baseDelaySec * 1000;
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export function isLeadWorkerPaused(): boolean {
  return parseBooleanEnv(process.env.CONTACT_WORKER_PAUSED, false);
}

function createEmptyProcessLeadQueueResult(paused = false): ProcessLeadQueueResult {
  return {
    processed: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
    ...(paused ? { paused: true } : {}),
  };
}

function markAttempt(record: LeadRecord, nowMs: number): LeadRecord {
  return {
    ...record,
    lastAttemptAt: nowIso(nowMs),
    updatedAt: nowIso(nowMs),
  };
}

function withDeliveryMetadata(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const currentDelivery =
    payload.delivery && typeof payload.delivery === 'object' && !Array.isArray(payload.delivery)
      ? payload.delivery
      : {};

  return {
    ...payload,
    delivery: {
      ...currentDelivery,
      ...metadata,
    },
  };
}

function emitLeadEvent(
  event: string,
  payload: Record<string, unknown>,
  level: 'info' | 'warn' | 'error' = 'info'
): void {
  const line = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  });

  if (level === 'error') {
    console.error(line);
    return;
  }

  if (level === 'warn') {
    console.warn(line);
    return;
  }

  console.log(line);
}

function isTerminalDeliveryFailure(code: string | undefined): boolean {
  return code === 'WEBHOOK_NOT_CONFIGURED' || code === 'WEBHOOK_SECRET_NOT_CONFIGURED' || code === 'WEBHOOK_ID_MISSING';
}

async function recordDeliveryMetricSafely(store: LeadStore, metric: DeliveryAttemptMetric): Promise<void> {
  try {
    await store.recordDeliveryMetric(metric);
  } catch (error) {
    recordFallbackDeliveryMetric(metric);
    emitLeadEvent(
      'lead_metric_write_failed',
      {
        leadId: metric.leadId,
        status: metric.status,
        code: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN',
      },
      'warn'
    );
  }
}

async function maybeNotifyRetryRateWarning(store: LeadStore): Promise<void> {
  const nowMs = Date.now();
  const cooldownMs = getRetryRateAlertCooldownMs();
  if (nowMs - lastRetryRateAlertAtMs < cooldownMs) {
    return;
  }

  const threshold = getRetryRateAlertThreshold();
  const health = await store.getLeadPipelineHealth(nowMs);
  if (health.retryRateLastHour < threshold) {
    return;
  }

  const alertSent = await notifyLeadRetryRateWarning({
    retryRateLastHour: health.retryRateLastHour,
    retryRateThreshold: threshold,
    dlqLastHour: health.dlqLastHour,
    dlqLast24Hours: health.dlqLast24Hours,
    p95LatencyMs: health.p95LatencyMs,
    generatedAtMs: health.generatedAtMs,
  });

  if (alertSent) {
    lastRetryRateAlertAtMs = nowMs;
  }

  emitLeadEvent(
    'lead_retry_rate_warning',
    {
      retryRateLastHour: Number(health.retryRateLastHour.toFixed(4)),
      retryRateThreshold: Number(threshold.toFixed(4)),
      dlqLastHour: health.dlqLastHour,
      dlqLast24Hours: health.dlqLast24Hours,
      p95LatencyMs: health.p95LatencyMs,
      alertSent,
    },
    alertSent ? 'warn' : 'error'
  );
}

async function processLeadQueueCycle(limitOverride?: number): Promise<ProcessLeadQueueResult> {
  if (isLeadWorkerPaused()) {
    emitLeadEvent('lead_worker_paused', {
      limitOverride: typeof limitOverride === 'number' ? limitOverride : undefined,
    });
    return createEmptyProcessLeadQueueResult(true);
  }

  const store = getLeadStore();
  const nowMs = Date.now();
  const dueLeadIds = await store.listDueLeadIds(nowMs, getWorkerBatchSize(limitOverride));
  const maxRetries = getMaxRetries();
  const leadRecordTtlSec = getLeadRecordTtlSec();

  const result = createEmptyProcessLeadQueueResult(false);

  for (const leadId of dueLeadIds) {
    result.processed += 1;
    const lockTtlSec = getWorkerProcessingLockTtlSec();
    const lockToken = await store.acquireProcessingLock(leadId, lockTtlSec);
    if (!lockToken) {
      result.skipped += 1;
      continue;
    }

    const renewIntervalMs = Math.max(1000, Math.floor((lockTtlSec * 1000) / 3));
    let lockLost = false;
    let renewInFlight = false;
    let lockLostStage = '';
    const renewLock = async (stage: string): Promise<boolean> => {
      if (lockLost) return false;
      try {
        const renewed = await store.renewProcessingLock(leadId, lockToken, lockTtlSec);
        if (renewed) return true;
        lockLost = true;
        lockLostStage = stage;
        emitLeadEvent(
          'lead_lock_lost',
          {
            leadId,
            stage,
            lockTtlSec,
          },
          'warn'
        );
        return false;
      } catch (error) {
        lockLost = true;
        lockLostStage = stage;
        emitLeadEvent(
          'lead_lock_renew_failed',
          {
            leadId,
            stage,
            lockTtlSec,
            code: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN',
          },
          'warn'
        );
        return false;
      }
    };
    const renewTimer = setInterval(() => {
      if (lockLost || renewInFlight) return;
      renewInFlight = true;
      void renewLock('heartbeat').finally(() => {
        renewInFlight = false;
      });
    }, renewIntervalMs);
    if (typeof (renewTimer as { unref?: () => void }).unref === 'function') {
      (renewTimer as { unref: () => void }).unref();
    }

    try {
      if (!(await renewLock('before_read'))) {
        result.skipped += 1;
        continue;
      }

      const current = await store.getLeadRecord(leadId);
      if (!current) {
        await store.removeFromSchedule(leadId);
        result.skipped += 1;
        continue;
      }

      if (current.status === 'delivered' || current.status === 'failed') {
        await store.removeFromSchedule(leadId);
        result.skipped += 1;
        continue;
      }

      const commitDeliveredFromFence = async (
        deliveredAtIso: string,
        reason: string,
        baseRecord: LeadRecord = current,
        deliveredWebhookPayload: Record<string, unknown> = baseRecord.webhookPayload
      ): Promise<void> => {
        const recoveredRecord: LeadRecord = {
          ...baseRecord,
          webhookPayload: deliveredWebhookPayload,
          status: 'delivered',
          deliveredAt: deliveredAtIso,
          updatedAt: nowIso(Date.now()),
          lastErrorCode: undefined,
          lastErrorStatus: undefined,
          lastErrorMessage: undefined,
        };
        await store.saveLeadRecord(recoveredRecord, leadRecordTtlSec);
        await store.removeFromSchedule(leadId);
        await recordDeliveryMetricSafely(store, {
          leadId,
          status: 'success',
          timestampMs: Date.now(),
          attempt: current.retryCount + 1,
          retryCount: current.retryCount,
        });
        emitLeadEvent('lead_delivery_fence_recovered', {
          leadId,
          reason,
          deliveredAt: deliveredAtIso,
          retryCount: current.retryCount,
        });
        result.delivered += 1;
      };

      const existingFence = await store.getDeliveryFence(leadId);
      if (existingFence) {
        await commitDeliveredFromFence(existingFence, 'fence_already_set');
        continue;
      }

      const attemptedRecord = markAttempt(current, Date.now());
      const attemptNumber = attemptedRecord.retryCount + 1;
      const webhookPayload = withDeliveryMetadata(current.webhookPayload, {
        attempt: attemptNumber,
        retryCount: attemptedRecord.retryCount,
        maxRetries,
        retryBaseDelaySec: getRetryBaseDelaySec(),
        workerProcessedAt: attemptedRecord.lastAttemptAt || nowIso(Date.now()),
      });
      if (!(await renewLock('before_delivery'))) {
        result.skipped += 1;
        continue;
      }
      const deliveryClaimId = `${lockToken}:${attemptNumber}`;
      const deliveryClaimTtlSec = getWorkerDeliveryClaimTtlSec();
      const claimAcquired = await store.acquireDeliveryClaim(leadId, deliveryClaimId, deliveryClaimTtlSec);
      if (!claimAcquired) {
        const fenceAfterClaimMiss = await store.getDeliveryFence(leadId);
        if (fenceAfterClaimMiss) {
          await commitDeliveredFromFence(fenceAfterClaimMiss, 'claim_held_by_other_worker_with_fence');
          continue;
        }
        emitLeadEvent(
          'lead_delivery_claim_skipped',
          {
            leadId,
            attempt: attemptNumber,
            claimTtlSec: deliveryClaimTtlSec,
          },
          'warn'
        );
        result.skipped += 1;
        continue;
      }

      let deliveryClaimOwned = true;
      const releaseDeliveryClaim = async (stage: string): Promise<void> => {
        if (!deliveryClaimOwned) return;
        deliveryClaimOwned = false;
        try {
          await store.releaseDeliveryClaim(leadId, deliveryClaimId);
        } catch (error) {
          emitLeadEvent(
            'lead_delivery_claim_release_failed',
            {
              leadId,
              stage,
              code: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN',
            },
            'warn'
          );
        }
      };

      try {
        const attemptStartedAtMs = Date.now();
        const delivery = await deliverLeadWebhook(webhookPayload);
        const attemptCompletedAtMs = Date.now();
        const latencyMs = Math.max(0, attemptCompletedAtMs - attemptStartedAtMs);

        if (delivery.ok) {
          const deliveredAtIso = nowIso(Date.now());
          if (!(await renewLock('before_commit_success'))) {
            result.skipped += 1;
            continue;
          }
          const deliveredRecord: LeadRecord = {
            ...attemptedRecord,
            webhookPayload,
            status: 'delivered',
            deliveredAt: deliveredAtIso,
            lastErrorCode: undefined,
            lastErrorStatus: undefined,
            lastErrorMessage: undefined,
          };
          const commitResult = await store.commitDeliveredIfClaimOwned({
            leadId,
            claimId: deliveryClaimId,
            deliveredAtIso,
            deliveredRecord,
            leadRecordTtlSec,
          });
          deliveryClaimOwned = false;
          if (commitResult.status === 'fence_exists') {
            await commitDeliveredFromFence(
              commitResult.deliveredAtIso || deliveredAtIso,
              'commit_fence_exists',
              attemptedRecord,
              webhookPayload
            );
            continue;
          }
          if (commitResult.status === 'claim_missing') {
            emitLeadEvent(
              'lead_delivery_commit_skipped',
              {
                leadId,
                attempt: attemptNumber,
                status: commitResult.status,
              },
              'warn'
            );
            result.skipped += 1;
            continue;
          }
          await recordDeliveryMetricSafely(store, {
            leadId,
            status: 'success',
            timestampMs: attemptCompletedAtMs,
            attempt: attemptNumber,
            retryCount: attemptedRecord.retryCount,
            latencyMs,
          });
          emitLeadEvent('lead_delivery_attempt', {
            leadId,
            attempt: attemptNumber,
            status: 'success',
            latency_ms: latencyMs,
            retryCount: attemptedRecord.retryCount,
          });
          result.delivered += 1;
          continue;
        }

        const nextRetryCount = attemptedRecord.retryCount + 1;
        const terminalFailure = nextRetryCount >= maxRetries || isTerminalDeliveryFailure(delivery.code);
        if (terminalFailure) {
          if (!(await renewLock('before_commit_failure'))) {
            result.skipped += 1;
            continue;
          }
          const failedRecord: LeadRecord = {
            ...attemptedRecord,
            webhookPayload,
            status: 'failed',
            retryCount: nextRetryCount,
            lastErrorCode: delivery.code,
            lastErrorStatus: delivery.status,
            lastErrorMessage: delivery.message,
          };
          await store.saveLeadRecord(failedRecord, leadRecordTtlSec);
          await store.removeFromSchedule(leadId);
          await recordDeliveryMetricSafely(store, {
            leadId,
            status: 'failed',
            timestampMs: attemptCompletedAtMs,
            attempt: attemptNumber,
            retryCount: nextRetryCount,
            latencyMs,
          });
          const deadLetterEntry: DeadLetterEntry = {
            leadId,
            failedAt: nowIso(Date.now()),
            retryCount: nextRetryCount,
            maxRetries,
            errorCode: delivery.code,
            errorStatus: delivery.status,
            errorMessage: delivery.message,
            webhookPayload,
          };
          await store.pushDeadLetter(deadLetterEntry, getDeadLetterTtlSec());
          await recordDeliveryMetricSafely(store, {
            leadId,
            status: 'dlq',
            timestampMs: Date.now(),
            attempt: attemptNumber,
            retryCount: nextRetryCount,
          });

          const finalStatus =
            delivery.code === 'WEBHOOK_NOT_CONFIGURED'
              ? 'webhook_not_configured'
              : delivery.code === 'WEBHOOK_SECRET_NOT_CONFIGURED'
                ? 'webhook_secret_not_configured'
                : delivery.code === 'WEBHOOK_ID_MISSING'
                  ? 'webhook_id_missing'
                  : 'max_retries_exceeded';
          const alertSent = await notifyLeadDeadLetter({
            leadId,
            failedAt: deadLetterEntry.failedAt,
            attempts: nextRetryCount,
            maxRetries,
            finalStatus,
            errorCode: delivery.code,
            errorStatus: delivery.status,
          });

          emitLeadEvent(
            'lead_delivery_attempt',
            {
              leadId,
              attempt: attemptNumber,
              status: 'failed',
              latency_ms: latencyMs,
              retryCount: nextRetryCount,
              errorCode: delivery.code,
              errorStatus: delivery.status,
            },
            'error'
          );
          emitLeadEvent('lead_dead_letter', {
            leadId,
            attempts: nextRetryCount,
            finalStatus,
            errorCode: delivery.code,
            errorStatus: delivery.status,
            alertSent,
          });
          result.failed += 1;
          result.deadLettered += 1;
          continue;
        }

        const nextRetryAt = Date.now() + computeRetryDelayMs(nextRetryCount);
        const retryRecord: LeadRecord = {
          ...attemptedRecord,
          webhookPayload,
          status: 'pending',
          retryCount: nextRetryCount,
          nextRetryAt,
          lastErrorCode: delivery.code,
          lastErrorStatus: delivery.status,
          lastErrorMessage: delivery.message,
        };

        if (!(await renewLock('before_commit_retry'))) {
          result.skipped += 1;
          continue;
        }
        await store.saveLeadRecord(retryRecord, leadRecordTtlSec);
        await store.scheduleLead(leadId, nextRetryAt);
        await recordDeliveryMetricSafely(store, {
          leadId,
          status: 'retry',
          timestampMs: attemptCompletedAtMs,
          attempt: attemptNumber,
          retryCount: nextRetryCount,
          latencyMs,
        });
        emitLeadEvent('lead_delivery_attempt', {
          leadId,
          attempt: attemptNumber,
          status: 'retry',
          latency_ms: latencyMs,
          retryCount: nextRetryCount,
          nextRetryAt,
          errorCode: delivery.code,
          errorStatus: delivery.status,
        });
        result.retried += 1;
      } finally {
        await releaseDeliveryClaim('attempt_finally');
      }
    } finally {
      clearInterval(renewTimer);
      try {
        await store.releaseProcessingLock(leadId, lockToken);
      } catch (error) {
        emitLeadEvent(
          'lead_lock_release_failed',
          {
            leadId,
            stage: lockLostStage || undefined,
            code: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN',
          },
          'warn'
        );
      }
    }
  }

  if (result.retried > 0 || result.failed > 0) {
    try {
      await maybeNotifyRetryRateWarning(store);
    } catch (error) {
      emitLeadEvent(
        'lead_retry_rate_warning_failed',
        {
          code: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN',
        },
        'warn'
      );
    }
  }

  return result;
}

async function recordHeartbeatWithoutChangingDelivery(
  input: Parameters<typeof recordWorkerCycleHeartbeat>[0]
): Promise<void> {
  try {
    await recordWorkerCycleHeartbeat(input);
  } catch (error) {
    emitLeadEvent(
      'lead_worker_heartbeat_write_failed',
      {
        code: toWorkerHeartbeatErrorCode(error),
      },
      'warn'
    );
  }
}

export async function processLeadQueue(limitOverride?: number): Promise<ProcessLeadQueueResult> {
  try {
    const result = await processLeadQueueCycle(limitOverride);
    await recordHeartbeatWithoutChangingDelivery({
      status: result.paused ? 'paused' : 'ok',
      processed: result.processed,
      delivered: result.delivered,
    });
    return result;
  } catch (error) {
    await recordHeartbeatWithoutChangingDelivery({
      status: 'error',
      processed: 0,
      delivered: 0,
      error,
    });
    throw error;
  }
}
