import type { LeadNotificationEnvelope } from '../../src/server/leads/types';

export function notificationFixture(
  leadId: string,
  createdAt = '2026-09-30T00:00:00.000Z',
  service?: string
): LeadNotificationEnvelope {
  return {
    schemaVersion: '1.0',
    event: 'lead.created',
    notification: { leadId, createdAt, adminPath: `/admin/leads/${leadId}`, ...(service ? { service } : {}) },
  };
}

export function privateLeadFields(createdAt: string) {
  return {
    normalizedPhone: '+79000000001',
    consent: { accepted: true as const, version: 'phone-contact-v1', acceptedAt: createdAt },
    context: {},
  };
}
