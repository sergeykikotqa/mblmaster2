import { createHmac } from 'crypto';

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

function resolveWebhookId(payload: Record<string, unknown>): string {
  const lead =
    payload?.lead && typeof payload.lead === 'object' && !Array.isArray(payload.lead)
      ? (payload.lead as Record<string, unknown>)
      : null;
  return typeof lead?.leadId === 'string' ? lead.leadId.trim() : '';
}

export async function deliverLeadWebhook(payload: Record<string, unknown>): Promise<WebhookDeliveryResult> {
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
      message: 'lead.leadId is required for webhook signing',
    };
  }

  const body = JSON.stringify(payload);
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

    const responseText = await response.text().catch(() => '');
    return {
      ok: false,
      code: `HTTP_${response.status}`,
      status: response.status,
      message: responseText.slice(0, 300),
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: error instanceof Error ? error.message.slice(0, 300) : 'network_error',
    };
  } finally {
    clearTimeout(timeout);
  }
}
