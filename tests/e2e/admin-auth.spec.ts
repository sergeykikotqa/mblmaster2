import { expect, test, type Page } from '@playwright/test';

const HEALTH_PAGE = '/admin';
const METRICS_PAGE = '/admin/metrics';
const HEALTH_API_PATH = '/api/admin/health';
const METRICS_API_PATH = '/api/admin/metrics';
const VALID_TOKEN = process.env.METRICS_ADMIN_TOKEN || 'playwright-admin-token';
const ALLOWLIST_IP = '203.0.113.120';

async function setClientIp(page: Page, ip: string) {
  await page.setExtraHTTPHeaders({
    'x-real-ip': ip,
  });
}

async function submitMetricsRequest(page: Page, token = '') {
  await page.locator('#admin-token').fill(token);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === METRICS_API_PATH && response.request().method() === 'GET';
  });
  await page.locator('#metrics-submit').click();
  return responsePromise;
}

async function submitHealthRequest(page: Page, token = '') {
  await page.locator('#admin-token').fill(token);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === HEALTH_API_PATH && response.request().method() === 'GET';
  });
  await page.locator('#health-check-button').click();
  return responsePromise;
}

test.describe.serial('Admin metrics auth', () => {
  test('health aggregate API is served with no-store caching', async ({ request }) => {
    const response = await request.get(HEALTH_API_PATH, {
      headers: {
        'x-real-ip': ALLOWLIST_IP,
      },
    });

    expect(response.status()).toBe(200);
    expect(String(response.headers()['cache-control'] || '')).toContain('no-store');
  });

  test('does not send metrics API requests on page open', async ({ page }) => {
    await setClientIp(page, '203.0.113.101');
    let apiRequestCount = 0;

    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === METRICS_API_PATH) {
        apiRequestCount += 1;
      }
    });

    await page.goto(METRICS_PAGE);
    await expect(page.locator('#metrics-summary')).toContainText('Введите admin token');
    await page.waitForTimeout(400);

    expect(apiRequestCount).toBe(0);
  });

  test('returns 401 for invalid token', async ({ page }) => {
    await setClientIp(page, '203.0.113.102');
    await page.goto(METRICS_PAGE);

    const response = await submitMetricsRequest(page, 'invalid-admin-token');
    expect(response.status()).toBe(401);

    await expect(page.locator('#metrics-summary')).toContainText('UNAUTHORIZED');
    await expect(page.locator('#metrics-submit')).toBeEnabled();
  });

  test('returns 429 after 10 invalid attempts and disables submit button', async ({ page }) => {
    await setClientIp(page, '203.0.113.103');
    await page.goto(METRICS_PAGE);

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const unauthorizedResponse = await submitMetricsRequest(page, `invalid-admin-token-${attempt}`);
      expect(unauthorizedResponse.status()).toBe(401);
    }

    const blockedResponse = await submitMetricsRequest(page, 'invalid-admin-token-10');
    expect(blockedResponse.status()).toBe(429);

    await expect(page.locator('#metrics-submit')).toBeDisabled();
    await expect(page.locator('#metrics-summary')).toContainText('TOO_MANY_REQUESTS');
    await expect(page.locator('#metrics-summary')).toHaveAttribute('data-state', 'rate_limited');
  });

  test('health lockout stays within health scope and does not block metrics', async ({ page }) => {
    await setClientIp(page, '203.0.113.105');
    await page.goto(HEALTH_PAGE);

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const unauthorizedResponse = await submitHealthRequest(page, `invalid-health-token-${attempt}`);
      expect(unauthorizedResponse.status()).toBe(401);
    }

    const blockedResponse = await submitHealthRequest(page, 'invalid-health-token-10');
    expect(blockedResponse.status()).toBe(429);
    await expect(page.locator('#health-status')).toContainText('TOO_MANY_REQUESTS');

    await page.goto(METRICS_PAGE);
    const metricsResponse = await submitMetricsRequest(page, VALID_TOKEN);
    expect(metricsResponse.status()).toBe(200);
    await expect(page.locator('#metrics-summary')).toContainText('Bucket:');
    await expect(page.locator('#metrics-summary')).toContainText('Auth:');
  });

  test('allowlisted IP can use health screen without token', async ({ page }) => {
    await setClientIp(page, ALLOWLIST_IP);
    await page.goto(HEALTH_PAGE);

    const response = await submitHealthRequest(page);
    expect(response.status()).toBe(200);

    await expect(page.locator('#health-status')).toContainText(/Health: (OK|WARNING|DEGRADED)/);
    await expect(page.locator('#health-auth-method')).toContainText('allowlist');
    await expect(page.locator('#health-last-updated')).not.toHaveText('-');
  });

  test('allowlisted IP can use metrics screen without token', async ({ page }) => {
    await setClientIp(page, ALLOWLIST_IP);
    await page.goto(METRICS_PAGE);

    const response = await submitMetricsRequest(page);
    expect(response.status()).toBe(200);

    await expect(page.locator('#metrics-summary')).toContainText('Bucket:');
    await expect(page.locator('#metrics-summary')).toContainText('Auth:');
    await expect(page.locator('#metrics-summary')).toContainText('allowlist');
  });

  test('returns 200 for valid token', async ({ page }) => {
    await setClientIp(page, '203.0.113.104');
    await page.goto(METRICS_PAGE);

    const response = await submitMetricsRequest(page, VALID_TOKEN);
    expect(response.status()).toBe(200);

    await expect(page.locator('#metrics-summary')).toContainText('Bucket:');
    await expect(page.locator('#metrics-summary')).toHaveAttribute('data-state', 'success');
  });
});
