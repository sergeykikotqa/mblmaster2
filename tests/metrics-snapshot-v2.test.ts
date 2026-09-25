import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { DailyMetricsSnapshotV2 } from '../src/server/metrics/snapshot';

const mocks = vi.hoisted(() => ({
  hasRedisConfig: vi.fn(),
  redisCommand: vi.fn(),
  assertMemoryFallbackAllowed: vi.fn(),
  getFunnelRollupFull: vi.fn(),
}));

vi.mock('~/server/redis/client', () => ({
  hasRedisConfig: mocks.hasRedisConfig,
  redisCommand: mocks.redisCommand,
  assertMemoryFallbackAllowed: mocks.assertMemoryFallbackAllowed,
}));

vi.mock('~/server/metrics/funnel', () => ({
  getFunnelRollupFull: mocks.getFunnelRollupFull,
}));

import {
  generateDailyMetricsSnapshotV2,
  getStoredDailyMetricsSnapshotV2,
  parseDailyMetricsSnapshotV2,
} from '../src/server/metrics/snapshot';

const TARGET_DAY = '2026-09-23';
const PREFIX = 'snapshot-v2-test';

function rollup(opened: number, submitted: number) {
  return {
    span: 'day',
    bucket: TARGET_DAY,
    generatedAtMs: Date.UTC(2026, 8, 24),
    dataSource: 'redis',
    totalPageViews: 0,
    totalOpened: opened,
    totalSubmitted: submitted,
    conversionRate: null,
    totalOps: {},
    totalOpsReasons: {},
    entries: [],
  };
}

function validSnapshot(overrides: Partial<DailyMetricsSnapshotV2> = {}): DailyMetricsSnapshotV2 {
  return {
    schemaVersion: 2,
    targetDay: TARGET_DAY,
    generatedAtMs: Date.UTC(2026, 8, 24),
    dataSource: 'redis',
    metricsDegraded: false,
    counters: { opened: 30, submitted: 12 },
    ...overrides,
  };
}

describe('metrics snapshot v2 isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CONTACT_REDIS_PREFIX', PREFIX);
    mocks.hasRedisConfig.mockReturnValue(true);
    mocks.assertMemoryFallbackAllowed.mockImplementation((error?: unknown) => {
      if (error) throw error;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test('writes only current raw counters to the v2 namespace', async () => {
    mocks.getFunnelRollupFull.mockResolvedValue(rollup(30, 12));
    mocks.redisCommand.mockResolvedValue('OK');

    const result = await generateDailyMetricsSnapshotV2({ targetDay: TARGET_DAY });

    expect(mocks.getFunnelRollupFull).toHaveBeenCalledTimes(1);
    expect(mocks.getFunnelRollupFull).toHaveBeenCalledWith({ span: 'day', bucket: TARGET_DAY });
    expect(result.storageSource).toBe('redis');
    expect(result.snapshot).toMatchObject({
      schemaVersion: 2,
      targetDay: TARGET_DAY,
      dataSource: 'redis',
      metricsDegraded: false,
      counters: { opened: 30, submitted: 12 },
    });

    expect(mocks.redisCommand).toHaveBeenCalledTimes(1);
    const [command, key, raw, expiryMode, ttl] = mocks.redisCommand.mock.calls[0]!;
    expect([command, key, expiryMode]).toEqual(['SET', `${PREFIX}:metrics:snapshot:v2:day:${TARGET_DAY}`, 'EX']);
    expect(ttl).toBeGreaterThan(0);

    const persisted = JSON.parse(String(raw));
    expect(persisted).toEqual(result.snapshot);
    expect(Object.keys(persisted).sort()).toEqual(
      ['schemaVersion', 'targetDay', 'generatedAtMs', 'dataSource', 'metricsDegraded', 'counters'].sort()
    );
    expect(persisted.counters).toEqual({ opened: 30, submitted: 12 });
    expect(persisted).not.toHaveProperty('storageSource');
    expect(String(key)).not.toBe(`${PREFIX}:metrics:snapshot:day:${TARGET_DAY}`);
    expect(JSON.stringify(persisted)).not.toMatch(
      /"baselineDays"|"baselineAvgOpened"|"baselineAvgSubmitted"|"volumeDiagnostics"|"conversionRate"|"cr_drop"|"zero_submitted"|"opened_up_submitted_down"/
    );
  });

  test('rejects an invalid calendar day before reading or writing storage', async () => {
    await expect(generateDailyMetricsSnapshotV2({ targetDay: '2026-02-31' })).rejects.toThrow(
      'INVALID_METRICS_SNAPSHOT_DAY'
    );
    expect(mocks.getFunnelRollupFull).not.toHaveBeenCalled();
    expect(mocks.redisCommand).not.toHaveBeenCalled();
  });

  test('accepts the exact minimal v2 payload', () => {
    const valid = validSnapshot();
    expect(parseDailyMetricsSnapshotV2(JSON.stringify(valid))).toEqual(valid);
  });

  test('returns Redis storage metadata only after a valid read', async () => {
    const valid = validSnapshot();
    mocks.redisCommand.mockResolvedValue(JSON.stringify(valid));

    await expect(getStoredDailyMetricsSnapshotV2(TARGET_DAY)).resolves.toEqual({
      snapshot: valid,
      storageSource: 'redis',
    });
    expect(mocks.redisCommand).toHaveBeenCalledWith('GET', `${PREFIX}:metrics:snapshot:v2:day:${TARGET_DAY}`);
  });

  test('rejects a valid payload whose target day does not match the Redis key day', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mismatched = validSnapshot({ targetDay: '2026-09-24' });
    expect(parseDailyMetricsSnapshotV2(JSON.stringify(mismatched))).toEqual(mismatched);
    mocks.redisCommand.mockResolvedValue(JSON.stringify(mismatched));

    const result = await getStoredDailyMetricsSnapshotV2(TARGET_DAY);

    expect(result).toBeNull();
    expect(result).not.toEqual({ snapshot: mismatched, storageSource: 'redis' });
    expect(mocks.redisCommand).toHaveBeenCalledWith('GET', `${PREFIX}:metrics:snapshot:v2:day:${TARGET_DAY}`);
  });

  test.each([
    ['null root', JSON.stringify(null)],
    ['array root', JSON.stringify([])],
    ['string root', JSON.stringify('snapshot')],
    ['unknown schema version', JSON.stringify({ ...validSnapshot(), schemaVersion: 3 })],
    ['legacy payload', JSON.stringify({ targetDay: TARGET_DAY, rows: [], anomalies: [{ reason: 'cr_drop' }] })],
    [
      'previous baseline v2 shape',
      JSON.stringify({
        ...validSnapshot(),
        baselineDays: 7,
        rows: [],
        volumeDiagnostics: [],
        summary: { rows: 0, volumeDiagnostics: 0, byReason: {} },
      }),
    ],
    ['missing required field', JSON.stringify((({ generatedAtMs: _generatedAtMs, ...rest }) => rest)(validSnapshot()))],
    ['wrong field type', JSON.stringify({ ...validSnapshot(), counters: { opened: '30', submitted: 12 } })],
    ['negative counter', JSON.stringify({ ...validSnapshot(), counters: { opened: -1, submitted: 12 } })],
    ['non-integer counter', JSON.stringify({ ...validSnapshot(), counters: { opened: 1.5, submitted: 12 } })],
    [
      'unsafe integer counter',
      JSON.stringify({ ...validSnapshot(), counters: { opened: Number.MAX_SAFE_INTEGER + 1, submitted: 12 } }),
    ],
    ['extra root field', JSON.stringify({ ...validSnapshot(), storageSource: 'redis' })],
    [
      'extra nested field',
      JSON.stringify({ ...validSnapshot(), counters: { opened: 30, submitted: 12, conversionRate: 0.4 } }),
    ],
    ['invalid February date', JSON.stringify(validSnapshot({ targetDay: '2026-02-31' }))],
    ['invalid month', JSON.stringify(validSnapshot({ targetDay: '2026-13-01' }))],
    ['invalid zero month', JSON.stringify(validSnapshot({ targetDay: '2026-00-10' }))],
    ['invalid April date', JSON.stringify(validSnapshot({ targetDay: '2026-04-31' }))],
    ['invalid date format', JSON.stringify(validSnapshot({ targetDay: '2026-9-23' }))],
    ['contradictory Redis degradation', JSON.stringify(validSnapshot({ dataSource: 'redis', metricsDegraded: true }))],
    [
      'contradictory memory degradation',
      JSON.stringify(validSnapshot({ dataSource: 'memory', metricsDegraded: false })),
    ],
  ])('rejects hostile payload: %s', (_label, raw) => {
    expect(parseDailyMetricsSnapshotV2(raw)).toBeNull();
  });

  test('returns controlled null for malformed JSON and never reads the legacy key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseDailyMetricsSnapshotV2('{not-json')).toBeNull();
    mocks.redisCommand.mockResolvedValue('{not-json');

    await expect(getStoredDailyMetricsSnapshotV2(TARGET_DAY)).resolves.toBeNull();

    expect(mocks.redisCommand).toHaveBeenCalledWith('GET', `${PREFIX}:metrics:snapshot:v2:day:${TARGET_DAY}`);
    expect(mocks.redisCommand.mock.calls.flat()).not.toContain(`${PREFIX}:metrics:snapshot:day:${TARGET_DAY}`);
  });
});
