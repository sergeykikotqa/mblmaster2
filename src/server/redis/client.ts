import { createClient } from 'redis';

type RedisArg = string | number;

const DEFAULT_COMMAND_TIMEOUT_MS = 1200;
const MAX_RECONNECT_DELAY_MS = 3000;

let client: ReturnType<typeof createClient> | undefined;
let connectPromise: Promise<unknown> | undefined;
let configuredUrl: string | undefined;
let connectionErrorReported = false;

function commandTimeoutMs(): number {
  const parsed = Number(process.env.CONTACT_REDIS_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 200 ? Math.floor(parsed) : DEFAULT_COMMAND_TIMEOUT_MS;
}

export function parseRedisUrl(raw: string | undefined): URL | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash || parsed.search)
      return null;
    if (
      parsed.port &&
      (!Number.isInteger(Number(parsed.port)) || Number(parsed.port) < 1 || Number(parsed.port) > 65535)
    )
      return null;
    if (parsed.pathname && parsed.pathname !== '/' && !/^\/\d+$/.test(parsed.pathname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasRedisConfig(): boolean {
  return parseRedisUrl(process.env.REDIS_URL) !== null;
}

export function assertMemoryFallbackAllowed(error?: unknown): void {
  if (import.meta.env.PROD) {
    throw error ? normalizeRedisError(error) : new Error('REDIS_NOT_CONFIGURED');
  }
}

function normalizeRedisError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('REDIS_')) return error;
  const message = error instanceof Error ? error.message : '';
  if (/timeout/i.test(message)) return new Error('REDIS_TIMEOUT');
  if (/WRONGTYPE|ERR |NOSCRIPT|NOAUTH|NOPERM/i.test(message)) return new Error('REDIS_COMMAND_ERROR');
  return new Error('REDIS_NETWORK_ERROR');
}

function getClient() {
  const url = process.env.REDIS_URL?.trim();
  if (!parseRedisUrl(url)) throw new Error('REDIS_NOT_CONFIGURED');
  if (client) {
    if (configuredUrl !== url) throw new Error('REDIS_URL_CHANGED_RESTART_REQUIRED');
    return client;
  }

  configuredUrl = url;
  client = createClient({
    url,
    RESP: 2,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: commandTimeoutMs(),
      reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 5), MAX_RECONNECT_DELAY_MS),
    },
  });
  client.on('error', () => {
    if (!connectionErrorReported) {
      connectionErrorReported = true;
      console.warn('[redis] connection_unavailable');
    }
  });
  client.on('ready', () => {
    if (connectionErrorReported) console.info('[redis] connection_restored');
    connectionErrorReported = false;
  });

  return client;
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('REDIS_TIMEOUT')), commandTimeoutMs());
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readyClient() {
  const active = getClient();
  if (active.isReady) return active;
  if (!active.isOpen && !connectPromise) {
    connectPromise = active.connect().finally(() => {
      connectPromise = undefined;
    });
  }
  if (connectPromise) {
    try {
      await withTimeout(connectPromise);
    } catch (error) {
      throw normalizeRedisError(error);
    }
  }
  if (!active.isReady) throw new Error('REDIS_NETWORK_ERROR');
  return active;
}

export async function redisCommand<T>(...args: RedisArg[]): Promise<T> {
  if (args.length === 0) throw new Error('REDIS_COMMAND_ERROR');
  try {
    const active = await readyClient();
    const result = await withTimeout(active.sendCommand(args.map(String)));
    return result as T;
  } catch (error) {
    throw normalizeRedisError(error);
  }
}

export async function closeRedisClient(): Promise<void> {
  const active = client;
  client = undefined;
  connectPromise = undefined;
  configuredUrl = undefined;
  connectionErrorReported = false;
  if (!active) return;
  try {
    if (active.isOpen) await withTimeout(active.close());
  } catch {
    active.destroy();
  }
}

(globalThis as unknown as Record<symbol, () => Promise<void>>)[Symbol.for('mbl.redis.close')] = closeRedisClient;
