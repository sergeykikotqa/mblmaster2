import process from 'node:process';

import {
  loadTelegramNotificationConfig,
  sendTelegramTestMessage,
  telegramNotifierErrorCode,
} from './telegram-monitor-notifier.mjs';

async function main() {
  try {
    const config = loadTelegramNotificationConfig(process.env);
    if (!config.enabled) throw new Error('TELEGRAM_DISABLED');
    const result = await sendTelegramTestMessage(config);
    if (!result.ok) throw new Error('TELEGRAM_DELIVERY_FAILED');
    console.log(JSON.stringify({ status: 'PASS', delivered: true }));
  } catch (error) {
    const safeCode =
      error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
        ? error.message
        : telegramNotifierErrorCode(error);
    console.error(JSON.stringify({ status: 'FAIL', delivered: false, code: safeCode }));
    process.exitCode = 1;
  }
}

await main();
