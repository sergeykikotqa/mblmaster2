export type ContactSuccessResponse = {
  success: true;
  leadId: string;
  receivedAt: string;
  duplicate?: boolean;
};

export type LeadStatus = 'pending' | 'delivered' | 'failed';

export type LeadConsent = {
  accepted: true;
  version: string;
  acceptedAt: string;
};

export type LeadBusinessContext = {
  service?: string;
  pageSlug?: string;
  placement?: string;
};

export type LeadNotification = {
  leadId: string;
  createdAt: string;
  service?: string;
  pageSlug?: string;
  adminPath: string;
};

export type LeadNotificationEnvelope = {
  schemaVersion: '1.0';
  event: 'lead.created';
  notification: LeadNotification;
  delivery?: {
    attempt: number;
    retryCount: number;
    maxRetries: number;
    retryBaseDelaySec: number;
    workerProcessedAt: string;
  };
};

export type LeadRecord = {
  leadId: string;
  normalizedPhone: string;
  receivedAt: string;
  idempotencyHash: string;
  payloadFingerprint: string;
  consent: LeadConsent;
  context: LeadBusinessContext;
  /** Internal delivery field; contains only the PII-free v2 notification envelope. */
  webhookPayload: LeadNotificationEnvelope;
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
  webhookPayload: LeadNotificationEnvelope;
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
      conflict?: false;
    }
  | {
      duplicate: true;
      conflict?: false;
      response: ContactSuccessResponse;
    }
  | {
      duplicate: false;
      conflict: true;
    };

export type DeliveryCommitResult = {
  status: 'committed' | 'fence_exists' | 'claim_missing';
  deliveredAtIso: string | null;
};
