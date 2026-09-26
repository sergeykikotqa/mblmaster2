import fs from 'node:fs';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const host = '127.0.0.1';
const port = Number(process.env.ANALYTICS_CONSENT_E2E_PORT || 4394);
const baseURL = `http://${host}:${port}`;
const browserCandidates = [
  process.env.PLAYWRIGHT_BROWSER_PATH,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean) as string[];
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));

export default defineConfig({
  testDir: './tests',
  testMatch: 'analytics-consent.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [['line']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: `"${process.execPath}" "${path.join(process.cwd(), 'scripts', 'start-node.mjs')}"`,
    url: `${baseURL}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL || 'https://mbl-r16.local.test',
      REDIS_URL: '',
    },
  },
});
