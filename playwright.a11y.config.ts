import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.config';
import { ACCESSIBILITY_SPEC_GLOBS, NON_ACCESSIBILITY_SPEC_GLOBS } from './playwright.suites';

const webServer = baseConfig.webServer;
if ((!webServer && process.env.PLAYWRIGHT_EXTERNAL_SERVER !== '1') || Array.isArray(webServer)) {
  throw new Error('Accessibility checks require the shared local web server configuration.');
}

export default defineConfig({
  ...baseConfig,
  // Owns the accessibility suite, including interactive SmartCaptcha state that a
  // full-page Axe scan cannot reach. Runs with PUBLIC_E2E=0 below.
  testMatch: ACCESSIBILITY_SPEC_GLOBS,
  testIgnore: NON_ACCESSIBILITY_SPEC_GLOBS,
  workers: 2,
  webServer: webServer
    ? {
        ...webServer,
        env: {
          ...webServer.env,
          // Audit the public experience, including consent and real entrance motion.
          PUBLIC_E2E: '0',
        },
      }
    : undefined,
});
