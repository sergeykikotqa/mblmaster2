import type { HealthScope, HealthState, HealthStateRecord, HealthTransitionEvent } from './health-types';

export type HealthStateStoreSource = 'redis' | 'memory';

export type HealthStateStoreResult<T> = {
  value: T;
  dataSource: HealthStateStoreSource;
  degraded: boolean;
};

export type HealthStateStoreRuntimeStats = {
  redisFallbackToMemoryCount: number;
  redisFallbackToMemoryLastAtMs: number;
};

type UpstashResponse<T> = {
  result?: T;
  error?: string;
};

const DEFAULT_TRANSITION_MAXLEN = 5000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 2000;

const memoryStates = new Map<string, HealthStateRecord>();
const memoryTransitions: HealthTransitionEvent[] = [];

const runtimeStats: HealthStateStoreRuntimeStats = {
  redisFallbackToMemoryCount: 0,
  redisFallbackToMemoryLastAtMs: 0,
};

function markFallbackMemory(reason: string) {
  runtimeStats.redisFallbackToMemoryCount += 1;
  runtimeStats.redisFallbackToMemoryLastAtMs = Date.now();
  console.warn('[health-state-store] redis_fallback_memory', {
    reason,
    healthStateFallbackMemory: true,
    redisFallbackToMemoryCount: runtimeStats.redisFallbackToMemoryCount,
    redisFallbackToMemoryLastAtMs: runtimeStats.redisFallbackToMemoryLastAtMs,
  });
}

export function getHealthStateStoreRuntimeStats(): HealthStateStoreRuntimeStats {
  return { ...runtimeStats };
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveTransitionMaxLen(): number {
  return parsePositiveInt(process.env.METRICS_HEALTH_TRANSITION_MAXLEN, DEFAULT_TRANSITION_MAXLEN, 100);
}

function asListLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(value as number)));
}

function resolvePrefix(): string {
  const value = (process.env.CONTACT_REDIS_PREFIX || '').trim();
  if (!value) return 'lead';
  return value.replace(/[^a-zA-Z0-9:_-]/g, '-');
}

function hasRedisConfig(): boolean {
  const endpoint = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  return Boolean(endpoint && token);
}

function getRedisConfig() {
  return {
    endpoint: (process.env.UPSTASH_REDIS_REST_URL || '').trim(),
    token: (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim(),
  };
}

async function redisCommand<T>(...args: Array<string | number>): Promise<T> {
  const { endpoint, token } = getRedisConfig();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    throw new Error(`REDIS_HTTP_${response.status}`);
  }

  const payload = (await response.json()) as UpstashResponse<T>;
  if (payload.error) {
    throw new Error(`REDIS_COMMAND_ERROR:${payload.error}`);
  }

  return payload.result as T;
}

function statesKey(): string {
  return `${resolvePrefix()}:metrics:health:states`;
}

function transitionsKey(): string {
  return `${resolvePrefix()}:metrics:health:transitions`;
}

function makeStateField(scope: HealthScope, key: string): string {
  return `${scope}|${String(key || '').trim()}`;
}

function parseStateField(field: string): { scope: HealthScope; key: string } | null {
  const [scopeRaw, ...rest] = String(field || '').split('|');
  const key = rest.join('|').trim();
  const scope = scopeRaw as HealthScope;
  if (!key) return null;
  if (!['global', 'city', 'service', 'city_service', 'page_type'].includes(scope)) return null;
  return { scope, key };
}

function normalizeIso(value: unknown, fallbackMs: number): string {
  const parsedMs = Date.parse(String(value || ''));
  if (!Number.isFinite(parsedMs)) return new Date(fallbackMs).toISOString();
  return new Date(parsedMs).toISOString();
}

function normalizeState(value: unknown): HealthState | null {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  if (candidate === 'HEALTHY') return candidate;
  if (candidate === 'DEGRADED') return candidate;
  if (candidate === 'CRITICAL') return candidate;
  if (candidate === 'RECOVERING') return candidate;
  return null;
}

function normalizeStateRecord(value: unknown): HealthStateRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<HealthStateRecord>;
  const scope = raw.scope as HealthScope;
  if (!['global', 'city', 'service', 'city_service', 'page_type'].includes(String(scope || ''))) return null;
  const key = String(raw.key || '').trim();
  const state = normalizeState(raw.state);
  if (!key || !state) return null;

  const previousState = raw.previousState ? normalizeState(raw.previousState) : null;
  const stableDays = Math.max(0, Number.isFinite(raw.stableDays) ? Math.floor(raw.stableDays as number) : 0);
  const nowMs = Date.now();

  return {
    scope,
    key,
    state,
    since: normalizeIso(raw.since, nowMs),
    previousState,
    stableDays,
    updatedAtMs: Number.isFinite(raw.updatedAtMs) ? Math.floor(raw.updatedAtMs as number) : nowMs,
  };
}

function normalizeTransitionEvent(value: unknown): HealthTransitionEvent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<HealthTransitionEvent>;
  const scope = raw.scope as HealthScope;
  if (!['global', 'city', 'service', 'city_service', 'page_type'].includes(String(scope || ''))) return null;

  const key = String(raw.key || '').trim();
  const from = normalizeState(raw.from);
  const to = normalizeState(raw.to);
  if (!key || !from || !to) return null;

  return {
    scope,
    key,
    from,
    to,
    at: normalizeIso(raw.at, Date.now()),
    reason: String(raw.reason || '').trim() || 'state_transition',
    stableDays: Math.max(0, Number.isFinite(raw.stableDays) ? Math.floor(raw.stableDays as number) : 0),
  };
}

function normalizeRedisHash(raw: unknown): Record<string, string> {
  if (!raw) return {};

  if (Array.isArray(raw)) {
    const result: Record<string, string> = {};
    for (let i = 0; i < raw.length; i += 2) {
      const field = String(raw[i] || '');
      const value = raw[i + 1];
      if (!field) continue;
      result[field] = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    }
    return result;
  }

  if (typeof raw === 'object') {
    const result: Record<string, string> = {};
    for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!field) continue;
      result[field] = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    }
    return result;
  }

  return {};
}

function memoryTransitionPush(event: HealthTransitionEvent) {
  memoryTransitions.unshift(event);
  const maxLen = resolveTransitionMaxLen();
  if (memoryTransitions.length > maxLen) {
    memoryTransitions.length = maxLen;
  }
}

function parseStatePayload(rawPayload: string): HealthStateRecord | null {
  if (typeof rawPayload !== 'string' || !rawPayload.trim()) return null;
  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    return normalizeStateRecord(parsed);
  } catch {
    return null;
  }
}

function parseTransitionPayload(rawPayload: string): HealthTransitionEvent | null {
  if (typeof rawPayload !== 'string' || !rawPayload.trim()) return null;
  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    return normalizeTransitionEvent(parsed);
  } catch {
    return null;
  }
}

function sortStates(records: HealthStateRecord[]): HealthStateRecord[] {
  return records.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export async function getHealthState(
  scope: HealthScope,
  key: string
): Promise<HealthStateStoreResult<HealthStateRecord | null>> {
  const field = makeStateField(scope, key);

  if (hasRedisConfig()) {
    try {
      const raw = await redisCommand<string | null>('HGET', statesKey(), field);
      const record = typeof raw === 'string' ? parseStatePayload(raw) : null;
      return {
        value: record,
        dataSource: 'redis',
        degraded: false,
      };
    } catch (error) {
      markFallbackMemory(`get_state:${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
  }

  return {
    value: memoryStates.get(field) || null,
    dataSource: 'memory',
    degraded: true,
  };
}

export async function upsertHealthState(record: HealthStateRecord): Promise<HealthStateStoreResult<HealthStateRecord>> {
  const normalized = normalizeStateRecord(record);
  if (!normalized) {
    throw new Error('INVALID_HEALTH_STATE_RECORD');
  }

  const field = makeStateField(normalized.scope, normalized.key);
  const payload = JSON.stringify(normalized);

  if (hasRedisConfig()) {
    try {
      await redisCommand('HSET', statesKey(), field, payload);
      return {
        value: normalized,
        dataSource: 'redis',
        degraded: false,
      };
    } catch (error) {
      markFallbackMemory(`upsert_state:${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
  }

  memoryStates.set(field, normalized);
  return {
    value: normalized,
    dataSource: 'memory',
    degraded: true,
  };
}

export async function listHealthStates(params?: {
  scope?: HealthScope;
  limit?: number;
}): Promise<HealthStateStoreResult<HealthStateRecord[]>> {
  const limit = asListLimit(params?.limit);
  const requestedScope = params?.scope;

  if (hasRedisConfig()) {
    try {
      const raw = await redisCommand<unknown>('HGETALL', statesKey());
      const hash = normalizeRedisHash(raw);
      const records: HealthStateRecord[] = [];

      for (const [field, payload] of Object.entries(hash)) {
        const parsedField = parseStateField(field);
        if (!parsedField) continue;
        if (requestedScope && parsedField.scope !== requestedScope) continue;
        const record = parseStatePayload(payload);
        if (!record) continue;
        records.push(record);
      }

      return {
        value: sortStates(records).slice(0, limit),
        dataSource: 'redis',
        degraded: false,
      };
    } catch (error) {
      markFallbackMemory(`list_states:${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
  }

  const memoryRecords = [...memoryStates.values()].filter((record) =>
    requestedScope ? record.scope === requestedScope : true
  );
  return {
    value: sortStates(memoryRecords).slice(0, limit),
    dataSource: 'memory',
    degraded: true,
  };
}

export async function appendHealthTransition(
  event: HealthTransitionEvent
): Promise<HealthStateStoreResult<HealthTransitionEvent>> {
  const normalized = normalizeTransitionEvent(event);
  if (!normalized) {
    throw new Error('INVALID_HEALTH_TRANSITION_EVENT');
  }

  if (hasRedisConfig()) {
    try {
      await redisCommand(
        'XADD',
        transitionsKey(),
        'MAXLEN',
        '~',
        resolveTransitionMaxLen(),
        '*',
        'payload',
        JSON.stringify(normalized)
      );
      return {
        value: normalized,
        dataSource: 'redis',
        degraded: false,
      };
    } catch (error) {
      markFallbackMemory(`append_transition:${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
  }

  memoryTransitionPush(normalized);
  return {
    value: normalized,
    dataSource: 'memory',
    degraded: true,
  };
}

function parseStreamEntries(raw: unknown): HealthTransitionEvent[] {
  if (!Array.isArray(raw)) return [];
  const transitions: HealthTransitionEvent[] = [];

  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const fieldsRaw = row[1];

    let payloadValue = '';
    if (Array.isArray(fieldsRaw)) {
      for (let i = 0; i < fieldsRaw.length; i += 2) {
        const field = String(fieldsRaw[i] || '');
        const value = fieldsRaw[i + 1];
        if (field === 'payload') {
          payloadValue = typeof value === 'string' ? value : JSON.stringify(value ?? null);
          break;
        }
      }
    } else if (fieldsRaw && typeof fieldsRaw === 'object') {
      const maybePayload = (fieldsRaw as Record<string, unknown>).payload;
      payloadValue = typeof maybePayload === 'string' ? maybePayload : JSON.stringify(maybePayload ?? null);
    }

    const parsed = parseTransitionPayload(payloadValue);
    if (parsed) {
      transitions.push(parsed);
    }
  }

  return transitions;
}

export async function getHealthTransitionHistory(params?: {
  limit?: number;
}): Promise<HealthStateStoreResult<HealthTransitionEvent[]>> {
  const limit = asListLimit(params?.limit);

  if (hasRedisConfig()) {
    try {
      const raw = await redisCommand<unknown>('XREVRANGE', transitionsKey(), '+', '-', 'COUNT', limit);
      return {
        value: parseStreamEntries(raw).slice(0, limit),
        dataSource: 'redis',
        degraded: false,
      };
    } catch (error) {
      markFallbackMemory(`get_transition_history:${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
  }

  return {
    value: memoryTransitions.slice(0, limit),
    dataSource: 'memory',
    degraded: true,
  };
}
