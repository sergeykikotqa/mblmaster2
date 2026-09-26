import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const origin = 'https://smartcaptcha.cloud.yandex.ru';

for (const relativePath of ['nginx/security-headers.conf', 'public/_headers']) {
  test(`${relativePath} permits the SmartCaptcha script, requests and frame`, () => {
    const file = readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
    const policy =
      file.split(/\r?\n/).find((line) => line.includes('Content-Security-Policy') && line.includes('default-src')) ||
      '';
    expect(policy, `${relativePath} must include a CSP`).toContain('default-src');
    for (const directive of ['script-src', 'connect-src', 'frame-src']) {
      const sources = policy.match(new RegExp(`${directive} ([^;]+)`))?.[1] || '';
      expect(sources, `${relativePath} ${directive}`).toContain(origin);
    }
    expect(policy).not.toContain('challenges.cloudflare.com');
  });
}
