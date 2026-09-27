import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.config';
import { ACCESSIBILITY_SPEC_GLOBS, SEO_SPEC_GLOBS, ARTIFACT_SPEC_GLOBS } from './playwright.suites';

const webServer = baseConfig.webServer;
if ((!webServer && process.env.PLAYWRIGHT_EXTERNAL_SERVER !== '1') || Array.isArray(webServer)) {
  throw new Error('SEO and artifact audits require the shared local web server configuration.');
}

export default defineConfig({
  ...baseConfig,
  // Owns SEO browser invariants and the build/sitemap-gated mobile adaptation audit.
  // testIgnore must re-include these because the base functional config ignores all specialized specs.
  testIgnore: [...ACCESSIBILITY_SPEC_GLOBS],
  testMatch: [...SEO_SPEC_GLOBS, ...ARTIFACT_SPEC_GLOBS],
  fullyParallel: false,
  workers: 1,
  timeout: 10 * 60_000,
  webServer: webServer
    ? {
        ...webServer,
        env: {
          ...webServer.env,
          PUBLIC_E2E: '1',
        },
      }
    : undefined,
});
