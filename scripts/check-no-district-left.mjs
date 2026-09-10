import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GENERATED_PAGES_PATH = path.join(ROOT, 'data', 'generated-pages.json');
const SERVICES_PATH = path.join(ROOT, 'data', 'services.json');
const LEGACY_DISTRICT_ROUTE = path.join(ROOT, 'src', 'pages', '[city]', '[district]', '[service].astro');

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing file: ${path.relative(ROOT, filePath).replace(/\\/g, '/')}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const pages = readJson(GENERATED_PAGES_PATH);
  const services = readJson(SERVICES_PATH);

  if (!Array.isArray(pages)) {
    fail('generated-pages.json must be an array.');
  }
  if (!Array.isArray(services)) {
    fail('services.json must be an array.');
  }

  const districtPages = pages.filter((page) =>
    String(page?.pageType || '')
      .toLowerCase()
      .includes('district')
  );
  if (districtPages.length > 0) {
    const details = districtPages.map((page) => `- ${String(page?.pageSlug || '<unknown>')}`).join('\n');
    fail(`District pages are forbidden in generated-pages.json:\n${details}`);
  }

  const districtEnabledServices = services.filter((service) => service?.hasDistrictPages === true);
  if (districtEnabledServices.length > 0) {
    const details = districtEnabledServices.map((service) => `- ${String(service?.id || '<unknown>')}`).join('\n');
    fail(`services.json hasDistrictPages must be false for all services:\n${details}`);
  }

  if (fs.existsSync(LEGACY_DISTRICT_ROUTE)) {
    fail('Legacy district route file exists: src/pages/[city]/[district]/[service].astro');
  }

  console.log('District-off guard passed: no district pages or district rollout flags found.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
