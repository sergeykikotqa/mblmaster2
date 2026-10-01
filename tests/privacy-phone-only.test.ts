import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { appendLeadBackup } from '../src/server/leads/backup-log';
import { deliverLeadWebhook } from '../src/server/leads/webhook';
import { notificationFixture } from './helpers/lead-v2';
import { privateLeadFields } from './helpers/lead-v2';
import { parseLeadRecord } from '../src/server/leads/store';
import { post as trackPost } from '../src/pages/api/track';
import { getIndexabilityPolicy } from '../src/config/indexability-policy';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('separate lead consent keeps the existing legal-page indexability contract', () => {
  expect(getIndexabilityPolicy('/personal-data-consent')).toMatchObject({
    isKnown: true,
    classification: 'noindex-follow',
    index: false,
    follow: true,
    includeInSitemap: false,
  });
});

test.each([
  '/contacts?phone=PRIVATE_QUERY#PRIVATE_FRAGMENT',
  'https://local.invalid/contacts?phone=PRIVATE_QUERY#PRIVATE_FRAGMENT',
])('tracking handler never logs query or fragment from %s', async (page) => {
  vi.stubEnv('REDIS_URL', '');
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const response = await trackPost({
    request: new Request('http://localhost/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'page_view', page }),
    }),
    clientAddress: '127.0.0.1',
  });
  expect(response.status).toBe(200);
  expect(info).toHaveBeenCalledWith('[track] event_received', expect.objectContaining({ page: '/contacts' }));
  expect(JSON.stringify(info.mock.calls)).not.toContain('PRIVATE_');
});

test('Redis reader rejects legacy records and never fabricates stored consent', () => {
  const now = '2026-09-30T00:00:00.000Z';
  const record = {
    leadId: 'opaque-1',
    status: 'pending',
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
    ...privateLeadFields(now),
    webhookPayload: notificationFixture('opaque-1', now),
  };
  expect(parseLeadRecord(JSON.stringify(record))?.consent).toEqual(record.consent);
  for (const consent of [
    undefined,
    false,
    { accepted: false },
    { accepted: true, version: 'unknown', acceptedAt: now },
    { accepted: true, version: 'phone-contact-v1', acceptedAt: 'invalid' },
  ]) {
    expect(parseLeadRecord(JSON.stringify({ ...record, consent }))).toBeNull();
  }
  expect(
    parseLeadRecord(
      JSON.stringify({
        ...record,
        normalizedPhone: undefined,
        consent: undefined,
        webhookPayload: { lead: { phone: '+79000000001', receivedAt: now } },
      })
    )
  ).toBeNull();
});

test('production forensic log is disabled without explicit opt-in', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mbl-forensic-disabled-'));
  const file = path.join(directory, 'proof.ndjson');
  vi.stubEnv('PROD', true);
  vi.stubEnv('CONTACT_LEAD_BACKUP_ENABLED', undefined);
  vi.stubEnv('CONTACT_LEAD_BACKUP_FILE', file);
  try {
    await appendLeadBackup({ normalizedPhone: 'PRIVATE_PHONE' });
    await expect(fs.readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('forensic log redacts phone aliases and nested legacy PII', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mbl-forensic-privacy-'));
  const file = path.join(directory, 'proof.ndjson');
  vi.stubEnv('CONTACT_LEAD_BACKUP_ENABLED', 'true');
  vi.stubEnv('CONTACT_LEAD_BACKUP_FILE', file);
  try {
    await appendLeadBackup({
      leadId: 'opaque-1',
      normalizedPhone: 'PRIVATE_PHONE',
      nested: {
        phone_normalized: 'PRIVATE_PHONE',
        contactPhone: 'PRIVATE_PHONE',
        userAgent: 'PRIVATE_AGENT',
        ip: 'PRIVATE_IP',
        name: 'PRIVATE_NAME',
        message: 'PRIVATE_MESSAGE',
      },
    });
    const content = await fs.readFile(file, 'utf8');
    expect(content).not.toContain('PRIVATE_');
    expect(content).toContain('[REDACTED]');
    expect(content).toContain('opaque-1');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('webhook projection cannot send a raw record or injected PII fields', async () => {
  vi.stubEnv('CONTACT_WEBHOOK_URL', 'https://synthetic.invalid/notify');
  vi.stubEnv('CONTACT_WEBHOOK_SECRET', 'synthetic-test-secret');
  let body = '';
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    body = String(init.body);
    return new Response(null, { status: 204 });
  });
  const envelope = notificationFixture('opaque-1');
  const polluted = {
    ...envelope,
    normalizedPhone: 'PRIVATE_PHONE',
    name: 'PRIVATE_NAME',
    notification: {
      ...envelope.notification,
      phone: 'PRIVATE_PHONE',
      userAgent: 'PRIVATE_AGENT',
      service: 'PRIVATE_PHONE',
    },
  };
  expect(await deliverLeadWebhook(polluted)).toEqual({ ok: true, status: 204 });
  expect(body).not.toContain('PRIVATE_');
  expect(JSON.parse(body)).toEqual(envelope);
});

test('webhook rejects injected metadata values before serializing them', async () => {
  vi.stubEnv('CONTACT_WEBHOOK_URL', 'https://synthetic.invalid/notify');
  vi.stubEnv('CONTACT_WEBHOOK_SECRET', 'synthetic-test-secret');
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const envelope = notificationFixture('opaque-1');
  const polluted = {
    ...envelope,
    notification: { ...envelope.notification, createdAt: 'PRIVATE_PHONE' },
  };
  expect(await deliverLeadWebhook(polluted)).toMatchObject({ ok: false, code: 'WEBHOOK_PAYLOAD_INVALID' });
  expect(fetchMock).not.toHaveBeenCalled();
});
