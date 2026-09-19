import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_WAIT_MS = 60_000;
const SERVICE_NAMES = ['mbl-nginx', 'mbl-web', 'mbl-worker-trigger', 'mbl-redis'];
const PROJECT_PREFIX = 'mbl-o23-gate-';
const CANONICAL_ORIGIN = String(process.env.O23_CANONICAL_ORIGIN || 'https://mebel-irkutsk.ru').replace(/\/+$/, '');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parsePositiveInt(value, fallback, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

function parseBoolean(value, fallback = false) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function redact(value, secrets) {
  let result = String(value || '');
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, '[redacted]');
  }
  return result;
}

function sanitizeDiagnostic(value, secrets) {
  return redact(value, secrets)
    .replace(/redis(?:s)?:\/\/[^\s"']+/gi, 'redis://[redacted]')
    .replace(/sha256=[a-f0-9]{64}/gi, 'sha256=[redacted]')
    .replace(/\+7[\s()-]*\d(?:[\s()-]*\d){9}/g, '[phone-redacted]')
    .replace(/\[o23-[^\]]+\]/gi, '[lead-marker-redacted]')
    .replace(/Runtime Gate/gi, '[lead-name-redacted]')
    .replace(/([?&](?:token|secret|key|signature|authorization)=)[^&\s"']+/gi, '$1[redacted]');
}

function normalizePathname(value) {
  const pathname = String(value || '').trim();
  if (!pathname || pathname === '/') return '/';
  return `/${pathname.replace(/^\/+|\/+$/g, '')}`;
}

function randomSecret(label) {
  return `${label}-${randomBytes(24).toString('hex')}`;
}

function resolveImageRevision() {
  const explicit = String(process.env.O23_IMAGE_REVISION || '').trim();
  if (explicit) {
    assert(/^[A-Za-z0-9._-]+$/.test(explicit), 'O23_IMAGE_REVISION is not a valid immutable image tag');
    return explicit;
  }

  const head = run('git', ['rev-parse', 'HEAD']);
  const status = run('git', ['status', '--porcelain', '--untracked-files=normal']);
  if (!status) return head;

  const digest = createHash('sha256');
  digest.update(head);
  digest.update(run('git', ['diff', '--binary', 'HEAD']));
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).sort();
  for (const relativePath of untracked) {
    digest.update(relativePath);
    digest.update('\0');
    digest.update(fs.readFileSync(path.join(ROOT, relativePath)));
  }
  return `${head.slice(0, 12)}-dirty-${digest.digest('hex').slice(0, 12)}`;
}

function composeFiles() {
  const configured = String(process.env.O23_COMPOSE_FILES || '').trim();
  const candidates = configured
    ? configured
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : ['compose.production.yml', 'compose.runtime-test.yml'];

  for (const candidate of candidates) {
    const resolved = path.resolve(ROOT, candidate);
    assert(fs.existsSync(resolved), `Compose file does not exist: ${candidate}`);
  }
  return candidates.map((candidate) => path.resolve(ROOT, candidate));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 180_000,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.error || result.status !== 0) {
    const details = [result.error?.message, stdout, stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed\n${details}`);
  }
  return stdout;
}

function createComposeController({ files, projectName, env, secrets }) {
  assert(projectName.startsWith(PROJECT_PREFIX), `Unsafe test project name: ${projectName}`);
  const baseArgs = ['compose', '--project-name', projectName];
  for (const file of files) baseArgs.push('--file', file);

  const invoke = (args, options = {}) => {
    try {
      return run('docker', [...baseArgs, ...args], {
        env,
        timeoutMs: options.timeoutMs || 240_000,
      });
    } catch (error) {
      throw new Error(sanitizeDiagnostic(error instanceof Error ? error.message : error, secrets));
    }
  };

  return {
    invoke,
    service(command, service, ...rest) {
      assert(SERVICE_NAMES.includes(service), `Unknown production service: ${service}`);
      return invoke([command, service, ...rest]);
    },
    containerId(service) {
      return this.service('ps', service, '--quiet').trim();
    },
    redis(...args) {
      return invoke(['exec', '-T', 'mbl-redis', 'redis-cli', '--raw', ...args], { timeoutMs: 30_000 });
    },
  };
}

async function reservePort(host = '127.0.0.1') {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Failed to reserve an HTTP port');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function timingSafeSignature(secret, timestamp, webhookId, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${webhookId}.${rawBody}`).digest('hex')}`;
}

async function startMockReceiver(webhookSecret) {
  const attempts = [];
  let mode = 'success';

  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD' || request.method === 'GET') {
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/webhook') {
      response.statusCode = 404;
      response.end('not_found');
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let payload = null;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = null;
    }

    const webhookId = String(request.headers['x-webhook-id'] || '');
    const timestamp = String(request.headers['x-webhook-timestamp'] || '');
    const actualSignature = String(request.headers['x-hub-signature-256'] || '');
    const expectedSignature = timingSafeSignature(webhookSecret, timestamp, webhookId, rawBody);
    const attempt = {
      atMs: Date.now(),
      payload,
      webhookId,
      signatureValid: Boolean(webhookId && timestamp && actualSignature === expectedSignature),
      status: mode === 'success' ? 200 : 503,
    };
    attempts.push(attempt);

    response.statusCode = attempt.status;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: attempt.status === 200 }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Mock delivery receiver failed to start');

  return {
    port: address.port,
    attempts,
    setMode(nextMode) {
      assert(['success', 'failure'].includes(nextMode), `Unknown mock mode: ${nextMode}`);
      mode = nextMode;
    },
    attemptsForLead(leadId) {
      return attempts.filter((attempt) => attempt.payload?.lead?.leadId === leadId);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response, label) {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON (${response.status}): ${raw.slice(0, 200)}`);
  }
}

async function waitFor(label, operation, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_WAIT_MS;
  const intervalMs = options.intervalMs || 500;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

function extractCanonical(html) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = tag.match(/\brel=(['"])(.*?)\1/i)?.[2] || '';
    if (!rel.toLowerCase().split(/\s+/).includes('canonical')) continue;
    return tag.match(/\bhref=(['"])(.*?)\1/i)?.[2] || '';
  }
  return '';
}

function locationPath(response, baseUrl) {
  const location = response.headers.get('location');
  assert(location, `Redirect ${response.status} is missing Location`);
  return new URL(location, baseUrl).pathname;
}

function makeTempEnvironment({ mockPort, canonicalOrigin, publicPort, projectName, imageRevision, secrets }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-o23-runtime-'));
  const envPath = path.join(tempRoot, 'prod.env');
  const mockHostname = String(process.env.O23_MOCK_HOSTNAME || 'host.docker.internal').trim();
  const mockUrl = `http://${mockHostname}:${mockPort}/webhook`;
  const redisPrefix = `${projectName}:lead`;
  const lines = [
    'NODE_ENV=production',
    'HOST=0.0.0.0',
    'PORT=4321',
    `PUBLIC_SITE_URL=${canonicalOrigin}`,
    'REDIS_URL=redis://mbl-redis:6379/0',
    `CONTACT_REDIS_PREFIX=${redisPrefix}`,
    `CONTACT_WEBHOOK_URL=${mockUrl}`,
    `CONTACT_WEBHOOK_SECRET=${secrets.webhook}`,
    `CONTACT_ALERT_WEBHOOK_URL=${mockUrl}`,
    `CONTACT_ALERT_WEBHOOK_TOKEN=${secrets.alert}`,
    `CONTACT_WORKER_TOKEN=${secrets.worker}`,
    `METRICS_ADMIN_TOKEN=${secrets.admin}`,
    'CONTACT_TURNSTILE_REQUIRED=false',
    'CONTACT_TURNSTILE_FAILURE_MODE=closed',
    'CONTACT_TRUST_PROXY_HEADERS=true',
    'TRACK_TRUST_PROXY_HEADERS=true',
    'ADMIN_TRUST_PROXY_HEADERS=true',
    'CONTACT_RATE_LIMIT_MAX=50',
    'CONTACT_RATE_LIMIT_WINDOW_SEC=60',
    'CONTACT_RETRY_BASE_DELAY_SEC=1',
    'CONTACT_DELIVERY_MAX_RETRIES=5',
    'CONTACT_WEBHOOK_TIMEOUT_MS=1000',
    'CONTACT_ALERT_TIMEOUT_MS=1000',
    'CONTACT_ALERT_MAX_RETRIES=0',
    'CONTACT_WORKER_HEARTBEAT_STALE_SEC=4',
    'CONTACT_QUEUE_OLDEST_NORMAL_SEC=1',
    'CONTACT_QUEUE_OLDEST_WARNING_SEC=2',
    'CONTACT_QUEUE_OLDEST_CRITICAL_SEC=10',
    'WORKER_TRIGGER_INTERVAL_MS=1000',
    'WORKER_TRIGGER_TIMEOUT_MS=3000',
    'WORKER_TRIGGER_BATCH_LIMIT=20',
    'WORKER_TRIGGER_URL=http://mbl-web:4321/api/workers/lead-delivery',
    '',
  ];
  fs.writeFileSync(envPath, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });

  return {
    tempRoot,
    envPath,
    redisPrefix,
    composeEnv: {
      ...process.env,
      MBL_ENV_FILE: envPath,
      MBL_BIND_ADDRESS: '127.0.0.1',
      MBL_HTTP_PORT: String(publicPort),
      MBL_IMAGE_TAG: imageRevision,
      MBL_REDIS_VOLUME_NAME: `${projectName}_mbl-redis-data`,
      MBL_REDIS_VOLUME_EXTERNAL: 'false',
      PUBLIC_SITE_URL: canonicalOrigin,
      WORKER_TRIGGER_INTERVAL_MS: '1000',
      WORKER_TRIGGER_TIMEOUT_MS: '3000',
      WORKER_TRIGGER_BATCH_LIMIT: '20',
    },
  };
}

function parseAttributes(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(['"])(.*?)\2/gs)) {
    attributes.set(match[1].toLowerCase(), match[3]);
  }
  return attributes;
}

function addLocalResource(resources, rawValue, pageUrl) {
  const value = String(rawValue || '').trim();
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return;
  let resource;
  try {
    resource = new URL(value, pageUrl);
  } catch {
    return;
  }
  if (resource.origin !== new URL(pageUrl).origin) return;
  resource.hash = '';
  resources.add(resource.toString());
}

function extractPageResources(html, pageUrl) {
  const resources = new Set();
  const tags = html.match(/<(?:script|img|source|link)\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attributes = parseAttributes(tag);
    const tagName = tag.match(/^<(\w+)/i)?.[1]?.toLowerCase();
    if (tagName === 'link') {
      const rel = String(attributes.get('rel') || '').toLowerCase();
      if (!/(?:stylesheet|icon|preload|modulepreload)/.test(rel)) continue;
      addLocalResource(resources, attributes.get('href'), pageUrl);
    } else {
      addLocalResource(resources, attributes.get('src'), pageUrl);
    }

    const srcset = attributes.get('srcset');
    if (srcset) {
      for (const candidate of srcset.split(',')) {
        addLocalResource(resources, candidate.trim().split(/\s+/)[0], pageUrl);
      }
    }
  }
  return resources;
}

function expectedMime(pathname) {
  const extension = path.extname(pathname).toLowerCase();
  if (extension === '.css') return 'text/css';
  if (['.js', '.mjs'].includes(extension)) return 'javascript';
  if (['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg', '.ico'].includes(extension)) return 'image/';
  if (['.woff', '.woff2', '.ttf', '.otf'].includes(extension)) return 'font/';
  return '';
}

async function checkPublicRoutes(baseUrl) {
  const routes = [
    '/',
    '/kuhni',
    '/projects',
    '/projects/kuhnya-bogdana',
    '/articles',
    '/articles/cveta-kuhni-trendy',
    '/contacts',
  ];
  const pageResources = new Set();

  for (const route of routes) {
    const response = await fetchWithTimeout(`${baseUrl}${route}`, {
      headers: { 'Accept-Encoding': 'gzip' },
      redirect: 'manual',
    });
    const html = await response.text();
    assert(response.status === 200, `GET ${route} must return 200, got ${response.status}`);
    assert(/text\/html/i.test(response.headers.get('content-type') || ''), `GET ${route} must be HTML`);
    const htmlCache = String(response.headers.get('cache-control') || '').toLowerCase();
    assert(!htmlCache.includes('immutable'), `HTML ${route} must not be immutable`);
    assert(/no-cache|no-store|max-age=0/.test(htmlCache), `HTML ${route} lacks a safe revalidation policy`);
    const canonical = extractCanonical(html);
    assert(canonical, `GET ${route} must include a canonical URL`);
    assert(
      canonical === `${CANONICAL_ORIGIN}${route === '/' ? '/' : normalizePathname(route)}`,
      `GET ${route} emitted unexpected canonical ${canonical}`
    );
    for (const resource of extractPageResources(html, `${baseUrl}${route}`)) pageResources.add(resource);
  }

  const gzipResponse = await fetchWithTimeout(`${baseUrl}/`, {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  await gzipResponse.arrayBuffer();
  assert(
    String(gzipResponse.headers.get('content-encoding') || '')
      .toLowerCase()
      .includes('gzip'),
    'Nginx must gzip representative HTML'
  );

  return pageResources;
}

async function checkStatusesAndRedirects(baseUrl) {
  const notFound = await fetchWithTimeout(`${baseUrl}/404`, { redirect: 'manual' });
  assert(notFound.status === 404, `GET /404 must return 404, got ${notFound.status}`);

  const gone = await fetchWithTimeout(`${baseUrl}/410`, { redirect: 'manual' });
  assert(gone.status === 410, `GET /410 must return 410, got ${gone.status}`);

  const legacy = await fetchWithTimeout(`${baseUrl}/kitchens`, { redirect: 'manual' });
  assert(legacy.status === 301, `GET /kitchens must return 301, got ${legacy.status}`);
  assert(locationPath(legacy, baseUrl) === '/kuhni', 'GET /kitchens must redirect to /kuhni');

  const temporary = await fetchWithTimeout(`${baseUrl}/api/contact`, { redirect: 'manual' });
  assert(temporary.status === 307, `GET /api/contact must return 307, got ${temporary.status}`);
  assert(locationPath(temporary, baseUrl) === '/api/leads', 'GET /api/contact must redirect to /api/leads');
  assert(/no-store/i.test(temporary.headers.get('cache-control') || ''), 'API redirect must be no-store');

  const goneLegacy = await fetchWithTimeout(`${baseUrl}/raiony/legacy-district`, { redirect: 'manual' });
  assert(goneLegacy.status === 410, `Gone legacy route must return 410, got ${goneLegacy.status}`);
}

async function checkRobotsAndSitemap(baseUrl) {
  const robotsResponse = await fetchWithTimeout(`${baseUrl}/robots.txt`);
  const robots = await robotsResponse.text();
  assert(robotsResponse.status === 200, `GET /robots.txt must return 200, got ${robotsResponse.status}`);
  assert(
    robots.includes(`Sitemap: ${CANONICAL_ORIGIN}/sitemap-index.xml`),
    'robots.txt must reference the canonical sitemap'
  );
  assert(!/mbl-web|mbl-nginx|localhost|127\.0\.0\.1/i.test(robots), 'robots.txt leaks a container/local host');

  const sitemapResponse = await fetchWithTimeout(`${baseUrl}/sitemap-index.xml`);
  const sitemap = await sitemapResponse.text();
  assert(sitemapResponse.status === 200, `GET /sitemap-index.xml must return 200, got ${sitemapResponse.status}`);
  assert(sitemap.includes(CANONICAL_ORIGIN), 'Sitemap index must use the canonical origin');
  assert(!/mbl-web|mbl-nginx|localhost|127\.0\.0\.1/i.test(sitemap), 'Sitemap leaks a container/local host');
}

async function checkResourceIntegrity(initialResources) {
  const resources = new Set(initialResources);
  const queue = [...resources];
  const visited = new Set();
  const maxResources = parsePositiveInt(process.env.O23_RESOURCE_LIMIT, 1000, 20);
  let checked = 0;

  while (queue.length > 0 && checked < maxResources) {
    const resourceUrl = queue.shift();
    if (!resourceUrl || visited.has(resourceUrl)) continue;
    visited.add(resourceUrl);
    const response = await fetchWithTimeout(resourceUrl, { redirect: 'follow' });
    const body = await response.arrayBuffer();
    const pathname = new URL(resourceUrl).pathname;
    assert(response.status === 200, `Resource ${pathname} returned ${response.status}`);
    assert(body.byteLength > 0, `Resource ${pathname} is empty`);
    const mime = String(response.headers.get('content-type') || '').toLowerCase();
    const expected = expectedMime(pathname);
    if (expected === 'font/') {
      assert(mime.includes('font/') || mime.includes('application/font'), `Resource ${pathname} has MIME ${mime}`);
    } else if (expected) {
      assert(mime.includes(expected), `Resource ${pathname} has MIME ${mime}, expected ${expected}`);
    }
    if (pathname.startsWith('/_astro/')) {
      const cache = String(response.headers.get('cache-control') || '').toLowerCase();
      assert(
        cache.includes('immutable') && /max-age=(?:31536000|[4-9]\d{6,})/.test(cache),
        `${pathname} lacks immutable cache`
      );
    } else {
      const cache = String(response.headers.get('cache-control') || '').toLowerCase();
      assert(cache, `Public resource ${pathname} lacks Cache-Control`);
      assert(!cache.includes('immutable'), `Unhashed resource ${pathname} must not be immutable`);
    }

    if (pathname.endsWith('.css')) {
      const css = new TextDecoder().decode(body);
      for (const match of css.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
        addLocalResource(resources, match[2], resourceUrl);
      }
    } else if (/\.(?:m?js)$/.test(pathname)) {
      const javascript = new TextDecoder().decode(body);
      for (const pattern of [/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g, /\bfrom\s*['"]([^'"]+)['"]/g]) {
        for (const match of javascript.matchAll(pattern)) {
          const specifier = match[1];
          if (specifier.startsWith('.') || specifier.startsWith('/')) {
            addLocalResource(resources, specifier, resourceUrl);
          }
        }
      }
      for (const match of javascript.matchAll(/\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
        addLocalResource(resources, match[1], resourceUrl);
      }
    }

    for (const discovered of resources) {
      if (!visited.has(discovered) && !queue.includes(discovered)) queue.push(discovered);
    }
    checked += 1;
  }

  assert(checked > 0, 'No public resources were discovered');
  const unvisited = queue.filter((resource) => !visited.has(resource));
  assert(
    unvisited.length === 0,
    `Resource crawl reached its ${maxResources}-resource limit with ${unvisited.length} local resources unverified`
  );
  return checked;
}

function checkBrowserRuntime(baseUrl) {
  const playwrightCli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  assert(fs.existsSync(playwrightCli), 'Playwright CLI is unavailable; run npm ci before the Compose gate');
  const env = {
    ...process.env,
    PLAYWRIGHT_EXTERNAL_SERVER: '1',
    PLAYWRIGHT_BASE_URL: baseUrl,
    PUBLIC_SITE_URL: CANONICAL_ORIGIN,
    PUBLIC_E2E: '0',
  };

  run(
    process.execPath,
    [
      playwrightCli,
      'test',
      '--config=playwright.config.ts',
      'tests/e2e/header-navigation.spec.ts',
      'tests/e2e/seo-invariants.spec.ts',
      'tests/e2e/project-images.spec.ts',
      'tests/e2e/runtime-resource-integrity.spec.ts',
    ],
    { env, timeoutMs: 720_000 }
  );
  run(process.execPath, [playwrightCli, 'test', '--config=playwright.a11y.config.ts', 'tests/e2e/a11y-smoke.spec.ts'], {
    env,
    timeoutMs: 480_000,
  });

  return {
    chromium: true,
    navigation: true,
    seo: true,
    projectResources: true,
    criticalAccessibility: true,
  };
}

async function checkCacheAndSecurityHeaders(baseUrl, workerToken) {
  const admin = await fetchWithTimeout(`${baseUrl}/api/admin/health`, { redirect: 'manual' });
  assert([401, 403].includes(admin.status), `Unauthenticated admin API must reject access, got ${admin.status}`);
  assert(/no-store/i.test(admin.headers.get('cache-control') || ''), 'Admin API must use Cache-Control: no-store');

  const adminPage = await fetchWithTimeout(`${baseUrl}/admin`);
  assert(adminPage.status === 200, `GET /admin must return 200, got ${adminPage.status}`);
  await adminPage.arrayBuffer();
  assert(/no-store/i.test(adminPage.headers.get('cache-control') || ''), 'Admin page must use Cache-Control: no-store');
  assert(/noindex/i.test(adminPage.headers.get('x-robots-tag') || ''), 'Admin page must remain noindex');

  const blockedWorker = await fetchWithTimeout(`${baseUrl}/api/workers/lead-delivery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' },
    body: '{}',
    redirect: 'manual',
  });
  assert(
    [403, 404].includes(blockedWorker.status),
    `Worker endpoint must not be exposed through Nginx, got ${blockedWorker.status}`
  );
  assert(/no-store/i.test(blockedWorker.headers.get('cache-control') || ''), 'Blocked worker route must be no-store');

  const largeBody = JSON.stringify({ value: 'x'.repeat(70 * 1024) });
  const tooLarge = await fetchWithTimeout(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: largeBody,
  });
  assert(tooLarge.status === 413, `Nginx request body limit must reject >64 KiB, got ${tooLarge.status}`);

  const root = await fetchWithTimeout(`${baseUrl}/`);
  await root.arrayBuffer();
  const expectedHeaders = {
    'content-security-policy': /default-src 'self'/i,
    'permissions-policy': /camera=\(\).*geolocation=\(\).*microphone=\(\)/i,
    'referrer-policy': /^same-origin$/i,
    'strict-transport-security': /max-age=31536000.*includeSubDomains/i,
    'x-content-type-options': /^nosniff$/i,
    'x-frame-options': /^DENY$/i,
  };
  for (const [header, pattern] of Object.entries(expectedHeaders)) {
    const value = String(root.headers.get(header) || '');
    assert(pattern.test(value), `Public response has invalid ${header}: ${value || '(missing)'}`);
  }
}

async function getLive(baseUrl, expectedStatus = 200) {
  const response = await fetchWithTimeout(`${baseUrl}/health/live`);
  const body = await readJson(response, 'GET /health/live');
  assert(response.status === expectedStatus, `GET /health/live expected ${expectedStatus}, got ${response.status}`);
  assert(body?.ok === true && body?.status === 'live', 'Liveness response contract is invalid');
  assert(/no-store/i.test(response.headers.get('cache-control') || ''), 'Liveness must be no-store');
  return body;
}

async function getReady(baseUrl, expectedStatus) {
  const response = await fetchWithTimeout(`${baseUrl}/health/ready`);
  const body = await readJson(response, 'GET /health/ready');
  assert(response.status === expectedStatus, `GET /health/ready expected ${expectedStatus}, got ${response.status}`);
  assert(
    body?.ok === (expectedStatus === 200) && body?.status === (expectedStatus === 200 ? 'ready' : 'not_ready'),
    'Readiness response contract is invalid'
  );
  assert(/no-store/i.test(response.headers.get('cache-control') || ''), 'Readiness must be no-store');
  const serialized = JSON.stringify(body);
  assert(!/redis:\/\/|mbl-redis|REDIS_URL|password|token/i.test(serialized), 'Readiness leaks infrastructure details');
  return body;
}

async function getAdminWorker(baseUrl, adminToken) {
  const response = await fetchWithTimeout(`${baseUrl}/api/admin/health/worker`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await readJson(response, 'GET /api/admin/health/worker');
  assert([200, 503].includes(response.status), `Admin worker health returned ${response.status}`);
  assert(/no-store/i.test(response.headers.get('cache-control') || ''), 'Admin worker health must be no-store');
  return { response, body };
}

function heartbeatFrom(body) {
  return body?.runtime?.heartbeat || body?.heartbeat || null;
}

function oldestPendingFrom(body) {
  return body?.runtime?.oldestPending || body?.oldestPending || null;
}

async function postLead(baseUrl, marker, extraHeaders = {}) {
  const response = await fetchWithTimeout(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'mbl-o23-compose-gate',
      'X-Idempotency-Key': `o23-${marker}-${randomUUID()}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      name: 'Runtime Gate',
      phone: '+7 950 123-45-67',
      message: `[o23-${marker}]`,
      consent: true,
      website: '',
      formContext: { pageType: 'runtime-gate', pageSlug: '/contacts' },
    }),
  });
  assert(/no-store/i.test(response.headers.get('cache-control') || ''), 'Lead API response must be no-store');
  const body = await readJson(response, `POST /api/leads (${marker})`);
  return { response, body };
}

async function waitForDeliveredAttempt(mock, leadId, options = {}) {
  return waitFor(
    `delivery of lead ${leadId}`,
    () => {
      const attempt = mock.attemptsForLead(leadId).find((item) => item.status === 200);
      if (!attempt) return false;
      assert(attempt.signatureValid, `Lead ${leadId} webhook HMAC signature is invalid`);
      return attempt;
    },
    { timeoutMs: options.timeoutMs || 45_000, intervalMs: 250 }
  );
}

function inspectContainer(containerId) {
  assert(containerId, 'Compose service has no container ID');
  return JSON.parse(run('docker', ['inspect', containerId]))[0];
}

function publishedBindings(inspectPayload) {
  const ports = inspectPayload?.NetworkSettings?.Ports || {};
  return Object.values(ports)
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((value) => value && value.HostPort);
}

function checkContainerEnvelope(compose, projectName) {
  const inspections = new Map();
  for (const service of SERVICE_NAMES) {
    const id = compose.containerId(service);
    const payload = inspectContainer(id);
    inspections.set(service, payload);
    const bindings = publishedBindings(payload);
    if (service === 'mbl-nginx') {
      assert(bindings.length === 1, `mbl-nginx must expose exactly one port, got ${bindings.length}`);
    } else {
      assert(bindings.length === 0, `${service} must not publish a host port`);
    }
    assert(payload?.HostConfig?.ReadonlyRootfs === true, `${service} filesystem must be read-only`);
    assert(
      payload?.HostConfig?.SecurityOpt?.includes('no-new-privileges:true'),
      `${service} must enable no-new-privileges`
    );
    assert(payload?.HostConfig?.CapDrop?.includes('ALL'), `${service} must drop all Linux capabilities`);
  }

  const nginx = inspections.get('mbl-nginx');
  const nginxTmpfs = nginx?.HostConfig?.Tmpfs || {};
  assert(
    Object.keys(nginxTmpfs).length === 1 && Object.hasOwn(nginxTmpfs, '/tmp'),
    'mbl-nginx must have exactly one writable tmpfs at /tmp'
  );
  const nginxMounts = nginx?.Mounts || [];
  assert(
    nginxMounts.every((mount) => mount.Type === 'tmpfs' && mount.Destination === '/tmp') && nginxMounts.length <= 1,
    'mbl-nginx has a writable mount outside its /tmp tmpfs allowlist'
  );
  for (const service of ['mbl-web', 'mbl-worker-trigger', 'mbl-redis']) {
    const tmpfs = inspections.get(service)?.HostConfig?.Tmpfs || {};
    assert(Object.keys(tmpfs).length === 0, `${service} has an unexpected tmpfs mount`);
  }
  assert((inspections.get('mbl-web')?.Mounts || []).length === 0, 'mbl-web has an unexpected writable mount');
  assert(
    (inspections.get('mbl-worker-trigger')?.Mounts || []).length === 0,
    'mbl-worker-trigger has an unexpected writable mount'
  );

  const redisMounts = inspections.get('mbl-redis')?.Mounts || [];
  assert(redisMounts.length === 1, `Redis must have exactly one writable mount, got ${redisMounts.length}`);
  const redisData = redisMounts[0];
  assert(
    redisData?.Type === 'volume' && redisData?.Destination === '/data',
    'Redis writable mount must be a named volume at /data'
  );
  assert(
    String(redisData?.Name || '').startsWith(`${projectName}_`),
    `Redis test volume is not isolated to Compose project ${projectName}`
  );

  for (const service of ['mbl-web', 'mbl-worker-trigger']) {
    compose.invoke([
      'exec',
      '-T',
      service,
      'sh',
      '-c',
      'if touch /tmp/.mbl-write-probe 2>/dev/null; then rm -f /tmp/.mbl-write-probe; exit 1; fi',
    ]);
  }
  compose.invoke(['exec', '-T', 'mbl-nginx', 'sh', '-c', 'touch /tmp/.mbl-write-probe && rm /tmp/.mbl-write-probe']);
  compose.invoke(['exec', '-T', 'mbl-redis', 'sh', '-c', 'touch /data/.mbl-write-probe && rm /data/.mbl-write-probe']);
  compose.invoke([
    'exec',
    '-T',
    'mbl-redis',
    'sh',
    '-c',
    'if touch /tmp/.mbl-write-probe 2>/dev/null; then rm -f /tmp/.mbl-write-probe; exit 1; fi',
  ]);
  return inspections;
}

function checkImageMetadata(imageId, expectedRevision, imageName) {
  const inspection = JSON.parse(run('docker', ['image', 'inspect', imageId]))[0];
  const imageEnv = inspection?.Config?.Env || [];
  const serializedConfig = JSON.stringify({ env: imageEnv, labels: inspection?.Config?.Labels || {} });
  assert(
    !/(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|REDIS_URL|TURNSTILE|WEBHOOK|RUM_KEY)=/i.test(serializedConfig),
    `${imageName} config embeds a runtime secret`
  );
  assert(
    inspection?.Config?.Labels?.['org.opencontainers.image.revision'] === expectedRevision,
    `${imageName} OCI revision does not match the immutable test revision`
  );
  return inspection;
}

function checkImageEnvelope(imageId, expectedRevision) {
  checkImageMetadata(imageId, expectedRevision, 'mbl-web');
  const filesystemProbe = run('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    imageId,
    '-c',
    [
      'test ! -e /app/.git',
      'test ! -e /app/.env',
      'test ! -e /app/.env.production',
      'test ! -e /app/.env.local',
      'test ! -e /app/prod.env',
      '! find /app -type f \\( -name "*.pem" -o -name "*.key" -o -name "*.crt" \\) -print -quit | grep -q .',
      'test ! -d /app/node_modules/vitest',
      'test ! -d /app/node_modules/eslint',
      'test ! -d /app/node_modules/@playwright/test',
      'test ! -d /app/node_modules/@astrojs/check',
      'test ! -d /app/node_modules/sharp',
      'test -f /app/.output/server/entry.mjs',
      'node --version',
    ].join(' && '),
  ]);
  const nodeVersion = filesystemProbe.split(/\r?\n/).find((line) => /^v\d+/.test(line));
  assert(nodeVersion === 'v22.22.0', `Unexpected production Node version: ${nodeVersion || 'unknown'}`);
  return { nodeVersion };
}

function checkNginxImageEnvelope(imageId, expectedRevision) {
  checkImageMetadata(imageId, expectedRevision, 'mbl-nginx');
  run('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    imageId,
    '-c',
    [
      'test ! -e /usr/share/nginx/html/.env',
      'test ! -e /usr/share/nginx/html/.env.production',
      'test ! -e /usr/share/nginx/html/.env.local',
      'test ! -e /usr/share/nginx/html/prod.env',
      '! find /etc/nginx /usr/share/nginx/html -type f \\( -name "*.pem" -o -name "*.key" -o -name "*.crt" \\) -print -quit | grep -q .',
    ].join(' && '),
  ]);
  return { checked: true };
}

function checkRedisPolicy(compose) {
  const appendOnly = compose.redis('CONFIG', 'GET', 'appendonly').split(/\r?\n/).filter(Boolean);
  assert(appendOnly.includes('yes'), 'Redis appendonly policy must be yes');
  const appendFsync = compose.redis('CONFIG', 'GET', 'appendfsync').split(/\r?\n/).filter(Boolean);
  assert(appendFsync.includes('everysec'), 'Redis appendfsync policy must be everysec');
  const eviction = compose.redis('CONFIG', 'GET', 'maxmemory-policy').split(/\r?\n/).filter(Boolean);
  assert(eviction.includes('noeviction'), 'Redis maxmemory-policy must be noeviction');
}

async function checkContainerLogs(compose, secrets, baseUrl) {
  const canary = await fetchWithTimeout(`${baseUrl}/?token=${encodeURIComponent(secrets.logQuery)}`);
  await canary.arrayBuffer();
  assert(canary.status === 200, `Log query canary returned ${canary.status}`);
  await delay(100);
  const logs = compose.invoke(['logs', '--no-color']);
  for (const secret of Object.values(secrets)) {
    assert(!logs.includes(secret), 'Container logs expose a generated runtime secret');
  }
  for (const sensitiveValue of ['redis://', 'Runtime Gate', '+7 950 123-45-67', '[o23-']) {
    assert(!logs.toLowerCase().includes(sensitiveValue.toLowerCase()), `Container logs expose ${sensitiveValue}`);
  }
  assert(!/sha256=[a-f0-9]{64}/i.test(logs), 'Container logs expose a webhook HMAC signature');
  return { checked: true };
}

function redisGet(compose, key) {
  return compose.redis('GET', key).trim();
}

async function checkWorkerHeartbeat(baseUrl, adminToken, expectedState, timeoutMs = 15_000) {
  return waitFor(
    `worker heartbeat state=${expectedState}`,
    async () => {
      const { response, body } = await getAdminWorker(baseUrl, adminToken);
      const heartbeat = heartbeatFrom(body);
      if (heartbeat?.state !== expectedState) return false;
      const value = heartbeat.value;
      assert(value && typeof value === 'object', 'Heartbeat lacks its Redis value');
      assert(typeof value.lastCycleAt === 'string' && value.lastCycleAt, 'Heartbeat lacks lastCycleAt');
      assert(typeof value.processed === 'number', 'Heartbeat lacks processed count');
      assert(typeof value.delivered === 'number', 'Heartbeat lacks delivered count');
      assert(typeof value.error === 'string', 'Heartbeat lacks safe error state');
      assert(typeof heartbeat.staleAfterMs === 'number', 'Heartbeat lacks stale threshold');
      if (expectedState === 'cycling') {
        assert(response.status === 200, `Healthy worker heartbeat must return 200, got ${response.status}`);
        assert(value.status === 'ok', `Fresh worker heartbeat is not healthy: ${value.status}`);
      } else if (expectedState === 'stale') {
        assert(response.status === 503, `Stale worker heartbeat must return 503, got ${response.status}`);
      }
      return { body, heartbeat };
    },
    { timeoutMs, intervalMs: 500 }
  );
}

async function checkOldestPendingState(baseUrl, adminToken, expectedState, expectedThresholds) {
  return waitFor(
    `oldest pending state=${expectedState}`,
    async () => {
      const { body } = await getAdminWorker(baseUrl, adminToken);
      const oldestPending = oldestPendingFrom(body);
      if (oldestPending?.state !== expectedState) return false;
      assert(typeof oldestPending.ageMs === 'number', 'Admin worker health lacks oldestPendingAge');
      assert(
        JSON.stringify(oldestPending.thresholdsMs) === JSON.stringify(expectedThresholds),
        'Admin worker health exposes unexpected oldest-pending thresholds'
      );
      return oldestPending;
    },
    { timeoutMs: 10_000, intervalMs: 250 }
  );
}

async function checkLeadFailClosed(baseUrl) {
  const result = await postLead(baseUrl, 'redis-outage');
  assert(result.response.status === 503, `Lead during Redis outage must return 503, got ${result.response.status}`);
  assert(result.body?.success === false, 'Lead during Redis outage must not be accepted');
  assert(result.body?.code === 'LEAD_STORE_UNAVAILABLE', `Unexpected Redis outage code: ${result.body?.code}`);
}

async function runRuntimeScenarios({ compose, baseUrl, mock, secrets, redisPrefix }) {
  await getLive(baseUrl);
  await getReady(baseUrl, 200);
  await checkWorkerHeartbeat(baseUrl, secrets.admin, 'cycling', 25_000);

  const spoofedClientIps = new Set([
    '203.0.113.71',
    '203.0.113.72',
    '203.0.113.73',
    '203.0.113.74',
    '203.0.113.75',
    '203.0.113.76',
    '203.0.113.77',
  ]);
  const canary = await postLead(baseUrl, 'canary', {
    'CF-Connecting-IP': '203.0.113.71',
    'X-NF-Client-Connection-IP': '203.0.113.72',
    'True-Client-IP': '203.0.113.73',
    'X-Real-IP': '203.0.113.74',
    'X-Vercel-Forwarded-For': '203.0.113.75',
    'X-Forwarded-For': '203.0.113.76',
    Forwarded: 'for=203.0.113.77',
  });
  assert(canary.response.status === 200 && canary.body?.success === true, 'Full lead canary was not accepted');
  const canaryDelivery = await waitForDeliveredAttempt(mock, canary.body.leadId);
  const deliveredClientIp = canaryDelivery.payload?.technical?.ip;
  assert(
    !spoofedClientIps.has(deliveredClientIp),
    `Client-supplied proxy IP header was trusted through the Nginx boundary: ${deliveredClientIp}`
  );

  compose.service('stop', 'mbl-worker-trigger');
  await checkWorkerHeartbeat(baseUrl, secrets.admin, 'stale', 15_000);
  await getLive(baseUrl);

  mock.setMode('failure');
  const retryLead = await postLead(baseUrl, 'webhook-outage');
  assert(retryLead.response.status === 200 && retryLead.body?.success === true, 'Retry canary was not queued');
  await waitFor(
    'failed webhook attempt',
    () => mock.attemptsForLead(retryLead.body.leadId).some((attempt) => attempt.status === 503),
    { timeoutMs: 15_000, intervalMs: 200 }
  );

  const leadKey = `${redisPrefix}:record:${retryLead.body.leadId}`;
  const queuedBeforeRestart = redisGet(compose, leadKey);
  assert(queuedBeforeRestart, 'Webhook failure removed the lead instead of retaining it for retry');
  const queuedRecord = JSON.parse(queuedBeforeRestart);
  assert(queuedRecord.status === 'pending', `Webhook failure stored unexpected lead status ${queuedRecord.status}`);
  assert(Number(queuedRecord.retryCount) >= 1, 'Webhook failure did not increment retryCount');

  const { body: pendingWorkerHealth } = await getAdminWorker(baseUrl, secrets.admin);
  const oldestPending = oldestPendingFrom(pendingWorkerHealth);
  assert(oldestPending && typeof oldestPending.ageMs === 'number', 'Admin worker health lacks oldestPendingAge');
  assert(
    oldestPending.ageMs >= 0 && oldestPending.state !== 'empty',
    'Queued lead is not reflected in oldestPendingAge'
  );
  const pendingSinceKey = `${redisPrefix}:delivery:pending-since`;
  const queueThresholds = { normal: 1000, warning: 2000, critical: 10_000 };
  compose.redis('ZADD', pendingSinceKey, Date.now() - 500, retryLead.body.leadId);
  await checkOldestPendingState(baseUrl, secrets.admin, 'normal', queueThresholds);
  compose.redis('ZADD', pendingSinceKey, Date.now() - 3000, retryLead.body.leadId);
  await checkOldestPendingState(baseUrl, secrets.admin, 'warning', queueThresholds);
  compose.redis('ZADD', pendingSinceKey, Date.now() - 11_000, retryLead.body.leadId);
  await checkOldestPendingState(baseUrl, secrets.admin, 'critical', queueThresholds);

  const webIdBeforeRestart = compose.containerId('mbl-web');
  compose.service('restart', 'mbl-web');
  await waitFor('web readiness after restart', async () => {
    const response = await fetchWithTimeout(`${baseUrl}/health/ready`).catch(() => null);
    return response?.status === 200;
  });
  const webIdAfterRestart = compose.containerId('mbl-web');
  assert(webIdAfterRestart === webIdBeforeRestart, 'Web restart unexpectedly replaced the immutable container');
  assert(redisGet(compose, leadKey), 'Lead state was lost after web restart');

  compose.service('restart', 'mbl-redis');
  await waitFor('Redis-backed readiness after Redis restart', async () => {
    const response = await fetchWithTimeout(`${baseUrl}/health/ready`).catch(() => null);
    return response?.status === 200;
  });
  assert(redisGet(compose, leadKey), 'Lead state was lost after Redis restart/AOF reload');

  mock.setMode('success');
  await delay(1_500);
  assert(
    !mock.attemptsForLead(retryLead.body.leadId).some((attempt) => attempt.status === 200),
    'Lead retried while the worker trigger was intentionally stopped'
  );
  compose.service('start', 'mbl-worker-trigger');
  await waitForDeliveredAttempt(mock, retryLead.body.leadId, { timeoutMs: 30_000 });
  await checkWorkerHeartbeat(baseUrl, secrets.admin, 'cycling', 15_000);

  const webIdBeforeOutage = compose.containerId('mbl-web');
  const redisOutageMarker = '[o23-redis-outage]';
  const deliveriesBeforeRedisOutage = mock.attempts.filter(
    (attempt) => attempt.payload?.lead?.message === redisOutageMarker
  ).length;
  compose.service('stop', 'mbl-redis');
  await waitFor('readiness=false after Redis outage', async () => {
    const response = await fetchWithTimeout(`${baseUrl}/health/ready`).catch(() => null);
    return response?.status === 503;
  });
  await getLive(baseUrl);
  await getReady(baseUrl, 503);
  await checkLeadFailClosed(baseUrl);
  await delay(1_500);
  const directWebhookBypassCount =
    mock.attempts.filter((attempt) => attempt.payload?.lead?.message === redisOutageMarker).length -
    deliveriesBeforeRedisOutage;
  assert(
    directWebhookBypassCount === 0,
    'Lead submission bypassed the durable queue and called the webhook while Redis was unavailable'
  );

  compose.service('start', 'mbl-redis');
  await waitFor('readiness recovery without application restart', async () => {
    const response = await fetchWithTimeout(`${baseUrl}/health/ready`).catch(() => null);
    return response?.status === 200;
  });
  assert(compose.containerId('mbl-web') === webIdBeforeOutage, 'Redis recovery required replacing the web container');
  await getReady(baseUrl, 200);
  const recoveredLead = await postLead(baseUrl, 'redis-recovered');
  assert(
    recoveredLead.response.status === 200 && recoveredLead.body?.success === true,
    'New lead was not accepted after Redis recovered'
  );
  await waitForDeliveredAttempt(mock, recoveredLead.body.leadId, { timeoutMs: 30_000 });

  return {
    canaryLeadId: canary.body.leadId,
    retryLeadId: retryLead.body.leadId,
    recoveredLeadId: recoveredLead.body.leadId,
    spoofedIpRejected: !spoofedClientIps.has(deliveredClientIp),
    directWebhookBypassCount,
  };
}

function cleanupTempDirectory(tempRoot) {
  if (!tempRoot) return;
  const resolved = path.resolve(tempRoot);
  const expectedParent = path.resolve(os.tmpdir());
  assert(path.dirname(resolved) === expectedParent, `Refusing to clean non-temp path: ${resolved}`);
  assert(path.basename(resolved).startsWith('mbl-o23-runtime-'), `Refusing to clean unexpected path: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function main() {
  const dockerVersion = run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30_000 });
  assert(dockerVersion, 'Docker daemon is unavailable');
  run('docker', ['compose', 'version'], { timeoutMs: 30_000 });

  const files = composeFiles();
  const revision = resolveImageRevision();
  const projectName = `${PROJECT_PREFIX}${randomBytes(4).toString('hex')}`;
  const publicPort = parsePositiveInt(process.env.O23_HTTP_PORT, await reservePort(), 1024);
  const secrets = {
    worker: randomSecret('worker'),
    admin: randomSecret('admin'),
    webhook: randomSecret('webhook'),
    alert: randomSecret('alert'),
    logQuery: randomSecret('log-query'),
  };
  const secretValues = Object.values(secrets);
  const mock = await startMockReceiver(secrets.webhook);
  const runtime = makeTempEnvironment({
    mockPort: mock.port,
    canonicalOrigin: CANONICAL_ORIGIN,
    publicPort,
    projectName,
    imageRevision: revision,
    secrets,
  });
  const compose = createComposeController({
    files,
    projectName,
    env: runtime.composeEnv,
    secrets: secretValues,
  });
  const baseUrl = `http://127.0.0.1:${publicPort}`;
  const skipImageBuild = parseBoolean(process.env.O23_SKIP_BUILD, false);
  let stackCreated = false;
  let failureLogs = '';

  try {
    const services = compose.invoke(['config', '--services']).split(/\r?\n/).filter(Boolean).sort();
    assert(
      JSON.stringify(services) === JSON.stringify([...SERVICE_NAMES].sort()),
      `Production Compose services must be exactly ${SERVICE_NAMES.join(', ')}; got ${services.join(', ')}`
    );

    if (skipImageBuild) {
      run('docker', ['image', 'inspect', `mbl-web:${revision}`, `mbl-nginx:${revision}`]);
    } else {
      compose.invoke(['build', '--pull=false'], { timeoutMs: 900_000 });
    }
    compose.invoke(['up', '--detach', '--no-build', '--remove-orphans'], { timeoutMs: 240_000 });
    stackCreated = true;

    await waitFor(
      'Nginx → Node → Redis readiness',
      async () => {
        const response = await fetchWithTimeout(`${baseUrl}/health/ready`, {}, 3000).catch(() => null);
        return response?.status === 200;
      },
      { timeoutMs: 90_000, intervalMs: 1000 }
    );

    const inspections = checkContainerEnvelope(compose, projectName);
    const webImageId = inspections.get('mbl-web')?.Image;
    assert(webImageId, 'Unable to resolve immutable web image ID');
    const image = checkImageEnvelope(webImageId, revision);
    const nginxImageId = inspections.get('mbl-nginx')?.Image;
    assert(nginxImageId, 'Unable to resolve immutable Nginx image ID');
    const nginxImage = checkNginxImageEnvelope(nginxImageId, revision);
    for (const service of SERVICE_NAMES) {
      const restartPolicy = inspections.get(service)?.HostConfig?.RestartPolicy?.Name;
      assert(['always', 'unless-stopped'].includes(restartPolicy), `${service} lacks a production restart policy`);
    }
    checkRedisPolicy(compose);

    const resources = await checkPublicRoutes(baseUrl);
    await checkStatusesAndRedirects(baseUrl);
    await checkRobotsAndSitemap(baseUrl);
    const resourcesChecked = await checkResourceIntegrity(resources);
    await checkCacheAndSecurityHeaders(baseUrl, secrets.worker);
    const browser = checkBrowserRuntime(baseUrl);
    const scenarios = await runRuntimeScenarios({
      compose,
      baseUrl,
      mock,
      secrets,
      redisPrefix: runtime.redisPrefix,
    });
    const logs = await checkContainerLogs(compose, secrets, baseUrl);

    const finalWeb = inspectContainer(compose.containerId('mbl-web'));
    assert(finalWeb.Image === webImageId, 'Runtime scenarios replaced the immutable web image');
    const finalNginx = inspectContainer(compose.containerId('mbl-nginx'));
    assert(finalNginx.Image === nginxImageId, 'Runtime scenarios replaced the immutable Nginx image');

    console.log(
      JSON.stringify(
        {
          status: 'PASS',
          projectName,
          imageTag: `mbl-web:${runtime.composeEnv.MBL_IMAGE_TAG}`,
          imageId: webImageId,
          image,
          imageBuild: skipImageBuild ? 'reused' : 'built',
          nginxImageTag: `mbl-nginx:${runtime.composeEnv.MBL_IMAGE_TAG}`,
          nginxImageId,
          nginxImage,
          services,
          exposedPort: publicPort,
          resourcesChecked,
          browser,
          redis: { appendonly: true, appendfsync: 'everysec', maxmemoryPolicy: 'noeviction', persistenceRestart: true },
          health: { live: true, ready: true, outageRecoveryWithoutWebRestart: true, workerStaleDetected: true },
          leadCanary: scenarios,
          logs,
        },
        null,
        2
      )
    );
  } catch (error) {
    if (stackCreated) {
      try {
        failureLogs = compose.invoke(['logs', '--no-color', '--tail', '120']);
      } catch {
        failureLogs = '(failed to collect Compose logs)';
      }
    }
    const message = sanitizeDiagnostic(error instanceof Error ? error.message : error, secretValues);
    const logs = sanitizeDiagnostic(failureLogs, secretValues);
    throw new Error(`${message}${logs ? `\nCompose log tail:\n${logs}` : ''}`);
  } finally {
    if (stackCreated && !parseBoolean(process.env.O23_KEEP_STACK, false)) {
      try {
        compose.invoke(['down', '--volumes', '--remove-orphans'], { timeoutMs: 180_000 });
      } catch (error) {
        console.error('[compose-runtime] cleanup_failed', {
          code: sanitizeDiagnostic(error instanceof Error ? error.message : error, secretValues),
          projectName,
        });
      }
    }
    await mock.close();
    if (!parseBoolean(process.env.O23_KEEP_STACK, false)) cleanupTempDirectory(runtime.tempRoot);
  }
}

export {
  SERVICE_NAMES,
  extractCanonical,
  extractPageResources,
  heartbeatFrom,
  normalizePathname,
  oldestPendingFrom,
  redact,
  timingSafeSignature,
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('[compose-runtime] FAIL', error instanceof Error ? error.message : 'UNKNOWN');
    process.exitCode = 1;
  });
}
