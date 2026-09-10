import process from 'node:process';

function readRequiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function main() {
  const verification = readRequiredEnv('PUBLIC_YANDEX_VERIFICATION');
  const metrikaId = readRequiredEnv('PUBLIC_YANDEX_METRIKA_ID');

  if (verification.length < 6 || /replace|example|changeme|placeholder/i.test(verification)) {
    throw new Error('PUBLIC_YANDEX_VERIFICATION looks like a placeholder');
  }

  if (!/^\d{4,}$/.test(metrikaId)) {
    throw new Error('PUBLIC_YANDEX_METRIKA_ID must be a numeric counter id');
  }

  console.log('Yandex release env check passed: verification + metrika are configured.');
}

main();
