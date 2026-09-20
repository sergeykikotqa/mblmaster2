import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  loadTelegramNotificationConfig,
  notifyTelegramForReport,
  telegramNotifierErrorCode,
} from './telegram-monitor-notifier.mjs';

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

function report(ok, checkedAtMs, codes = []) {
  return { ok, checkedAtMs, codes, targetHost: 'mbl.example.invalid', checks: {} };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-telegram-monitor-'));
  const token = `${'1'.repeat(9)}:${'A'.repeat(35)}`;
  const chatId = '123456789';
  const piiSentinel = '+7-999-telegram-must-not-copy';
  const requests = [];
  let responseMode = 'ok';

  const telegram = await listen((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      requests.push({ method: request.method, text: body.text, chatId: body.chat_id });
      const payload = responseMode === 'api-error' ? { ok: false } : { ok: true, result: { message_id: 1 } };
      const status = responseMode === 'http-error' ? 503 : 200;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    });
  });

  const config = loadTelegramNotificationConfig({
    MBL_TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_CHAT_ID: chatId,
    MBL_TELEGRAM_STATE_FILE: path.join(tempRoot, 'state.json'),
    MBL_TELEGRAM_ESCALATION_SEC: '21600',
    MBL_TELEGRAM_RETRY_SEC: '60',
    MBL_TELEGRAM_TIMEOUT_MS: '1000',
    MBL_TELEGRAM_MAX_RETRIES: '0',
  });

  const requestOptions = { apiOrigin: telegram.origin };
  const startedAt = Date.parse('2026-09-20T10:00:00.000Z');

  try {
    const initial = await notifyTelegramForReport(
      config,
      report(false, startedAt, ['WORKER_HEARTBEAT_STALE']),
      requestOptions
    );
    assert.deepEqual(initial, { ok: true, action: 'incident', delivered: true });
    assert.equal(requests.length, 1, 'New incident did not produce exactly one Telegram message');
    assert.match(requests[0].text, /Обработчик заявок/);

    const continuing = await notifyTelegramForReport(
      { ...config },
      report(false, startedAt + 60_000, ['WORKER_HEARTBEAT_STALE']),
      requestOptions
    );
    assert.equal(continuing.action, 'none');
    assert.equal(continuing.delivered, false);
    assert.equal(requests.length, 1, 'Continuing incident produced notification spam');

    const recovered = await notifyTelegramForReport(config, report(true, startedAt + 120_000), requestOptions);
    assert.deepEqual(recovered, { ok: true, action: 'recovery', delivered: true });
    assert.equal(requests.length, 2, 'Recovery did not produce exactly one Telegram message');
    assert.match(requests[1].text, /система восстановлена/i);

    const repeated = await notifyTelegramForReport(
      config,
      report(false, startedAt + 180_000, ['BACKUP_STALE']),
      requestOptions
    );
    assert.deepEqual(repeated, { ok: true, action: 'incident', delivered: true });
    assert.equal(requests.length, 3, 'A new incident after recovery did not produce a new message');
    assert.match(requests[2].text, /резервная копия/i);

    const apiErrorConfig = { ...config, stateFile: path.join(tempRoot, 'api-error-state.json') };
    responseMode = 'api-error';
    const apiError = await notifyTelegramForReport(
      apiErrorConfig,
      report(false, startedAt + 240_000, ['READINESS_FAILED']),
      requestOptions
    );
    assert.equal(apiError.ok, false);
    assert.equal(apiError.code, 'TELEGRAM_DELIVERY_FAILED');
    assert.match(requests.at(-1).text, /Redis/);
    const requestCountAfterApiError = requests.length;
    const backoff = await notifyTelegramForReport(
      apiErrorConfig,
      report(false, startedAt + 250_000, ['READINESS_FAILED']),
      requestOptions
    );
    assert.equal(backoff.code, 'TELEGRAM_DELIVERY_PENDING');
    assert.equal(requests.length, requestCountAfterApiError, 'Retry backoff was not respected');
    responseMode = 'ok';

    const unavailableConfig = { ...config, stateFile: path.join(tempRoot, 'unavailable-state.json') };
    const unavailable = await notifyTelegramForReport(
      unavailableConfig,
      report(false, startedAt + 300_000, ['EDGE_UNAVAILABLE']),
      { apiOrigin: 'http://127.0.0.1:9' }
    );
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.code, 'TELEGRAM_DELIVERY_FAILED');

    let invalidConfigCode = '';
    try {
      loadTelegramNotificationConfig({
        MBL_TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_CHAT_ID: '',
      });
    } catch (error) {
      invalidConfigCode = telegramNotifierErrorCode(error);
    }
    assert.equal(invalidConfigCode, 'TELEGRAM_CHAT_ID_INVALID');

    const stateEvidence = fs
      .readdirSync(tempRoot)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => fs.readFileSync(path.join(tempRoot, entry), 'utf8'))
      .join('\n');
    const messageEvidence = requests.map((item) => item.text).join('\n');
    assert(!stateEvidence.includes(token), 'State file contains the Telegram token');
    assert(!stateEvidence.includes(chatId), 'State file contains the Telegram Chat ID');
    assert(!stateEvidence.includes(piiSentinel), 'State file contains lead-like PII');
    assert(!messageEvidence.includes(token), 'Telegram message contains the bot token');
    assert(!messageEvidence.includes(chatId), 'Telegram message contains the Chat ID');
    assert(!messageEvidence.includes(piiSentinel), 'Telegram message contains lead-like PII');
    assert(
      requests.every((item) => item.method === 'POST'),
      'Telegram adapter used an unexpected HTTP method'
    );

    console.log(
      JSON.stringify(
        {
          status: 'PASS',
          newIncidentMessages: 1,
          continuingIncidentMessages: 0,
          recoveryMessages: 1,
          repeatedIncidentMessages: 1,
          unavailableHandled: true,
          apiErrorHandled: true,
          retryBackoffEnforced: true,
          invalidConfigurationRejected: true,
          persistentStateVerified: true,
          secretsAndPiiAbsent: true,
        },
        null,
        2
      )
    );
  } finally {
    await telegram.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
