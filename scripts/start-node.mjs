import fs from 'node:fs';

const entry = new URL('../.output/server/entry.mjs', import.meta.url);
if (!fs.existsSync(entry)) {
  throw new Error('Missing Node artifact. Run npm run build before npm start.');
}

// Keep local verification private; deployment must explicitly set HOST behind Nginx.
process.env.NODE_ENV = 'production';
process.env.HOST ||= '127.0.0.1';
process.env.PORT ||= '4321';
process.env.ASTRO_NODE_AUTOSTART = 'disabled';

// Secrets belong to the process environment, not the public build or an implicit .env load.
const { startServer } = await import(entry.href);
const runtime = startServer();
let isStopping = false;

async function shutdown() {
  if (isStopping) return;
  isStopping = true;
  await runtime.server.stop();
  const closeRedis = globalThis[Symbol.for('mbl.redis.close')];
  if (typeof closeRedis === 'function') await closeRedis();
  if (process.connected) process.disconnect();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.on('message', (message) => {
  if (message === 'shutdown') void shutdown();
});

await runtime.done;
