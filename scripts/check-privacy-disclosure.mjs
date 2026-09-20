import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PRIVACY_PATH = path.join(ROOT, 'src', 'pages', 'privacy.astro');

function fail(message) {
  throw new Error(message);
}

function main() {
  if (!fs.existsSync(PRIVACY_PATH)) {
    fail('Privacy disclosure check failed: src/pages/privacy.astro is missing.');
  }

  const source = fs.readFileSync(PRIVACY_PATH, 'utf8');
  const normalized = source.toLowerCase();

  const missing = [];
  if (!/yandex|metrika/.test(normalized)) {
    missing.push('Yandex/Metrika disclosure');
  }
  if (!/cookie|cookies|куки|аналит/.test(normalized)) {
    missing.push('cookie/analytics disclosure');
  }
  if (!/smartcaptcha/.test(normalized) || !/техническ.*дан|technical.*data/.test(normalized)) {
    missing.push('SmartCaptcha technical-data disclosure');
  }

  if (missing.length > 0) {
    fail(`Privacy disclosure check failed: missing ${missing.join(', ')}.`);
  }

  console.log(
    'Privacy disclosure check passed: privacy page mentions Yandex.Metrika, cookies/analytics and SmartCaptcha.'
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
