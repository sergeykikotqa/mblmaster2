import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  BACKUP_HEALTH_DEFAULTS,
  classifyBackupCheckpoint,
  readBackupHealth,
  type BackupHealth,
} from '../src/server/monitoring/backup-health';
import { evaluateMonitoringHealth, type MonitoringInputs } from '../src/server/monitoring/health';

const NOW = Date.parse('2026-09-20T05:00:00.000Z');
const MAX_AGE_MS = BACKUP_HEALTH_DEFAULTS.maxAgeSec * 1000;

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    status: 'ok',
    completedAt: new Date(NOW - 60_000).toISOString(),
    snapshotId: 'a'.repeat(64),
    releaseSha: 'b'.repeat(40),
    rdbBytes: 1024,
    rdbSha256: 'c'.repeat(64),
    ...overrides,
  };
}

function freshBackup(): BackupHealth {
  return classifyBackupCheckpoint(checkpoint(), { nowMs: NOW, maxAgeMs: MAX_AGE_MS });
}

function healthyWorker(): NonNullable<MonitoringInputs['worker']> {
  return {
    status: 200,
    payload: {
      ok: true,
      service: 'lead-worker',
      status: 'ok',
      authMethod: 'bearer',
      now: NOW,
      dependencies: {
        workerTokenConfigured: true,
        redisConfigured: true,
        webhookConfigured: true,
        webhookSecretConfigured: true,
        alertChannelConfigured: true,
        alertEndpointReachable: true,
        turnstileRequired: true,
        turnstileReady: true,
        workerPaused: false,
      },
      runtime: {
        ok: true,
        redisLive: true,
        heartbeat: {
          state: 'cycling',
          ageMs: 10_000,
          staleAfterMs: 60_000,
          value: {
            lastCycleAt: new Date(NOW - 10_000).toISOString(),
            status: 'ok',
            processed: 0,
            delivered: 0,
            error: '',
          },
        },
        oldestPending: {
          ageMs: null,
          state: 'empty',
          thresholdsMs: { normal: 60_000, warning: 120_000, critical: 600_000 },
        },
      },
      checkedAtMs: NOW,
      latencyMs: 1,
    },
  };
}

function healthyPipeline(): NonNullable<MonitoringInputs['pipeline']> {
  return {
    status: 200,
    payload: {
      ok: true,
      service: 'lead-pipeline',
      strictMode: true,
      authMethod: 'bearer',
      metricsDataSource: 'redis',
      generatedAtMs: NOW,
      retryRateLastHour: 0,
      dlqLastHour: 0,
      dlqLast24Hours: 0,
      p95LatencyMs: null,
      queueDepth: 0,
      queueBackpressureThreshold: 1000,
      workerPaused: false,
      counters: {},
      alerts: {
        dlqIncident: false,
        retryRateWarning: false,
        retryRateAlertThreshold: 0.1,
        alertChannelConfigured: true,
        alertEndpointReachable: true,
        queueBackpressure: false,
      },
      checkedAtMs: NOW,
      latencyMs: 1,
    },
  };
}

describe('backup monitoring health', () => {
  test('accepts the exact freshness and future-clock boundaries', () => {
    expect(
      classifyBackupCheckpoint(checkpoint({ completedAt: new Date(NOW - MAX_AGE_MS).toISOString() }), {
        nowMs: NOW,
        maxAgeMs: MAX_AGE_MS,
      }).status
    ).toBe('fresh');
    expect(
      classifyBackupCheckpoint(checkpoint({ completedAt: new Date(NOW - MAX_AGE_MS - 1).toISOString() }), {
        nowMs: NOW,
        maxAgeMs: MAX_AGE_MS,
      }).status
    ).toBe('stale');
    expect(
      classifyBackupCheckpoint(checkpoint({ completedAt: new Date(NOW + 300_000).toISOString() }), {
        nowMs: NOW,
        maxAgeMs: MAX_AGE_MS,
        futureToleranceMs: 300_000,
      }).status
    ).toBe('fresh');
    expect(
      classifyBackupCheckpoint(checkpoint({ completedAt: new Date(NOW + 300_001).toISOString() }), {
        nowMs: NOW,
        maxAgeMs: MAX_AGE_MS,
        futureToleranceMs: 300_000,
      }).status
    ).toBe('invalid');
  });

  test('rejects malformed or incomplete backup evidence', () => {
    expect(classifyBackupCheckpoint(checkpoint({ releaseSha: 'unknown' }), { nowMs: NOW }).status).toBe('invalid');
    expect(classifyBackupCheckpoint(checkpoint({ rdbBytes: 0 }), { nowMs: NOW }).status).toBe('invalid');
    expect(classifyBackupCheckpoint(checkpoint({ rdbSha256: 'bad' }), { nowMs: NOW }).status).toBe('invalid');
    expect(classifyBackupCheckpoint(checkpoint({ snapshotId: '' }), { nowMs: NOW }).status).toBe('invalid');
  });

  test('distinguishes missing, corrupt and valid checkpoint files without exposing file data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-monitoring-health-'));
    try {
      const missing = await readBackupHealth({ checkpointFile: path.join(root, 'missing.json'), nowMs: NOW });
      expect(missing.status).toBe('missing');

      const file = path.join(root, 'last-success.json');
      fs.writeFileSync(file, '{broken');
      expect((await readBackupHealth({ checkpointFile: file, nowMs: NOW })).status).toBe('invalid');

      fs.writeFileSync(file, JSON.stringify(checkpoint()));
      const healthy = await readBackupHealth({ checkpointFile: file, nowMs: NOW });
      expect(healthy.status).toBe('fresh');
      expect(healthy).not.toHaveProperty('snapshotId');
      expect(healthy).not.toHaveProperty('rdbSha256');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('strict operational monitoring health', () => {
  test('is healthy only when Redis, worker, pipeline and backup are healthy', () => {
    const result = evaluateMonitoringHealth({
      checkedAtMs: NOW,
      redis: { ok: true },
      worker: healthyWorker(),
      pipeline: healthyPipeline(),
      backup: freshBackup(),
    });
    expect(result.ok).toBe(true);
    expect(result.incidents).toEqual([]);
  });

  test('suppresses worker and pipeline child incidents when Redis is unavailable', () => {
    const result = evaluateMonitoringHealth({
      checkedAtMs: NOW,
      redis: { ok: false },
      worker: null,
      pipeline: null,
      backup: freshBackup(),
    });
    expect(result.incidents).toEqual(['REDIS_NOT_READY']);
    expect(result.checks.worker.state).toBe('unknown');
    expect(result.checks.pipeline.state).toBe('unknown');
  });

  test('reports stale worker, aged queue, pipeline and backup incidents without PII', () => {
    const worker = healthyWorker();
    if (!('runtime' in worker.payload)) throw new Error('worker fixture missing runtime');
    worker.status = 503;
    worker.payload.ok = false;
    worker.payload.status = 'degraded';
    worker.payload.runtime.ok = false;
    worker.payload.runtime.heartbeat.state = 'stale';
    worker.payload.runtime.oldestPending.state = 'critical';
    worker.payload.runtime.oldestPending.ageMs = 700_000;

    const pipeline = healthyPipeline();
    if (!('alerts' in pipeline.payload)) throw new Error('pipeline fixture missing alerts');
    pipeline.payload.ok = false;
    pipeline.payload.retryRateLastHour = 0.5;
    pipeline.payload.dlqLastHour = 1;
    pipeline.payload.metricsDataSource = 'fallback_memory';
    pipeline.payload.metricsDegraded = true;
    pipeline.payload.alerts.retryRateWarning = true;
    pipeline.payload.alerts.queueBackpressure = true;

    const backup = classifyBackupCheckpoint(checkpoint({ completedAt: new Date(NOW - MAX_AGE_MS - 1).toISOString() }), {
      nowMs: NOW,
      maxAgeMs: MAX_AGE_MS,
    });
    const result = evaluateMonitoringHealth({ checkedAtMs: NOW, redis: { ok: true }, worker, pipeline, backup });

    expect(result.ok).toBe(false);
    expect(result.incidents).toEqual(
      expect.arrayContaining([
        'WORKER_HEARTBEAT_STALE',
        'OLDEST_PENDING_CRITICAL',
        'PIPELINE_DLQ',
        'PIPELINE_RETRY_RATE',
        'PIPELINE_QUEUE_BACKPRESSURE',
        'PIPELINE_MEMORY_FALLBACK',
        'BACKUP_STALE',
      ])
    );
    expect(JSON.stringify(result)).not.toMatch(/phone|message|leadId|snapshotId|rdbSha256/i);
  });
});
