import assert from 'node:assert/strict';
import http from 'node:http';
import process from 'node:process';

import { loadExternalMonitorConfig, runExternalMonitor } from './external-monitor.mjs';

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function main() {
  const token = 'monitor-sentinel-token-value-20260920';
  const piiSentinel = '+7-999-monitor-must-not-copy';
  const siteState = {
    edge: 'healthy',
    ready: true,
    operational: 'healthy',
    operationalCalls: 0,
    requests: [],
  };
  const signals = [];
  let signalStatus = 204;

  const site = await listen((request, response) => {
    siteState.requests.push({ method: request.method, url: request.url });
    if (request.url === '/') {
      if (siteState.edge === 'redirect') {
        response.writeHead(302, { Location: '/moved' });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body>MBL</body></html>');
      return;
    }
    if (request.url === '/health/live') {
      json(response, 200, { ok: true, status: 'live' });
      return;
    }
    if (request.url === '/health/ready') {
      json(response, siteState.ready ? 200 : 503, {
        ok: siteState.ready,
        status: siteState.ready ? 'ready' : 'not_ready',
      });
      return;
    }
    if (request.url === '/api/monitoring/health') {
      siteState.operationalCalls += 1;
      if (request.headers.authorization !== `Bearer ${token}`) {
        json(response, 401, { ok: false, code: 'UNAUTHORIZED' });
        return;
      }
      if (siteState.operational === 'invalid-json') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end('{broken');
        return;
      }
      if (siteState.operational === 'degraded') {
        json(response, 503, {
          ok: false,
          service: 'mbl-production',
          incidents: ['WORKER_HEARTBEAT_STALE', 'BACKUP_STALE'],
          ignoredUnsafeDetail: piiSentinel,
        });
        return;
      }
      json(response, 200, { ok: true, service: 'mbl-production', incidents: [] });
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const signal = await listen((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      signals.push({
        method: request.method,
        url: request.url,
        idempotencyKey: request.headers['idempotency-key'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      response.writeHead(signalStatus);
      response.end();
    });
  });

  const config = loadExternalMonitorConfig({
    MBL_MONITOR_ALLOW_HTTP: 'true',
    MBL_MONITOR_BASE_URL: site.origin,
    MBL_MONITOR_TOKEN: token,
    MBL_MONITOR_SUCCESS_URL: `${signal.origin}/success/private-signal-key`,
    MBL_MONITOR_FAILURE_URL: `${signal.origin}/failure/private-signal-key`,
    MBL_MONITOR_TIMEOUT_MS: '2000',
  });

  try {
    const healthy = await runExternalMonitor(config, { nowMs: Date.now(), env: {} });
    assert.equal(healthy.ok, true);
    assert.deepEqual(healthy.codes, []);
    assert.equal(signals.at(-1)?.url, '/success/private-signal-key');

    const notificationFailed = await runExternalMonitor(config, {
      nowMs: Date.now(),
      notificationAdapter: async () => ({
        ok: false,
        action: 'incident',
        delivered: false,
        code: 'TELEGRAM_DELIVERY_FAILED',
      }),
    });
    assert.equal(notificationFailed.ok, false);
    assert(notificationFailed.codes.includes('TELEGRAM_DELIVERY_FAILED'));
    assert.equal(signals.at(-1)?.url, '/failure/private-signal-key');

    const callsBeforeRedirect = siteState.operationalCalls;
    siteState.edge = 'redirect';
    const redirected = await runExternalMonitor(config, { nowMs: Date.now(), env: {} });
    assert.equal(redirected.ok, false);
    assert(redirected.codes.includes('EDGE_REDIRECTED'));
    assert.equal(siteState.operationalCalls, callsBeforeRedirect, 'Deep checks ran after an edge failure');
    siteState.edge = 'healthy';

    const callsBeforeReadiness = siteState.operationalCalls;
    siteState.ready = false;
    const notReady = await runExternalMonitor(config, { nowMs: Date.now(), env: {} });
    assert.equal(notReady.ok, false);
    assert(notReady.codes.includes('READINESS_FAILED'));
    assert.equal(siteState.operationalCalls, callsBeforeReadiness, 'Deep checks ran after a readiness failure');
    siteState.ready = true;

    siteState.operational = 'degraded';
    const degraded = await runExternalMonitor(config, { nowMs: Date.now(), env: {} });
    assert.equal(degraded.ok, false);
    assert.deepEqual(degraded.codes, ['BACKUP_STALE', 'WORKER_HEARTBEAT_STALE']);
    assert.equal(signals.at(-1)?.url, '/failure/private-signal-key');
    assert(!JSON.stringify(signals.at(-1)?.body).includes(piiSentinel), 'Signal copied an operational response body');

    siteState.operational = 'invalid-json';
    const invalid = await runExternalMonitor(config, { nowMs: Date.now(), env: {} });
    assert.equal(invalid.ok, false);
    assert(invalid.codes.includes('INVALID_JSON'));
    siteState.operational = 'healthy';

    const wrongTokenConfig = { ...config, token: 'wrong-monitor-token-value-20260920' };
    const unauthorized = await runExternalMonitor(wrongTokenConfig, { nowMs: Date.now(), env: {} });
    assert.equal(unauthorized.ok, false);
    assert(unauthorized.codes.includes('MONITOR_AUTH_FAILED'));

    signalStatus = 500;
    const undeliverable = await runExternalMonitor(config, { nowMs: Date.now(), env: {} });
    assert.equal(undeliverable.ok, false);
    assert.equal(undeliverable.signal.delivered, false);
    assert(undeliverable.codes.some((code) => code.includes('SIGNAL') || code.includes('NETWORK')));
    signalStatus = 204;

    const evidence = JSON.stringify({
      healthy,
      notificationFailed,
      redirected,
      notReady,
      degraded,
      invalid,
      unauthorized,
      undeliverable,
    });
    assert(!evidence.includes(token), 'Evidence contains the monitoring token');
    assert(!evidence.includes('private-signal-key'), 'Evidence contains a signal URL secret');
    assert(!evidence.includes(piiSentinel), 'Evidence contains lead-like PII');
    assert(
      siteState.requests.every((item) => item.method === 'GET'),
      'External monitor used a mutating method against the MBL site'
    );
    assert(
      siteState.requests.every((item) => !item.url.startsWith('/api/leads') && !item.url.startsWith('/api/workers')),
      'External monitor invoked a lead or worker endpoint'
    );

    console.log(
      JSON.stringify(
        {
          status: 'PASS',
          healthySignal: true,
          edgeHierarchy: true,
          readinessHierarchy: true,
          operationalIncidents: ['BACKUP_STALE', 'WORKER_HEARTBEAT_STALE'],
          authFailureDetected: true,
          invalidContractDetected: true,
          signalFailureDetected: true,
          notificationFailureDetected: true,
          readOnly: true,
          secretsAndPiiAbsent: true,
        },
        null,
        2
      )
    );
  } finally {
    await Promise.all([site.close(), signal.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
