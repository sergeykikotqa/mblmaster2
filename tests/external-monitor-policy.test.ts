import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('O2.4.3 external monitoring policy', () => {
  test('runs read-only from an independent scheduled workflow with bounded privileges', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'external-production-monitor.yaml'),
      'utf8'
    );
    expect(workflow).toMatch(/cron: ['"]3\/5 \* \* \* \*['"]/);
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).not.toMatch(/pull_request(?:_target)?:/);
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(workflow).toMatch(/timeout-minutes: 4/);
    expect(workflow).toMatch(/cancel-in-progress: false/);
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toMatch(/continue-on-error:\s*true/);
  });

  test('keeps monitor credentials in step-scoped secrets and fails closed when absent', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'external-production-monitor.yaml'),
      'utf8'
    );
    for (const secret of [
      'PRODUCTION_MONITOR_TOKEN',
      'PRODUCTION_MONITOR_SUCCESS_URL',
      'PRODUCTION_MONITOR_FAILURE_URL',
    ]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).not.toMatch(/if:\s*\$\{\{[^\n]*secrets\./);
    expect(workflow).not.toMatch(/echo[^\n]*MONITOR_(?:TOKEN|SUCCESS_URL|FAILURE_URL)/i);

    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'external-monitor.mjs'), 'utf8');
    expect(source).toContain('MONITOR_TOKEN_MISSING_OR_WEAK');
    expect(source).toContain('SUCCESS_SIGNAL_NOT_INDEPENDENT');
    expect(source).toContain('FAILURE_SIGNAL_NOT_INDEPENDENT');
    expect(source).not.toMatch(/searchParams\.(?:set|append)\([^\n]*(?:token|secret|auth)/i);
  });

  test('uses a read-only backup checkpoint mount and never exposes the backup secret directory', () => {
    const compose = fs.readFileSync(path.join(ROOT, 'compose.production.yml'), 'utf8');
    expect(compose).toMatch(/target: \/run\/mbl-backup-status\s*\n\s*read_only: true/);
    expect(compose).toContain('MBL_BACKUP_STATUS_FILE: /run/mbl-backup-status/last-success.json');
    const webBlock = compose.split('  mbl-web:')[1]?.split('  mbl-worker-trigger:')[0] || '';
    expect(webBlock).not.toContain('/run/mbl-backup-secrets');
    expect(webBlock).not.toContain('MBL_BACKUP_PASSWORD');
  });

  test('never submits leads or invokes a public worker from the external monitor', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'external-monitor.mjs'), 'utf8');
    expect(source).not.toContain('/api/leads');
    expect(source).not.toContain('/api/contact');
    expect(source).not.toContain('/api/workers');
    expect(source).toContain("new URL('/api/monitoring/health'");
  });

  test('requires a dedicated token and never falls back to admin allowlist access', () => {
    const route = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'api', 'monitoring', 'health.ts'), 'utf8');
    expect(route).toContain('process.env.MBL_MONITORING_TOKEN');
    expect(route).toContain('allowAllowlist: false');
    expect(route).toContain('allowDevBypass: false');
    expect(route).toContain('requireToken: true');
    expect(route).not.toContain('METRICS_ADMIN_TOKEN');
  });
});
