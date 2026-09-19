import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  SERVICE_NAMES,
  extractCanonical,
  extractPageResources,
  heartbeatFrom,
  normalizePathname,
  oldestPendingFrom,
  redact,
  timingSafeSignature,
} from '../scripts/check-compose-runtime.mjs';

describe('production Compose runtime gate helpers', () => {
  test('pins the gate to the four approved production services', () => {
    expect(SERVICE_NAMES).toEqual(['mbl-nginx', 'mbl-web', 'mbl-worker-trigger', 'mbl-redis']);
  });

  test('sanitizes every application-trusted client IP header at the Nginx boundary', () => {
    const proxyConfig = readFileSync(new URL('../nginx/generated/proxy-common.conf', import.meta.url), 'utf8');

    for (const header of [
      'CF-Connecting-IP',
      'X-NF-Client-Connection-IP',
      'True-Client-IP',
      'X-Vercel-Forwarded-For',
      'Forwarded',
    ]) {
      expect(proxyConfig).toMatch(new RegExp(`proxy_set_header\\s+${header}\\s+"";`, 'i'));
    }
    expect(proxyConfig).toMatch(/proxy_set_header\s+X-Real-IP\s+\$remote_addr;/i);
    expect(proxyConfig).toMatch(/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/i);
  });

  test('extracts canonical and local runtime resources without crawling external hosts', () => {
    const html = `
      <link rel="canonical" href="https://mebel-irkutsk.ru/projects">
      <link rel="stylesheet" href="/_astro/app.hash.css">
      <link rel="preconnect" href="https://fonts.example.test">
      <script src="/_astro/app.hash.js"></script>
      <img src="/images/project.webp" srcset="/images/project-320.webp 320w, /images/project-960.webp 960w">
      <img src="https://cdn.example.test/demo.jpg">
    `;

    expect(extractCanonical(html)).toBe('https://mebel-irkutsk.ru/projects');
    expect([...extractPageResources(html, 'http://127.0.0.1:8080/projects')].sort()).toEqual(
      [
        'http://127.0.0.1:8080/_astro/app.hash.css',
        'http://127.0.0.1:8080/_astro/app.hash.js',
        'http://127.0.0.1:8080/images/project-320.webp',
        'http://127.0.0.1:8080/images/project-960.webp',
        'http://127.0.0.1:8080/images/project.webp',
      ].sort()
    );
  });

  test('normalizes route paths without introducing a trailing slash', () => {
    expect(normalizePathname('')).toBe('/');
    expect(normalizePathname('/')).toBe('/');
    expect(normalizePathname('//projects/example///')).toBe('/projects/example');
  });

  test('validates the webhook signature formula used by the application', () => {
    const secret = 'test-secret';
    const timestamp = '1700000000';
    const webhookId = 'lead-123';
    const body = '{"lead":{"leadId":"lead-123"}}';
    const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${webhookId}.${body}`).digest('hex')}`;

    expect(timingSafeSignature(secret, timestamp, webhookId, body)).toBe(expected);
  });

  test('reads the agreed heartbeat and oldest-pending admin shape', () => {
    const payload = {
      runtime: {
        heartbeat: {
          state: 'cycling',
          ageMs: 120,
          staleAfterMs: 60_000,
          value: { lastCycleAt: '2026-09-15T00:00:00.000Z', status: 'ok', processed: 1, delivered: 1, error: '' },
        },
        oldestPending: {
          ageMs: 500,
          state: 'normal',
          thresholdsMs: { normal: 60_000, warning: 120_000, critical: 600_000 },
        },
      },
    };

    expect(heartbeatFrom(payload)).toMatchObject({ state: 'cycling', value: { status: 'ok' } });
    expect(oldestPendingFrom(payload)).toMatchObject({ state: 'normal', ageMs: 500 });
  });

  test('redacts every generated secret from diagnostics', () => {
    const output = redact('worker=alpha admin=beta alpha', ['alpha', 'beta']);
    expect(output).toBe('worker=[redacted] admin=[redacted] [redacted]');
  });
});
