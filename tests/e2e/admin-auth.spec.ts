import { expect, test, type Page } from '@playwright/test';

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
