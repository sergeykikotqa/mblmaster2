import { createHash } from 'node:crypto';
import { getGeneratedPageBySlug } from '~/lib/geo-data';

type FunnelConversionEventName = 'page_view' | 'form_opened' | 'form_submitted';
type FunnelOpsEventName =
  | 'form_view'
  | 'form_focus'
  | 'form_first_input_focus'
  | 'form_start'
  | 'form_progress'
  | 'form_phone_valid'
  | 'form_submit_attempt'
  | 'form_submit_success'
  | 'form_validation_error'
  | 'form_submit_blocked'
  | 'form_abandoned';

export type FunnelEventName = FunnelConversionEventName | FunnelOpsEventName;

type FunnelDimensions = {
  pageSlug: string;
  city: string;
  district: string;
  service: string;
  pageType: string;
};

type FunnelOpsCounts = {
  formView: number;
  formFocus: number;
  formFirstInputFocus: number;
  formStart: number;
  formProgress: number;
  formPhoneValid: number;
  formSubmitAttempt: number;
  formSubmitSuccess: number;
  formValidationError: number;
  formSubmitBlocked: number;
  formAbandoned: number;
};

type FunnelOpsReasonCounts = {
  validationErrors: Record<string, number>;
  submitBlocked: Record<string, number>;
};

export type FunnelStoreSource = 'redis' | 'memory';

export type FunnelRollupEntry = {
  pageSlug: string;
  city: string;
  district: string;
  service: string;
  pageType: string;
  pageViews: number;
  formOpened: number;
  formSubmitted: number;
  conversionRate: number;
  ops: FunnelOpsCounts;
  opsReasons: FunnelOpsReasonCounts;
};

export type FunnelRollup = {
  span: 'hour' | 'day';
  bucket: string;
  generatedAtMs: number;
  dataSource: FunnelStoreSource;
  totalPageViews: number;
  totalOpened: number;
  totalSubmitted: number;
  conversionRate: number;
  totalOps: FunnelOpsCounts;
  totalOpsReasons: FunnelOpsReasonCounts;
  entries: FunnelRollupEntry[];
};

type FunnelRecordParams = {
  eventName: FunnelEventName;
  pageSlug: string;
  city?: string;
  district?: string;
  service?: string;
  pageType?: string;
  timestampMs?: number;
  reason?: string;
};

type FunnelRollupParams = {
  span: 'hour' | 'day';
  bucket?: string;
  city?: string;
  district?: string;
  service?: string;
  pageType?: string;
  pageSlug?: string;
  limit?: number;
};

type UpstashResponse<T> = {
  result?: T;
  error?: string;
};

const DEFAULT_HOUR_RETENTION_SEC = 60 * 60 * 24 * 14;
const DEFAULT_DAY_RETENTION_SEC = 60 * 60 * 24 * 90;
const DEFAULT_LIMIT = 20;
const DEFAULT_TRACK_RATE_LIMIT_WINDOW_SEC = 60;
const DEFAULT_TRACK_RATE_LIMIT_IP_MAX = 240;
const DEFAULT_TRACK_RATE_LIMIT_PAGE_MAX = 120;

type MemoryHashState = {
  values: Map<string, number>;
  expiresAtMs: number;
};

type MemoryRateLimitState = {
  count: number;
  expiresAtMs: number;
};

const memoryHashes = new Map<string, MemoryHashState>();
const memoryTrackRateLimits = new Map<string, MemoryRateLimitState>();

export type TrackRateLimitResult = {
  allowed: boolean;
  retryAfterSec: number;
  ipCount: number;
  pageCount: number;
  dataSource: FunnelStoreSource;
};

function sanitizeToken(value: unknown, maxLength: number): string {
  const input = typeof value === 'string' ? value : '';
  return input
    .trim()
    .slice(0, maxLength)
    .replace(/[^a-zA-Z0-9/_:-]+/g, '');
}

function sanitizeReason(value: unknown): string {
  return sanitizeToken(value, 64);
}

function sanitizePageSlug(value: unknown): string {
  if (typeof value !== 'string') return '';
  const input = value.trim();
  if (!input) return '';
  if (input.startsWith('/')) return normalizePath(input);
  try {
    const url = new URL(input);
    return normalizePath(url.pathname);
  } catch {
    return '';
  }
}

function normalizePath(pathname: string): string {
  const normalized = `/${String(pathname || '').replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
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

function keyFor(span: 'hour' | 'day', bucket: string): string {
  return `${resolvePrefix()}:metrics:funnel:${span}:${bucket}`;
}

function keyForTrackRateLimit(kind: 'ip' | 'page', identityHash: string): string {
  return `${resolvePrefix()}:ratelimit:track:${kind}:${identityHash}`;
}

function nowHourBucket(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 13);
}

function nowDayBucket(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function normalizeBucket(span: 'hour' | 'day', bucket?: string): string {
  if (!bucket) {
    const now = Date.now();
    return span === 'hour' ? nowHourBucket(now) : nowDayBucket(now);
  }
  const normalized = bucket.trim();
  const pattern = span === 'hour' ? /^\d{4}-\d{2}-\d{2}T\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
  return pattern.test(normalized) ? normalized : span === 'hour' ? nowHourBucket(Date.now()) : nowDayBucket(Date.now());
}

function toDimension(params: {
  pageSlug?: unknown;
  city?: unknown;
  district?: unknown;
  service?: unknown;
  pageType?: unknown;
}): FunnelDimensions | null {
  const pageSlug = sanitizePageSlug(params.pageSlug);
  if (!pageSlug || pageSlug === '/') return null;
  const generatedPage = getGeneratedPageBySlug(pageSlug);
  if (!generatedPage) return null;

  return {
    pageSlug: generatedPage.pageSlug,
    city: generatedPage.cityId,
    district: '',
    service: generatedPage.serviceId,
    pageType: generatedPage.pageType,
  };
}

export function resolveFunnelDimensions(params: {
  pageSlug?: unknown;
  city?: unknown;
  district?: unknown;
  service?: unknown;
  pageType?: unknown;
  fallbackPage?: unknown;
}): FunnelDimensions | null {
  return toDimension({
    pageSlug: params.pageSlug || params.fallbackPage,
  });
}

function createEmptyOpsCounts(): FunnelOpsCounts {
  return {
    formView: 0,
    formFocus: 0,
    formFirstInputFocus: 0,
    formStart: 0,
    formProgress: 0,
    formPhoneValid: 0,
    formSubmitAttempt: 0,
    formSubmitSuccess: 0,
    formValidationError: 0,
    formSubmitBlocked: 0,
    formAbandoned: 0,
  };
}

function createEmptyOpsReasonCounts(): FunnelOpsReasonCounts {
  return {
    validationErrors: {},
    submitBlocked: {},
  };
}

function encodeField(eventName: FunnelEventName, dimensions: FunnelDimensions, reason?: string): string {
  return [
    eventName,
    encodeURIComponent(dimensions.pageSlug),
    encodeURIComponent(dimensions.city),
    encodeURIComponent(dimensions.district),
    encodeURIComponent(dimensions.service),
    encodeURIComponent(dimensions.pageType),
    encodeURIComponent(sanitizeReason(reason)),
  ].join('|');
}

function decodeField(field: string): { eventName: FunnelEventName; dimensions: FunnelDimensions; reason: string } | null {
  const parts = String(field || '').split('|');
  if (parts.length !== 6 && parts.length !== 7) return null;
  const eventName = parts[0] as FunnelEventName;
  if (
    eventName !== 'page_view' &&
    eventName !== 'form_opened' &&
    eventName !== 'form_submitted' &&
    eventName !== 'form_view' &&
    eventName !== 'form_focus' &&
    eventName !== 'form_first_input_focus' &&
    eventName !== 'form_start' &&
    eventName !== 'form_progress' &&
    eventName !== 'form_phone_valid' &&
    eventName !== 'form_submit_attempt' &&
    eventName !== 'form_submit_success' &&
    eventName !== 'form_validation_error' &&
    eventName !== 'form_submit_blocked' &&
    eventName !== 'form_abandoned'
  )
    return null;

  try {
    return {
      eventName,
      dimensions: {
        pageSlug: sanitizePageSlug(decodeURIComponent(parts[1] || '')),
        city: sanitizeToken(decodeURIComponent(parts[2] || ''), 64),
        district: sanitizeToken(decodeURIComponent(parts[3] || ''), 64),
        service: sanitizeToken(decodeURIComponent(parts[4] || ''), 64),
        pageType: sanitizeToken(decodeURIComponent(parts[5] || ''), 64),
      },
      reason: sanitizeReason(parts[6] ? decodeURIComponent(parts[6]) : ''),
    };
  } catch {
    return null;
  }
}

function incrementReasonCount(target: Record<string, number>, reason: string, count: number) {
  const key = sanitizeReason(reason);
  if (!key) return;
  target[key] = (target[key] || 0) + count;
}

function incrementOpsCount(target: FunnelOpsCounts, eventName: FunnelOpsEventName, count: number) {
  switch (eventName) {
    case 'form_view':
      target.formView += count;
      break;
    case 'form_focus':
      target.formFocus += count;
      break;
    case 'form_first_input_focus':
      target.formFirstInputFocus += count;
      break;
    case 'form_start':
      target.formStart += count;
      break;
    case 'form_progress':
      target.formProgress += count;
      break;
    case 'form_phone_valid':
      target.formPhoneValid += count;
      break;
    case 'form_submit_attempt':
      target.formSubmitAttempt += count;
      break;
    case 'form_submit_success':
      target.formSubmitSuccess += count;
      break;
    case 'form_validation_error':
      target.formValidationError += count;
      break;
    case 'form_submit_blocked':
      target.formSubmitBlocked += count;
      break;
    case 'form_abandoned':
      target.formAbandoned += count;
      break;
  }
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

function rememberMemoryHash(key: string, ttlSec: number) {
  const nowMs = Date.now();
  const expiresAtMs = nowMs + ttlSec * 1000;
  const current = memoryHashes.get(key);
  if (current) {
    current.expiresAtMs = Math.max(current.expiresAtMs, expiresAtMs);
    return current;
  }

  const state: MemoryHashState = {
    values: new Map(),
    expiresAtMs,
  };
  memoryHashes.set(key, state);
  return state;
}

function cleanupMemoryHashes(nowMs: number) {
  for (const [key, state] of memoryHashes.entries()) {
    if (state.expiresAtMs <= nowMs) {
      memoryHashes.delete(key);
    }
  }
}

function recordMemoryMetric(key: string, field: string, ttlSec: number) {
  cleanupMemoryHashes(Date.now());
  const state = rememberMemoryHash(key, ttlSec);
  const current = Number(state.values.get(field) || 0);
  state.values.set(field, current + 1);
}

function readMemoryHash(key: string): Record<string, number> {
  cleanupMemoryHashes(Date.now());
  const state = memoryHashes.get(key);
  if (!state) return {};

  const result: Record<string, number> = {};
  for (const [field, value] of state.values.entries()) {
    result[field] = value;
  }
  return result;
}

function normalizeRedisHash(raw: unknown): Record<string, number> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const result: Record<string, number> = {};
    for (let i = 0; i < raw.length; i += 2) {
      const field = String(raw[i] || '');
      const value = Number(raw[i + 1]);
      if (!field) continue;
      if (!Number.isFinite(value)) continue;
      result[field] = value;
    }
    return result;
  }

  if (typeof raw === 'object') {
    const result: Record<string, number> = {};
    for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
      const count = Number(value);
      if (!field || !Number.isFinite(count)) continue;
      result[field] = count;
    }
    return result;
  }

  return {};
}

function matchesFilter(value: string, filterValue: string | undefined): boolean {
  if (!filterValue) return true;
  return value === sanitizeToken(filterValue, 64) || value === sanitizePageSlug(filterValue);
}

function asLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(200, Math.floor(value as number)));
}

function hashIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function resolveTrackRateLimitWindowSec(): number {
  return parsePositiveInt(process.env.TRACK_RATE_LIMIT_WINDOW_SEC, DEFAULT_TRACK_RATE_LIMIT_WINDOW_SEC, 10);
}

function resolveTrackRateLimitIpMax(): number {
  return parsePositiveInt(process.env.TRACK_RATE_LIMIT_IP_MAX, DEFAULT_TRACK_RATE_LIMIT_IP_MAX, 1);
}

function resolveTrackRateLimitPageMax(): number {
  return parsePositiveInt(process.env.TRACK_RATE_LIMIT_PAGE_MAX, DEFAULT_TRACK_RATE_LIMIT_PAGE_MAX, 1);
}

function cleanupMemoryTrackRateLimits(nowMs: number) {
  for (const [key, state] of memoryTrackRateLimits.entries()) {
    if (state.expiresAtMs <= nowMs) {
      memoryTrackRateLimits.delete(key);
    }
  }
}

function incrementMemoryTrackRateLimit(key: string, windowSec: number): { count: number; retryAfterSec: number } {
  const nowMs = Date.now();
  cleanupMemoryTrackRateLimits(nowMs);

  const current = memoryTrackRateLimits.get(key);
  if (!current || current.expiresAtMs <= nowMs) {
    const expiresAtMs = nowMs + windowSec * 1000;
    memoryTrackRateLimits.set(key, {
      count: 1,
      expiresAtMs,
    });
    return {
      count: 1,
      retryAfterSec: Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000)),
    };
  }

  current.count += 1;
  memoryTrackRateLimits.set(key, current);
  return {
    count: current.count,
    retryAfterSec: Math.max(1, Math.ceil((current.expiresAtMs - nowMs) / 1000)),
  };
}

function sortRollupEntries(entries: FunnelRollupEntry[]): FunnelRollupEntry[] {
  return entries.sort((a, b) => {
    const submittedDiff = b.formSubmitted - a.formSubmitted;
    if (submittedDiff !== 0) return submittedDiff;
    const openedDiff = b.formOpened - a.formOpened;
    if (openedDiff !== 0) return openedDiff;
    const pageViewsDiff = b.pageViews - a.pageViews;
    if (pageViewsDiff !== 0) return pageViewsDiff;
    return b.formOpened - a.formOpened;
  });
}

function aggregateRollup(params: {
  hash: Record<string, number>;
  filters: {
    city?: string;
    district?: string;
    service?: string;
    pageType?: string;
    pageSlug?: string;
  };
}): {
  entries: FunnelRollupEntry[];
  totalPageViews: number;
  totalOpened: number;
  totalSubmitted: number;
  conversionRate: number;
  totalOps: FunnelOpsCounts;
  totalOpsReasons: FunnelOpsReasonCounts;
} {
  const aggregated = new Map<string, FunnelRollupEntry>();
  let totalPageViews = 0;
  let totalOpened = 0;
  let totalSubmitted = 0;
  const totalOps = createEmptyOpsCounts();
  const totalOpsReasons = createEmptyOpsReasonCounts();

  for (const [field, rawCount] of Object.entries(params.hash)) {
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count <= 0) continue;
    const parsed = decodeField(field);
    if (!parsed) continue;

    const { eventName, dimensions } = parsed;
    if (!dimensions.pageSlug || dimensions.pageSlug === '/') continue;
    if (!matchesFilter(dimensions.pageSlug, params.filters.pageSlug)) continue;
    if (!matchesFilter(dimensions.city, params.filters.city)) continue;
    if (!matchesFilter(dimensions.district, params.filters.district)) continue;
    if (!matchesFilter(dimensions.service, params.filters.service)) continue;
    if (!matchesFilter(dimensions.pageType, params.filters.pageType)) continue;

    const dimensionKey = [
      dimensions.pageSlug,
      dimensions.city,
      dimensions.district,
      dimensions.service,
      dimensions.pageType,
    ].join('|');

    if (!aggregated.has(dimensionKey)) {
      aggregated.set(dimensionKey, {
        pageSlug: dimensions.pageSlug,
        city: dimensions.city,
        district: dimensions.district,
        service: dimensions.service,
        pageType: dimensions.pageType,
        pageViews: 0,
        formOpened: 0,
        formSubmitted: 0,
        conversionRate: 0,
        ops: createEmptyOpsCounts(),
        opsReasons: createEmptyOpsReasonCounts(),
      });
    }

    const entry = aggregated.get(dimensionKey)!;
    if (eventName === 'page_view') {
      entry.pageViews += count;
      totalPageViews += count;
    } else if (eventName === 'form_opened') {
      entry.formOpened += count;
      totalOpened += count;
    } else if (eventName === 'form_submitted') {
      entry.formSubmitted += count;
      totalSubmitted += count;
    } else {
      incrementOpsCount(entry.ops, eventName, count);
      incrementOpsCount(totalOps, eventName, count);
      if (eventName === 'form_validation_error') {
        incrementReasonCount(entry.opsReasons.validationErrors, parsed.reason, count);
        incrementReasonCount(totalOpsReasons.validationErrors, parsed.reason, count);
      }
      if (eventName === 'form_submit_blocked') {
        incrementReasonCount(entry.opsReasons.submitBlocked, parsed.reason, count);
        incrementReasonCount(totalOpsReasons.submitBlocked, parsed.reason, count);
      }
    }
  }

  const entries = sortRollupEntries(
    [...aggregated.values()].map((entry) => ({
      ...entry,
      conversionRate:
        entry.formOpened > 0
          ? entry.formSubmitted / entry.formOpened
          : entry.pageViews > 0
            ? entry.formSubmitted / entry.pageViews
            : 0,
    }))
  );

  return {
    totalPageViews,
    entries,
    totalOpened,
    totalSubmitted,
    conversionRate:
      totalOpened > 0 ? totalSubmitted / totalOpened : totalPageViews > 0 ? totalSubmitted / totalPageViews : 0,
    totalOps,
    totalOpsReasons,
  };
}

async function loadFunnelBucket(
  span: 'hour' | 'day',
  bucket: string
): Promise<{ hash: Record<string, number>; dataSource: FunnelStoreSource }> {
  const key = keyFor(span, bucket);

  if (hasRedisConfig()) {
    try {
      const raw = await redisCommand<unknown>('HGETALL', key);
      const hash = normalizeRedisHash(raw);
      return {
        hash,
        dataSource: 'redis',
      };
    } catch (error) {
      console.warn('[funnel-metrics] redis_read_failed', {
        code: error instanceof Error ? error.message : 'UNKNOWN',
      });
    }
  }

  return {
    hash: readMemoryHash(key),
    dataSource: 'memory',
  };
}

function finalizeRollup(params: {
  span: 'hour' | 'day';
  bucket: string;
  dataSource: FunnelStoreSource;
  aggregate: {
    entries: FunnelRollupEntry[];
    totalPageViews: number;
    totalOpened: number;
    totalSubmitted: number;
    conversionRate: number;
    totalOps: FunnelOpsCounts;
    totalOpsReasons: FunnelOpsReasonCounts;
  };
  limit: number;
}): FunnelRollup {
  return {
    span: params.span,
    bucket: params.bucket,
    generatedAtMs: Date.now(),
    dataSource: params.dataSource,
    totalPageViews: params.aggregate.totalPageViews,
    totalOpened: params.aggregate.totalOpened,
    totalSubmitted: params.aggregate.totalSubmitted,
    conversionRate: params.aggregate.conversionRate,
    totalOps: params.aggregate.totalOps,
    totalOpsReasons: params.aggregate.totalOpsReasons,
    entries: params.aggregate.entries.slice(0, asLimit(params.limit)),
  };
}

export async function recordFunnelMetric(params: FunnelRecordParams): Promise<{ dataSource: FunnelStoreSource }> {
  const dimensions = toDimension(params);
  if (!dimensions) return { dataSource: 'memory' };

  const timestampMs = Number.isFinite(params.timestampMs) ? Math.floor(params.timestampMs as number) : Date.now();
  const hourBucket = nowHourBucket(timestampMs);
  const dayBucket = nowDayBucket(timestampMs);
  const field = encodeField(params.eventName, dimensions, params.reason);
  const hourKey = keyFor('hour', hourBucket);
  const dayKey = keyFor('day', dayBucket);
  const hourTtlSec = parsePositiveInt(process.env.LEAD_METRICS_HOUR_RETENTION_SEC, DEFAULT_HOUR_RETENTION_SEC, 60 * 60);
  const dayTtlSec = parsePositiveInt(process.env.LEAD_METRICS_DAY_RETENTION_SEC, DEFAULT_DAY_RETENTION_SEC, 60 * 60);

  if (hasRedisConfig()) {
    try {
      await redisCommand('HINCRBY', hourKey, field, 1);
      await redisCommand('EXPIRE', hourKey, hourTtlSec);
      await redisCommand('HINCRBY', dayKey, field, 1);
      await redisCommand('EXPIRE', dayKey, dayTtlSec);
      return { dataSource: 'redis' };
    } catch (error) {
      console.warn('[funnel-metrics] redis_write_failed', {
        code: error instanceof Error ? error.message : 'UNKNOWN',
      });
    }
  }

  recordMemoryMetric(hourKey, field, hourTtlSec);
  recordMemoryMetric(dayKey, field, dayTtlSec);
  return { dataSource: 'memory' };
}

export async function getFunnelRollup(params: FunnelRollupParams): Promise<FunnelRollup> {
  const span = params.span === 'hour' ? 'hour' : 'day';
  const bucket = normalizeBucket(span, params.bucket);
  const filters = {
    city: params.city,
    district: params.district,
    service: params.service,
    pageType: params.pageType,
    pageSlug: params.pageSlug,
  };
  const limit = asLimit(params.limit);
  const bucketData = await loadFunnelBucket(span, bucket);
  const aggregate = aggregateRollup({
    hash: bucketData.hash,
    filters,
  });
  return finalizeRollup({
    span,
    bucket,
    dataSource: bucketData.dataSource,
    aggregate,
    limit,
  });
}

export async function getFunnelRollupFull(params: Omit<FunnelRollupParams, 'limit'>): Promise<FunnelRollup> {
  const span = params.span === 'hour' ? 'hour' : 'day';
  const bucket = normalizeBucket(span, params.bucket);
  const filters = {
    city: params.city,
    district: params.district,
    service: params.service,
    pageType: params.pageType,
    pageSlug: params.pageSlug,
  };

  const bucketData = await loadFunnelBucket(span, bucket);
  const aggregate = aggregateRollup({
    hash: bucketData.hash,
    filters,
  });

  return {
    span,
    bucket,
    generatedAtMs: Date.now(),
    dataSource: bucketData.dataSource,
    totalPageViews: aggregate.totalPageViews,
    totalOpened: aggregate.totalOpened,
    totalSubmitted: aggregate.totalSubmitted,
    conversionRate: aggregate.conversionRate,
    totalOps: aggregate.totalOps,
    totalOpsReasons: aggregate.totalOpsReasons,
    entries: aggregate.entries,
  };
}

export async function checkTrackRateLimit(params: { ip: string; pageSlug: string }): Promise<TrackRateLimitResult> {
  const ipMax = resolveTrackRateLimitIpMax();
  const pageMax = resolveTrackRateLimitPageMax();
  const windowSec = resolveTrackRateLimitWindowSec();

  const ipIdentity =
    String(params.ip || '')
      .trim()
      .toLowerCase() || 'unknown';
  const pageIdentity = sanitizePageSlug(params.pageSlug) || '/';
  const ipKey = keyForTrackRateLimit('ip', hashIdentity(ipIdentity));
  const pageKey = keyForTrackRateLimit('page', hashIdentity(`${ipIdentity}|${pageIdentity}`));

  if (hasRedisConfig()) {
    try {
      const ipCount = Number(await redisCommand<number>('INCR', ipKey));
      if (ipCount <= 1) {
        await redisCommand('EXPIRE', ipKey, windowSec);
      }
      const pageCount = Number(await redisCommand<number>('INCR', pageKey));
      if (pageCount <= 1) {
        await redisCommand('EXPIRE', pageKey, windowSec);
      }

      const ipTtl = Number(await redisCommand<number>('TTL', ipKey));
      const pageTtl = Number(await redisCommand<number>('TTL', pageKey));
      const allowed = ipCount <= ipMax && pageCount <= pageMax;

      return {
        allowed,
        retryAfterSec: allowed
          ? 0
          : Math.max(
              1,
              Math.max(
                Number.isFinite(ipTtl) && ipTtl > 0 ? Math.floor(ipTtl) : 0,
                Number.isFinite(pageTtl) && pageTtl > 0 ? Math.floor(pageTtl) : 0
              )
            ),
        ipCount: Number.isFinite(ipCount) ? Math.max(0, Math.floor(ipCount)) : 0,
        pageCount: Number.isFinite(pageCount) ? Math.max(0, Math.floor(pageCount)) : 0,
        dataSource: 'redis',
      };
    } catch (error) {
      console.warn('[funnel-metrics] track_rate_limit_redis_failed', {
        code: error instanceof Error ? error.message : 'UNKNOWN',
      });
    }
  }

  const ip = incrementMemoryTrackRateLimit(ipKey, windowSec);
  const page = incrementMemoryTrackRateLimit(pageKey, windowSec);
  const allowed = ip.count <= ipMax && page.count <= pageMax;

  return {
    allowed,
    retryAfterSec: allowed ? 0 : Math.max(ip.retryAfterSec, page.retryAfterSec),
    ipCount: ip.count,
    pageCount: page.count,
    dataSource: 'memory',
  };
}
