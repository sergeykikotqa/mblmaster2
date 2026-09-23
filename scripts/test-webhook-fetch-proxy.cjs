'use strict';

const SYNTHETIC_PUBLIC_URL = 'https://mbl-test-webhook.invalid/webhook';
const originalFetch = globalThis.fetch.bind(globalThis);
const publicUrl = String(process.env.MBL_TEST_WEBHOOK_HTTPS_URL || '').trim();
const localTarget = String(process.env.MBL_TEST_WEBHOOK_HTTP_TARGET || '').trim();

if (!publicUrl || !localTarget) {
  throw new Error('Test webhook fetch proxy requires both endpoint variables');
}

if (publicUrl !== SYNTHETIC_PUBLIC_URL) {
  throw new Error('Test webhook fetch proxy only accepts the fixed synthetic endpoint');
}

const parsedPublicUrl = new URL(publicUrl);
const parsedLocalTarget = new URL(localTarget);
const localHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);
if (
  parsedPublicUrl.protocol !== 'https:' ||
  parsedPublicUrl.username ||
  parsedPublicUrl.password ||
  parsedLocalTarget.protocol !== 'http:' ||
  !localHosts.has(parsedLocalTarget.hostname) ||
  parsedLocalTarget.username ||
  parsedLocalTarget.password
) {
  throw new Error(
    'Test webhook fetch proxy only maps the synthetic endpoint to a credential-free loopback HTTP receiver'
  );
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return originalFetch(url === publicUrl ? localTarget : input, init);
};
