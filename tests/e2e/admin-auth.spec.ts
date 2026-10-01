import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { notificationFixture, privateLeadFields } from '../helpers/lead-v2';
import type { LeadRecord } from '../../src/server/leads/types';

const HEALTH_PAGE = '/admin';
const METRICS_PAGE = '/admin/metrics';
const HEALTH_API_PATH = '/api/admin/health';
const METRICS_API_PATH = '/api/admin/metrics';
const SESSION_API_PATH = '/api/admin/auth/session';
const MOCK_LOGIN_PATH = '/api/admin/auth/telegram/mock';
const ALLOWLIST_IP = '203.0.113.120';

async function useAdminNetwork(page: Page) {
  await page.setExtraHTTPHeaders({ 'x-real-ip': ALLOWLIST_IP });
}

async function loginWithLocalHarness(page: Page, next = HEALTH_PAGE) {
  await useAdminNetwork(page);
  const response = await page.goto(`${MOCK_LOGIN_PATH}?next=${encodeURIComponent(next)}`);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`${next.replace('/', '\\/')}$`));
  await expect(page.locator('#admin-session-status')).toBeVisible();
}

test.describe.serial('Admin Telegram session auth', () => {
  test('lead inbox and details redirect anonymous visitors without exposing phone', async ({ page }) => {
    await useAdminNetwork(page);
    for (const route of ['/admin/leads', `/admin/leads/${randomUUID()}`]) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/admin\/login\?next=/);
      await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
    }
  });

  test('authenticated lead details expose phone only in no-store admin HTML', async ({ page }) => {
    const redisUrl = process.env.REDIS_URL || '';
    test.skip(!redisUrl, 'Requires dedicated loopback test Redis');
    const parsed = new URL(redisUrl);
    expect(['127.0.0.1', 'localhost']).toContain(parsed.hostname);
    expect(parsed.pathname).toMatch(/^\/(?:[1-9]|1[0-5])$/);
    const prefix = process.env.CONTACT_REDIS_PREFIX || '';
    expect(prefix).toMatch(/^mbl-p02-admin-test-/);
    const leadId = randomUUID();
    const now = new Date().toISOString();
    const record: LeadRecord = {
      leadId,
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
      idempotencyHash: leadId,
      payloadFingerprint: leadId,
      ...privateLeadFields(now),
      webhookPayload: notificationFixture(leadId, now),
      status: 'pending',
      retryCount: 0,
      nextRetryAt: Date.now(),
    };
    const redis = createClient({ url: redisUrl });
    await redis.connect();
    const key = `${prefix}:record:${leadId}`;
    const index = `${prefix}:record:index`;
    try {
      await redis.set(key, JSON.stringify(record), { EX: 60 });
      await redis.zAdd(index, { score: Date.now(), value: leadId });
      await loginWithLocalHarness(page, '/admin/leads');
      const list = await page.request.get('/admin/leads', { headers: { 'x-real-ip': ALLOWLIST_IP } });
      expect(list.headers()['cache-control']).toContain('no-store');
      expect(await list.text()).not.toContain(record.normalizedPhone);
      const response = await page.goto(`/admin/leads/${leadId}`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()['cache-control']).toContain('no-store');
      expect(response?.headers()['x-robots-tag']).toContain('noindex');
      await expect(page.locator(`a[href="tel:${record.normalizedPhone}"]`)).toHaveText(record.normalizedPhone);
      await expect(
        page.locator('script[src*="metrika"], script[src*="lead-tracking"], script[src*="google"]')
      ).toHaveCount(0);
      expect(page.url()).not.toContain(record.normalizedPhone);
    } finally {
      await redis.del(key);
      await redis.zRem(index, leadId);
      await redis.quit();
    }
  });

  test('redirects protected HTML to login without a session', async ({ page }) => {
    await useAdminNetwork(page);
    await page.goto(METRICS_PAGE);
    await expect(page).toHaveURL(/\/admin\/login\?next=/);
    await expect(page.getByRole('heading', { name: 'Вход в веб-админку' })).toBeVisible();
    await expect(page.locator('#admin-token')).toHaveCount(0);
  });

  test('rejects admin APIs without a session or service token', async ({ request }) => {
    const response = await request.get(METRICS_API_PATH, { headers: { 'x-real-ip': ALLOWLIST_IP } });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
  });

  test('local harness creates a server session that protects both dashboards', async ({ page }) => {
    await loginWithLocalHarness(page, METRICS_PAGE);
    await expect(page.locator('#admin-token')).toHaveCount(0);
    await expect(page.locator('#metrics-summary')).toContainText('Настройте фильтры');
    await page.locator('#metrics-submit').click();
    await expect(page.locator('#metrics-summary')).toContainText('Auth:');
    await expect(page.locator('#metrics-summary')).toContainText('session');

    const sessionResponse = await page.request.get(SESSION_API_PATH, { headers: { 'x-real-ip': ALLOWLIST_IP } });
    expect(sessionResponse.status()).toBe(200);
    expect(await sessionResponse.json()).toMatchObject({ ok: true, authMethod: 'session' });

    await page.goto(HEALTH_PAGE);
    await expect(page.locator('#health-check-button')).toBeVisible();
  });

  test('logout revokes the server session and returns to login', async ({ page }) => {
    await loginWithLocalHarness(page);
    await page.locator('#admin-logout').click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    await page.goto(HEALTH_PAGE);
    await expect(page).toHaveURL(/\/admin\/login\?next=/);
  });

  test('unsafe session request without CSRF is rejected', async ({ page }) => {
    await loginWithLocalHarness(page);
    const pageOrigin = new URL(page.url()).origin;
    const response = await page.request.post('/api/admin/auth/logout', {
      headers: { 'x-real-ip': ALLOWLIST_IP, Origin: pageOrigin },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, code: 'CSRF_FAILED' });
  });

  test('spoofed forwarding header does not grant identity without a session', async ({ request }) => {
    const response = await request.get(HEALTH_API_PATH, {
      headers: { 'x-real-ip': ALLOWLIST_IP, 'x-forwarded-for': ALLOWLIST_IP },
    });
    expect(response.status()).toBe(401);
  });
});
