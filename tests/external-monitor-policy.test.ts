import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('O2.4.3 external monitoring policy', () => {
  test('runs from a persistent independent host instead of GitHub Actions', () => {
    const service = fs.readFileSync(
      path.join(ROOT, 'ops', 'external-monitoring', 'systemd', 'mbl-external-monitor.service'),
      'utf8'
    );
    const timer = fs.readFileSync(
      path.join(ROOT, 'ops', 'external-monitoring', 'systemd', 'mbl-external-monitor.timer'),
      'utf8'
    );
    expect(service).toContain('User=mbl-monitor');
    expect(service).toContain('EnvironmentFile=/etc/mbl-monitor/monitor.env');
    expect(service).toContain('StateDirectory=mbl-monitor');
    expect(service).toContain('NoNewPrivileges=true');
    expect(service).toContain('ProtectSystem=strict');
    expect(timer).toContain('OnUnitActiveSec=5min');
    expect(timer).toContain('OnBootSec=1min');
  });

  test('keeps production monitoring and Telegram secrets out of GitHub workflows', () => {
    const workflowDirectory = path.join(ROOT, '.github', 'workflows');
    for (const retired of [
      'external-production-monitor.yaml',
      'lead-worker-cron.yaml',
      'metrics-health-cron.yaml',
      'metrics-snapshot-cron.yaml',
    ]) {
      expect(fs.existsSync(path.join(workflowDirectory, retired))).toBe(false);
    }
    const workflows = fs
      .readdirSync(workflowDirectory)
      .filter((entry) => /\.ya?ml$/i.test(entry))
      .map((entry) => fs.readFileSync(path.join(workflowDirectory, entry), 'utf8'))
      .join('\n');
    expect(workflows).not.toMatch(
      /PRODUCTION_MONITOR_|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|MBL_OWNER_METRICS_TOKEN|MBL_TELEGRAM_ADMIN/
    );
    expect(workflows).not.toContain('check-production:');
    expect(workflows).not.toContain('check:deployed-runtime');
    expect(workflows).not.toMatch(/\/api\/workers\//);

    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'external-monitor.mjs'), 'utf8');
    expect(source).toContain('MONITOR_TOKEN_MISSING_OR_WEAK');
    expect(source).toContain('SUCCESS_SIGNAL_NOT_INDEPENDENT');
    expect(source).toContain('FAILURE_SIGNAL_NOT_INDEPENDENT');
    expect(source).not.toContain('GITHUB_');
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

  test('keeps Telegram secrets outside the application release bundle', () => {
    const releaseTool = fs.readFileSync(path.join(ROOT, 'scripts', 'release-tool.mjs'), 'utf8');
    expect(releaseTool).not.toMatch(/telegram\.env|monitor\.env|ops\/external-monitoring/i);

    const template = fs.readFileSync(path.join(ROOT, 'ops', 'external-monitoring', 'monitor.env.example'), 'utf8');
    expect(template).toMatch(/TELEGRAM_BOT_TOKEN=\s*$/m);
    expect(template).toMatch(/TELEGRAM_CHAT_ID=\s*$/m);
    expect(template).not.toContain('mbl-secrets');
  });

  test('requires a dedicated token and never falls back to admin allowlist access', () => {
    const route = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'api', 'monitoring', 'health.ts'), 'utf8');
    expect(route).toContain('process.env.MBL_MONITORING_TOKEN');
    expect(route).toContain('allowAllowlist: false');
    expect(route).toContain('allowDevBypass: false');
    expect(route).toContain('requireToken: true');
    expect(route).not.toContain('METRICS_ADMIN_TOKEN');
  });

  test('runs owner commands as one locked consumer on the independent host', () => {
    const service = fs.readFileSync(
      path.join(ROOT, 'ops', 'external-monitoring', 'systemd', 'mbl-telegram-admin.service'),
      'utf8'
    );
    const timer = fs.readFileSync(
      path.join(ROOT, 'ops', 'external-monitoring', 'systemd', 'mbl-telegram-admin.timer'),
      'utf8'
    );
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'telegram-admin.mjs'), 'utf8');
    expect(service).toContain('User=mbl-monitor');
    expect(service).toContain('/usr/bin/flock -n /run/mbl-monitor/telegram-admin.lock');
    expect(service).toContain('EnvironmentFile=/etc/mbl-monitor/monitor.env');
    expect(service).toContain('ReadWritePaths=/var/lib/mbl-monitor');
    expect(timer).toContain('OnUnitActiveSec=10s');
    expect(source).toContain("message?.chat?.type !== 'private'");
    expect(source).toContain('message?.from?.id');
    expect(source).toContain('message?.chat?.id');
    expect(source).not.toContain('REDIS_URL');
    expect(source).not.toMatch(/\/api\/(?:admin|workers|leads|contact)/);
  });

  test('exposes only a dedicated aggregate metrics route', () => {
    const route = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'api', 'monitoring', 'owner-metrics.ts'), 'utf8');
    expect(route).toContain('MBL_OWNER_METRICS_TOKEN');
    expect(route).toContain('allowAllowlist: false');
    expect(route).toContain('allowDevBypass: false');
    expect(route).toContain('requireToken: true');
    expect(route).not.toMatch(/getLeadRecord|listDueLeadIds|name|phone|message/);
  });
});
