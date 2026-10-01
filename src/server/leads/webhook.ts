import { createHmac } from 'crypto';
import type { LeadNotificationEnvelope } from './types';

export type WebhookConfig = {
  webhookUrl: string;
  webhookSecret: string;
  timeoutMs: number;
};

export type WebhookDeliveryResult =
  | {
      ok: true;
      status: number;
    }
  | {
      ok: false;
      code: string;
      status?: number;
      message?: string;
    };

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveWebhookTarget(
  rawUrl: string
): { ok: true; url: URL } | { ok: false; code: 'WEBHOOK_URL_INVALID' | 'WEBHOOK_INSECURE_TRANSPORT'; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      code: 'WEBHOOK_URL_INVALID',
      message: 'Contact webhook URL must be an absolute HTTPS URL',
    };
  }

  if (parsed.protocol === 'https:') return { ok: true, url: parsed };

  return {
    ok: false,
    code: parsed.protocol === 'http:' ? 'WEBHOOK_INSECURE_TRANSPORT' : 'WEBHOOK_URL_INVALID',
    message: 'Contact webhook delivery requires HTTPS',
  };
}

export function resolveWebhookConfig(): WebhookConfig {
  return {
    webhookUrl: (process.env.CONTACT_WEBHOOK_URL || process.env.CONTACT_WEBHOOK || '').trim(),
    webhookSecret: (process.env.CONTACT_WEBHOOK_SECRET || process.env.CONTACT_HMAC_SECRET || '').trim(),
    timeoutMs: parsePositiveInt(process.env.CONTACT_WEBHOOK_TIMEOUT_MS, 5000, 1000),
  };
}

export function isWebhookConfigured(): boolean {
  return Boolean(resolveWebhookConfig().webhookUrl);
}

export function hasWebhookSecretConfig(): boolean {
  return Boolean(resolveWebhookConfig().webhookSecret);
}

function resolveWebhookId(payload: LeadNotificationEnvelope): string {
  return typeof payload?.notification?.leadId === 'string' ? payload.notification.leadId.trim() : '';
}

export async function deliverLeadWebhook(payload: LeadNotificationEnvelope): Promise<WebhookDeliveryResult> {
  const { webhookUrl, webhookSecret, timeoutMs } = resolveWebhookConfig();
  if (!webhookUrl) {
    return {
      ok: false,
      code: 'WEBHOOK_NOT_CONFIGURED',
      message: 'CONTACT_WEBHOOK_URL is missing',
    };
  }

  const webhookTarget = resolveWebhookTarget(webhookUrl);
  if (!webhookTarget.ok) {
    return webhookTarget;
  }

  if (!webhookSecret) {
    return {
      ok: false,
      code: 'WEBHOOK_SECRET_NOT_CONFIGURED',
      message: 'CONTACT_WEBHOOK_SECRET is missing',
    };
  }

  const webhookId = resolveWebhookId(payload);
  if (!webhookId) {
    return {
      ok: false,
      code: 'WEBHOOK_ID_MISSING',
      message: 'notification.leadId is required for webhook signing',
    };
  }

  // Project a separate transport DTO; never serialize arbitrary stored fields
  // or a caller-provided toJSON/raw LeadRecord.
  const notification = payload.notification;
  const createdAt = notification.createdAt;
  const delivery = payload.delivery;
  if (
    typeof createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    (delivery &&
      (![delivery.attempt, delivery.retryCount, delivery.maxRetries, delivery.retryBaseDelaySec].every(
        (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ) ||
        typeof delivery.workerProcessedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(delivery.workerProcessedAt) ||
        !Number.isFinite(Date.parse(delivery.workerProcessedAt))))
  ) {
    return { ok: false, code: 'WEBHOOK_PAYLOAD_INVALID', message: 'Invalid notification metadata' };
  }
  const service = ['kuhni', 'shkafy', 'garderobnye', 'kitchen', 'wardrobe', 'closet'].includes(
    notification.service || ''
  )
    ? notification.service
    : undefined;
  const body = JSON.stringify({
    schemaVersion: '1.0',
    event: 'lead.created',
    notification: {
      leadId: webhookId,
      createdAt,
      adminPath: `/admin/leads/${webhookId}`,
      ...(service ? { service } : {}),
    },
    ...(payload.delivery
      ? {
          delivery: {
            attempt: payload.delivery.attempt,
            retryCount: payload.delivery.retryCount,
            maxRetries: payload.delivery.maxRetries,
            retryBaseDelaySec: payload.delivery.retryBaseDelaySec,
            workerProcessedAt: payload.delivery.workerProcessedAt,
          },
        }
      : {}),
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signaturePayload = `${timestamp}.${webhookId}.${body}`;
  const signature = createHmac('sha256', webhookSecret).update(signaturePayload).digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Source': 'website',
      'X-Webhook-Id': webhookId,
      'X-Webhook-Timestamp': timestamp,
      'X-Hub-Signature-256': `sha256=${signature}`,
    };

    const response = await fetch(webhookTarget.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        code: 'WEBHOOK_REDIRECT_BLOCKED',
        status: response.status,
        message: 'Contact webhook redirects are not allowed',
      };
    }

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
      };
    }

    return {
      ok: false,
      code: `HTTP_${response.status}`,
      status: response.status,
      message: 'Webhook rejected notification',
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: aborted ? 'Webhook request timed out' : 'Webhook network error',
    };
  } finally {
    clearTimeout(timeout);
  }
}
