import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.config';

const webServer = baseConfig.webServer;
if (!webServer || Array.isArray(webServer)) {
  throw new Error('Accessibility checks require the shared local web server configuration.');
}

export default defineConfig({
  ...baseConfig,
  workers: 2,
  webServer: {
    ...webServer,
    timeout: 240_000,
    env: {
      ...webServer.env,
      // Audit the public experience, including consent and real entrance motion.
      PUBLIC_E2E: '0',
    },
  },
});
