export type ContactSuccessResponse = {
  success: true;
  leadId: string;
  receivedAt: string;
  duplicate?: boolean;
};

export type LeadStatus = 'pending' | 'delivered' | 'failed';

export type LeadRecord = {
  leadId: string;
  receivedAt: string;
  idempotencyHash: string;
  payloadFingerprint: string;
  webhookPayload: Record<string, unknown>;
  status: LeadStatus;
  retryCount: number;
  nextRetryAt: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  lastAttemptAt?: string;
  lastErrorCode?: string;
  lastErrorStatus?: number;
  lastErrorMessage?: string;
};

export type DeadLetterEntry = {
  leadId: string;
  failedAt: string;
  retryCount: number;
  maxRetries: number;
  errorCode: string;
  errorStatus?: number;
  errorMessage?: string;
  webhookPayload: Record<string, unknown>;
};

export type DeliveryMetricStatus = 'success' | 'retry' | 'failed' | 'dlq';

export type DeliveryAttemptMetric = {
  leadId: string;
  status: DeliveryMetricStatus;
  timestampMs: number;
  attempt?: number;
  retryCount?: number;
  latencyMs?: number;
};

export type LeadPipelineCounters = {
  delivery_success_total: number;
  delivery_retry_total: number;
  delivery_failed_total: number;
  delivery_dlq_total: number;
};

export type LeadPipelineHealth = {
  retryRateLastHour: number;
  dlqLastHour: number;
  dlqLast24Hours: number;
  p95LatencyMs: number | null;
  queueDepth: number | null;
  counters: LeadPipelineCounters;
  generatedAtMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
};

export type EnqueueLeadResult =
  | {
      duplicate: false;
    }
  | {
      duplicate: true;
      response: ContactSuccessResponse;
    };

export type DeliveryCommitResult = {
  status: 'committed' | 'fence_exists' | 'claim_missing';
  deliveredAtIso: string | null;
};
