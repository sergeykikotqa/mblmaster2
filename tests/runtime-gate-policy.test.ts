import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { checkAdminHtmlAccess } from '../scripts/check-compose-runtime.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('runtime evidence policy', () => {
  test('checks the working branch and clean Nginx image in GitHub CI', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'actions.yaml'), 'utf8');

    expect(workflow).toContain('codex/o2-4-reliability');
    expect(workflow).toContain('npm run check:nginx-clean-build');
  });

  test('separates development smoke from the Redis-backed production runtime gate', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const localRuntime = fs.readFileSync(path.join(ROOT, 'scripts', 'check-production-runtime.mjs'), 'utf8');
    const preLaunchAudit = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-pre-launch.mjs'), 'utf8');

    expect(pkg.scripts['check:dev-runtime']).toContain('--mode=dev');
    expect(pkg.scripts['check:prod-runtime']).toBe('node scripts/check-compose-runtime.mjs');
    expect(localRuntime).not.toMatch(/PROD_RUNTIME_LOCAL_MODE\s*\|\|\s*['"]dev['"]/);
    expect(localRuntime).toContain('Runtime smoke mode must be explicit');
    expect(preLaunchAudit).toContain("status: 'DEV_SMOKE_PASS'");
    expect(preLaunchAudit).toContain("status: 'PRODUCTION_RUNTIME_PASS'");
    expect(preLaunchAudit).toContain("runNpm('check:prod-runtime'");
  });

  test('proves unauthenticated admin redirects to the no-store/noindex login page', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: { Location: '/admin/login?next=%2Fadmin' },
        })
      )
      .mockResolvedValueOnce(
        new Response('<h1>Вход в веб-админку</h1>', {
          status: 200,
          headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
        })
      );

    await expect(checkAdminHtmlAccess('http://127.0.0.1:4321')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4321/admin',
      expect.objectContaining({ redirect: 'manual' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4321/admin/login?next=%2Fadmin',
      expect.objectContaining({ redirect: 'manual' })
    );
  });
});
