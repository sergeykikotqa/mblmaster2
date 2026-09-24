import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { readMonitorStatusSnapshot, writeMonitorStatusSnapshot } from './monitor-status-snapshot.mjs';
import { formatMetricsCommand, loadTelegramAdminConfig, runTelegramAdminOnce } from './telegram-admin.mjs';
import { notifyTelegramForReport } from './telegram-monitor-notifier.mjs';

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

function metric(kind) {
  return {
    ok: true,
    complete: true,
    period: {
      kind,
      timeZone: 'Asia/Irkutsk',
      startLocal: kind === 'today' ? '2026-09-21T00:00:00+08:00' : '2026-09-21T00:00:00+08:00',
      endLocal: '2026-09-21T12:00:00+08:00',
    },
    counts: { consentedPageViews: 10, consentedFormOpens: 4, acceptedLeads: 2 },
    conversions: {
      openedPerPageView: {
        numerator: 4,
        denominator: 10,
        compatible: false,
        rate: null,
        reason: 'CONSENT_SCOPE_MISMATCH',
      },
      submittedPerOpened: {
        numerator: 2,
        denominator: 4,
        compatible: false,
        rate: null,
        reason: 'CONSENT_SCOPE_MISMATCH',
      },
      submittedPerPageView: {
        numerator: 2,
        denominator: 10,
        compatible: false,
        rate: null,
        reason: 'CONSENT_SCOPE_MISMATCH',
      },
    },
    source: 'local_funnel',
    scope: 'trusted_public_routes',
    historicalCaptureVerified: false,
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-telegram-admin-'));
  const token = `${'7'.repeat(9)}:${'A'.repeat(35)}`;
  const userId = '123456789';
  const chatId = '123456789';
  const nowMs = Date.parse('2026-09-21T04:00:00.000Z');
  const nowSec = nowMs / 1000;
  const piiSentinel = '+7-999-owner-private';
  let metricsAvailable = true;
  let updates = [
    {
      update_id: 1,
      message: {
        date: nowSec,
        from: { id: 987654321 },
        chat: { id: Number(chatId), type: 'private' },
        text: '/status',
      },
    },
    {
      update_id: 2,
      message: {
        date: nowSec,
        from: { id: Number(userId) },
        chat: { id: -100123456, type: 'supergroup' },
        text: '/status',
      },
    },
    {
      update_id: 3,
      message: {
        date: nowSec,
        from: { id: Number(userId) },
        chat: { id: Number(chatId), type: 'private' },
        text: '/today',
      },
    },
    {
      update_id: 4,
      message: {
        date: nowSec,
        from: { id: Number(userId) },
        chat: { id: Number(chatId), type: 'private' },
        text: '/week',
      },
    },
    {
      update_id: 5,
      message: {
        date: nowSec,
        from: { id: Number(userId) },
        chat: { id: Number(chatId), type: 'private' },
        text: '/funnel',
      },
    },
    {
      update_id: 6,
      message: {
        date: nowSec,
        from: { id: Number(userId) },
        chat: { id: Number(chatId), type: 'private' },
        text: '/status',
      },
    },
  ];
  const sent = [];

  assert.throws(
    () =>
      loadTelegramAdminConfig({
        TELEGRAM_BOT_TOKEN: token,
        MBL_TELEGRAM_ADMIN_USER_ID: userId,
        MBL_TELEGRAM_ADMIN_CHAT_ID: chatId,
        MBL_MONITOR_BASE_URL: 'https://mbl.example',
        MBL_MONITOR_TOKEN: 'same-service-credential-1234567890',
        MBL_OWNER_METRICS_TOKEN: 'same-service-credential-1234567890',
        MBL_TELEGRAM_ADMIN_STATE_FILE: path.join(tempRoot, 'config-state.json'),
        MBL_MONITOR_STATUS_FILE: path.join(tempRoot, 'config-status.json'),
      }),
    /METRICS_TOKEN_INVALID/
  );

  assert.match(
    formatMetricsCommand('/week', {
      ok: true,
      complete: false,
      reason: 'HOURLY_RETENTION_INSUFFICIENT',
      period: {
        kind: 'week',
        timeZone: 'Asia/Irkutsk',
        startLocal: '2026-09-21T00:00:00+08:00',
        endLocal: '2026-09-21T12:00:00+08:00',
      },
      counts: null,
      conversions: null,
    }),
    /недостаточно для точного итога/
  );
  const zeroFunnel = metric('today');
  zeroFunnel.counts = { consentedPageViews: 0, consentedFormOpens: 0, acceptedLeads: 0 };
  zeroFunnel.conversions = {
    openedPerPageView: {
      numerator: 0,
      denominator: 0,
      compatible: false,
      rate: null,
      reason: 'CONSENT_SCOPE_MISMATCH',
    },
    submittedPerOpened: {
      numerator: 0,
      denominator: 0,
      compatible: false,
      rate: null,
      reason: 'CONSENT_SCOPE_MISMATCH',
    },
    submittedPerPageView: {
      numerator: 0,
      denominator: 0,
      compatible: false,
      rate: null,
      reason: 'CONSENT_SCOPE_MISMATCH',
    },
  };
  assert.match(formatMetricsCommand('/funnel', zeroFunnel), /не рассчитывается \(разный охват согласия\)/);

  const server = await listen((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const url = new URL(request.url, server.origin);
      let payload;
      let status = 200;
      if (url.pathname.endsWith('/getUpdates')) {
        // Deliberately return old updates too; the durable offset must reject
        // them after a process restart.
        payload = { ok: true, result: updates };
      } else if (url.pathname.endsWith('/sendMessage')) {
        sent.push({ chatId: body.chat_id, text: body.text });
        payload = { ok: true, result: { message_id: sent.length } };
      } else if (url.pathname === '/api/monitoring/owner-metrics') {
        assert.equal(request.headers.authorization, 'Bearer owner-metrics-test-credential');
        if (metricsAvailable) payload = metric(url.searchParams.get('period'));
        else {
          status = 503;
          payload = { ok: false, code: 'METRICS_SOURCE_UNAVAILABLE', piiSentinel };
        }
      } else {
        status = 404;
        payload = { ok: false };
      }
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    });
  });

  const config = {
    token,
    userId,
    chatId,
    metricsToken: 'owner-metrics-test-credential',
    baseUrl: new URL(server.origin),
    apiOrigin: server.origin,
    timeoutMs: 1000,
    stateFile: path.join(tempRoot, 'admin-state.json'),
    statusFile: path.join(tempRoot, 'status.json'),
  };
  await writeMonitorStatusSnapshot(
    {
      checkedAtMs: nowMs - 60_000,
      checks: {
        edge: { ok: true },
        ready: { ok: true },
        operational: {
          summary: { redis: true, worker: 'healthy', queue: 'healthy', queueDepth: 0, backup: 'fresh' },
        },
      },
    },
    config.statusFile
  );
  const statusReader = readMonitorStatusSnapshot;

  try {
    const first = await runTelegramAdminOnce(config, { nowMs, statusReader });
    assert.deepEqual(first, { received: 6, processed: 4, replied: 4, deliveryFailures: 0 });
    assert.equal(sent.length, 4, 'Unauthorized owner/chat generated a response');
    assert.match(sent[0].text, /Просмотры с согласием на аналитику: 10/);
    assert.match(sent[0].text, /не весь сайт/);
    assert.match(sent[0].text, /не уникальные посетители/);
    assert.match(sent[1].text, /текущая неделя/);
    assert.match(sent[2].text, /Заявки \/ открытия \(2\/4\): не рассчитывается/);
    assert.doesNotMatch(sent[2].text, /50%/);
    assert.match(sent[2].text, /разный охват согласия/);
    assert.match(sent[3].text, /Данные независимого мониторинга/);
    assert.doesNotMatch(fs.readFileSync(config.statusFile, 'utf8'), /token|secret|phone|message|backupId/i);

    const restarted = await runTelegramAdminOnce(config, { nowMs: nowMs + 1_000, statusReader });
    assert.equal(restarted.processed, 0, 'Persisted offset did not suppress duplicate updates after restart');
    assert.equal(sent.length, 4);

    metricsAvailable = false;
    updates = [
      ...updates,
      {
        update_id: 7,
        message: {
          date: nowSec + 2,
          from: { id: Number(userId) },
          chat: { id: Number(chatId), type: 'private' },
          text: '/today',
        },
      },
    ];
    const unavailable = await runTelegramAdminOnce(config, { nowMs: nowMs + 2_000, statusReader });
    assert.equal(unavailable.replied, 1);
    assert.match(sent.at(-1).text, /Данные недоступны/);
    assert.doesNotMatch(sent.at(-1).text, /0 просмотров|0 заявок/);
    assert.doesNotMatch(sent.map((item) => item.text).join('\n'), new RegExp(piiSentinel.replace('+', '\\+')));

    updates = [
      ...updates,
      {
        update_id: 8,
        message: {
          date: nowSec + 3,
          from: { id: Number(userId) },
          chat: { id: Number(chatId), type: 'private' },
          text: '/status',
        },
      },
      {
        update_id: 9,
        message: {
          date: nowSec + 3,
          from: { id: Number(userId) },
          chat: { id: Number(chatId), type: 'private' },
          text: '/status',
        },
      },
    ];
    const limited = await runTelegramAdminOnce(config, { nowMs: nowMs + 3_000, statusReader });
    assert.deepEqual(limited, { received: 9, processed: 1, replied: 2, deliveryFailures: 0 });
    assert.match(sent.at(-1).text, /Повторите через минуту/);

    // The existing outbound incident lifecycle still uses the same bot and
    // remains independent of update polling.
    const alert = await notifyTelegramForReport(
      {
        enabled: true,
        token,
        chatId,
        stateFile: path.join(tempRoot, 'alert-state.json'),
        apiOrigin: server.origin,
        timeoutMs: 1000,
        maxRetries: 0,
        escalationMs: 60 * 60 * 1000,
        retryMs: 60_000,
      },
      { ok: false, checkedAtMs: nowMs + 3_000, codes: ['WORKER_HEARTBEAT_STALE'] },
      { apiOrigin: server.origin }
    );
    assert.equal(alert.delivered, true);
    assert.match(sent.at(-1).text, /Обработчик заявок/);
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('Telegram Admin mock gate passed: owner-only commands, restart safety, outage handling and alerts.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'TELEGRAM_ADMIN_CHECK_FAILED');
  process.exitCode = 1;
});
