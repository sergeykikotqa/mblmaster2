import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HELPER_PATH = path.join(ROOT, 'src', 'lib', 'business-info.ts');
const CONFIG_PATH = path.join(ROOT, 'src', 'config', 'business-info.ts');
const FILES_TO_CHECK = [
  path.join(ROOT, 'src', 'layouts', 'Layout.astro'),
  path.join(ROOT, 'src', 'pages', 'contacts.astro'),
  path.join(ROOT, 'src', 'pages', 'o-kompanii', 'index.astro'),
  path.join(ROOT, 'src', 'components', 'widgets', 'Footer.astro'),
  path.join(ROOT, 'src', 'components', 'widgets', 'Header.astro'),
  path.join(ROOT, 'src', 'components', 'widgets', 'Contact.astro'),
  path.join(ROOT, 'src', 'components', 'widgets', 'CTABlock.astro'),
  path.join(ROOT, 'src', 'components', 'widgets', 'Hero.astro'),
  path.join(ROOT, 'src', 'components', 'CategoryHero.astro'),
  path.join(ROOT, 'src', 'components', 'DistrictHero.astro'),
  path.join(ROOT, 'src', 'components', 'FloatingCallButton.astro'),
];
const REQUIRED_DEFAULTS = [
  "phone: '+7 (964) 107-26-13'",
  "email: 'MBLmaster38@yandex.ru'",
  "addressLocality: 'Иркутск'",
  "streetAddress: 'м-н Зелёный, 34/2, цокольный этаж'",
  "addressDistrict: 'Куйбышевский район'",
];
const FORBIDDEN_SNIPPETS = [
  'Иркутск, ул. Красных Героев, дом 5',
  'ул. Красных Героев, 5',
  'COMPANY_PHONE',
  'COMPANY_ADDRESS',
  'COMPANY_EMAIL',
  'tel:+79025551234',
  '+7 (902) 555-12-34',
  'https://t.me',
];

function fail(message) {
  throw new Error(message);
}

function read(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`NAP consistency check failed: missing file ${path.relative(ROOT, filePath).replace(/\\/g, '/')}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function main() {
  const helperSource = read(HELPER_PATH);
  const helperErrors = REQUIRED_DEFAULTS.filter((value) => !helperSource.includes(value));
  if (helperErrors.length > 0) {
    fail(
      `NAP consistency check failed: business-info defaults are incomplete.\n${helperErrors
        .map((item) => `- missing ${item}`)
        .join('\n')}`
    );
  }

  const configSource = read(CONFIG_PATH);
  if (!configSource.includes('getBusinessInfo')) {
    fail('NAP consistency check failed: config/business-info.ts must export getBusinessInfo().');
  }

  const errors = [];
  for (const filePath of FILES_TO_CHECK) {
    const source = read(filePath);
    const relativePath = path.relative(ROOT, filePath).replace(/\\/g, '/');

    if (!source.includes('resolveBusinessInfo') && !source.includes('getBusinessInfo')) {
      errors.push(`- ${relativePath}: must use getBusinessInfo() or resolveBusinessInfo()`);
    }

    for (const snippet of FORBIDDEN_SNIPPETS) {
      if (source.includes(snippet)) {
        errors.push(`- ${relativePath}: contains stale literal "${snippet}"`);
      }
    }
  }

  if (errors.length > 0) {
    fail(`NAP consistency check failed.\n${errors.join('\n')}`);
  }

  console.log(`NAP consistency check passed: helper + ${FILES_TO_CHECK.length} consumer files verified.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
