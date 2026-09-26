import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const host = process.env.PLAYWRIGHT_HOST || '127.0.0.1';
const port = Number(process.env.PLAYWRIGHT_PORT || 4321);
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://${host}:${port}`;
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === '1';
const browserExecutablePath = resolveBrowserExecutablePath();
const adminE2eToken = process.env.METRICS_ADMIN_TOKEN || 'playwright-admin-token';
const publicSiteUrl = process.env.PUBLIC_SITE_URL || baseURL;
const allowlistIps = process.env.ADMIN_ALLOWLIST_IPS || '203.0.113.120';
const trustProxyHeaders = process.env.ADMIN_TRUST_PROXY_HEADERS || 'true';
const astroCliPath = path.join(process.cwd(), 'node_modules', 'astro', 'bin', 'astro.mjs');

process.env.PUBLIC_SITE_URL = publicSiteUrl;
process.env.ADMIN_ALLOWLIST_IPS = allowlistIps;
process.env.ADMIN_TRUST_PROXY_HEADERS = trustProxyHeaders;

function resolveBrowserExecutablePath() {
  const candidates = [
    process.env.PLAYWRIGHT_BROWSER_PATH,
    process.env.CHROME_PATH,
    process.env.MSEDGE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(browserExecutablePath ? { launchOptions: { executablePath: browserExecutablePath } } : {}),
      },
    },
  ],
  webServer: useExternalServer
    ? undefined
    : {
        command: `"${process.execPath}" "${astroCliPath}" dev --host ${host} --port ${port}`,
        url: `${baseURL}/api/health`,
        env: {
          ...process.env,
          ASTRO_DEV_BACKGROUND: '0',
          METRICS_ADMIN_TOKEN: adminE2eToken,
          ALLOW_DEV_BYPASS: 'false',
          ADMIN_ALLOWLIST_IPS: allowlistIps,
          ADMIN_TRUST_PROXY_HEADERS: trustProxyHeaders,
          TELEGRAM_LOGIN_CLIENT_ID: process.env.TELEGRAM_LOGIN_CLIENT_ID || '123456789',
          TELEGRAM_LOGIN_CLIENT_SECRET: process.env.TELEGRAM_LOGIN_CLIENT_SECRET || 'playwright-telegram-client-secret',
          TELEGRAM_LOGIN_REDIRECT_URI:
            process.env.TELEGRAM_LOGIN_REDIRECT_URI || `${baseURL}/api/admin/auth/telegram/callback`,
          TELEGRAM_ADMIN_ALLOWED_USER_IDS: process.env.TELEGRAM_ADMIN_ALLOWED_USER_IDS || '123456789',
          TELEGRAM_LOGIN_MOCK_USER_ID: process.env.TELEGRAM_LOGIN_MOCK_USER_ID || '123456789',
          TELEGRAM_LOGIN_MOCK_MODE: 'true',
          PUBLIC_SITE_URL: publicSiteUrl,
          REDIS_URL: '',
          ADMIN_AUTH_FAIL_WINDOW_SEC: process.env.ADMIN_AUTH_FAIL_WINDOW_SEC || '60',
          ADMIN_AUTH_FAIL_MAX_ATTEMPTS: process.env.ADMIN_AUTH_FAIL_MAX_ATTEMPTS || '10',
          ADMIN_AUTH_FAIL_BLOCK_SEC: process.env.ADMIN_AUTH_FAIL_BLOCK_SEC || '600',
          PUBLIC_E2E: '1',
        },
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
