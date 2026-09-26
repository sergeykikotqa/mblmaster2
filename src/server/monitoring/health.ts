import {
  buildPipelineHealthCheck,
  buildWorkerHealthCheck,
  type AdminPipelineHealthPayload,
  type AdminWorkerHealthPayload,
} from '~/server/admin/health-checks';
import { probeRedisReadiness } from '~/server/health/runtime';

import { readBackupHealth, type BackupHealth } from './backup-health';

export type MonitoringIncidentCode =
  | 'REDIS_NOT_READY'
  | 'WORKER_DEGRADED'
  | 'WORKER_HEARTBEAT_MISSING'
  | 'WORKER_HEARTBEAT_STALE'
  | 'WORKER_HEARTBEAT_ERROR'
  | 'WORKER_PAUSED'
  | 'OLDEST_PENDING_WARNING'
  | 'OLDEST_PENDING_CRITICAL'
  | 'PIPELINE_DEGRADED'
  | 'PIPELINE_DLQ'
  | 'PIPELINE_RETRY_RATE'
  | 'PIPELINE_QUEUE_BACKPRESSURE'
  | 'PIPELINE_MEMORY_FALLBACK'
  | 'BACKUP_MISSING'
  | 'BACKUP_INVALID'
  | 'BACKUP_STALE';

type WorkerObservation = {
  state: 'healthy' | 'degraded' | 'unknown';
  heartbeatState: string | null;
  heartbeatStatus: string | null;
  heartbeatAgeMs: number | null;
  oldestPendingState: string | null;
  oldestPendingAgeMs: number | null;
};

type PipelineObservation = {
  state: 'healthy' | 'degraded' | 'unknown';
  metricsDataSource: string | null;
  queueDepth: number | null;
  dlqLastHour: number | null;
  retryRateWarning: boolean | null;
  queueBackpressure: boolean | null;
};

export type MonitoringHealthPayload = {
  ok: boolean;
  service: 'mbl-production';
  checkedAtMs: number;
  incidents: MonitoringIncidentCode[];
  checks: {
    redis: { ok: boolean };
    worker: WorkerObservation;
    pipeline: PipelineObservation;
    backup: BackupHealth;
  };
};

type WorkerCheck = Awaited<ReturnType<typeof buildWorkerHealthCheck>>;
type PipelineCheck = Awaited<ReturnType<typeof buildPipelineHealthCheck>>;
type PipelinePayload = Extract<AdminPipelineHealthPayload, { service: 'lead-pipeline' }>;

export type MonitoringInputs = {
  checkedAtMs?: number;
  redis: { ok: boolean };
  worker: WorkerCheck | null;
  pipeline: PipelineCheck | null;
  backup: BackupHealth;
};

function addIncident(incidents: Set<MonitoringIncidentCode>, code: MonitoringIncidentCode, condition: boolean) {
  if (condition) incidents.add(code);
}

function workerPayload(check: WorkerCheck | null): AdminWorkerHealthPayload | null {
  return check?.payload && 'runtime' in check.payload ? check.payload : null;
}

function pipelinePayload(check: PipelineCheck | null): PipelinePayload | null {
  return check?.payload && 'alerts' in check.payload ? (check.payload as PipelinePayload) : null;
}

export function evaluateMonitoringHealth(inputs: MonitoringInputs): MonitoringHealthPayload {
  const incidents = new Set<MonitoringIncidentCode>();
  addIncident(incidents, 'REDIS_NOT_READY', !inputs.redis.ok);

  const worker = workerPayload(inputs.worker);
  const workerRuntime = worker?.runtime;
  const heartbeatState = workerRuntime?.heartbeat.state || null;
  const heartbeatStatus = workerRuntime?.heartbeat.value?.status || null;
  const oldestPendingState = workerRuntime?.oldestPending.state || null;
  const workerPaused = Boolean(worker?.dependencies?.workerPaused);
  if (inputs.redis.ok) {
    addIncident(incidents, 'WORKER_DEGRADED', !worker || inputs.worker?.status !== 200 || !worker.ok);
    addIncident(incidents, 'WORKER_HEARTBEAT_MISSING', heartbeatState === 'missing');
    addIncident(incidents, 'WORKER_HEARTBEAT_STALE', heartbeatState === 'stale');
    addIncident(incidents, 'WORKER_HEARTBEAT_ERROR', heartbeatState === 'unavailable' || heartbeatStatus === 'error');
    addIncident(incidents, 'WORKER_PAUSED', workerPaused || heartbeatStatus === 'paused');
    addIncident(incidents, 'OLDEST_PENDING_WARNING', oldestPendingState === 'warning');
    addIncident(incidents, 'OLDEST_PENDING_CRITICAL', oldestPendingState === 'critical');
  }

  const pipeline = pipelinePayload(inputs.pipeline);
  const retryRateWarning = pipeline?.alerts.retryRateWarning ?? null;
  const queueBackpressure = pipeline?.alerts.queueBackpressure ?? null;
  if (inputs.redis.ok) {
    addIncident(incidents, 'PIPELINE_DEGRADED', !pipeline || inputs.pipeline?.status !== 200 || !pipeline.ok);
    addIncident(incidents, 'PIPELINE_DLQ', (pipeline?.dlqLastHour || 0) > 0);
    addIncident(incidents, 'PIPELINE_RETRY_RATE', retryRateWarning === true);
    addIncident(incidents, 'PIPELINE_QUEUE_BACKPRESSURE', queueBackpressure === true);
    addIncident(
      incidents,
      'PIPELINE_MEMORY_FALLBACK',
      Boolean(pipeline && (pipeline.metricsDataSource !== 'redis' || pipeline.metricsDegraded))
    );
  }

  addIncident(incidents, 'BACKUP_MISSING', inputs.backup.status === 'missing');
  addIncident(incidents, 'BACKUP_INVALID', inputs.backup.status === 'invalid');
  addIncident(incidents, 'BACKUP_STALE', inputs.backup.status === 'stale');

  const incidentList = [...incidents].sort();
  return {
    ok: incidentList.length === 0,
    service: 'mbl-production',
    checkedAtMs: inputs.checkedAtMs ?? Date.now(),
    incidents: incidentList,
    checks: {
      redis: { ok: inputs.redis.ok },
      worker: {
        state: !inputs.redis.ok ? 'unknown' : worker?.ok ? 'healthy' : 'degraded',
        heartbeatState,
        heartbeatStatus,
        heartbeatAgeMs: workerRuntime?.heartbeat.ageMs ?? null,
        oldestPendingState,
        oldestPendingAgeMs: workerRuntime?.oldestPending.ageMs ?? null,
      },
      pipeline: {
        state: !inputs.redis.ok ? 'unknown' : pipeline?.ok ? 'healthy' : 'degraded',
        metricsDataSource: pipeline?.metricsDataSource || null,
        queueDepth: pipeline?.queueDepth ?? null,
        dlqLastHour: pipeline?.dlqLastHour ?? null,
        retryRateWarning,
        queueBackpressure,
      },
      backup: inputs.backup,
    },
  };
}

export async function buildMonitoringHealth(): Promise<MonitoringHealthPayload> {
  const checkedAtMs = Date.now();
  const [redis, backup] = await Promise.all([probeRedisReadiness(), readBackupHealth({ nowMs: checkedAtMs })]);
  if (!redis.ok) {
    return evaluateMonitoringHealth({ checkedAtMs, redis, worker: null, pipeline: null, backup });
  }

  const [worker, pipeline] = await Promise.all([
    buildWorkerHealthCheck('bearer'),
    buildPipelineHealthCheck('bearer', { strictMode: true }),
  ]);
  return evaluateMonitoringHealth({ checkedAtMs, redis, worker, pipeline, backup });
}
