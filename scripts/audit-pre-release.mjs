import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL ?? 'https://example.com',
  METRICS_ADMIN_TOKEN: process.env.METRICS_ADMIN_TOKEN ?? '__SENTINEL__',
  LHCI_NUMBER_OF_RUNS: process.env.LHCI_NUMBER_OF_RUNS ?? '1',
  LHCI_BUILD_CONTEXT__CURRENT_BRANCH: process.env.LHCI_BUILD_CONTEXT__CURRENT_BRANCH ?? 'local',
  NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
};

const steps = [
  'npm run lint',
  'npm run typecheck',
  'npm run check:astro',
  'npm run test',
  'npm run build',
  'npm run check:slugs',
  'npm run check:content-duplicates',
  'npm run check:no-legacy-project-fields',
  'npm run check:image-policy',
  'npm run check:architecture',
  'npm run check:lighthouse-routes',
  'npm run check:lighthouse:smoke',
  'npm run check:performance-budgets',
  'npm run predeploy:seo',
];

for (const step of steps) {
  console.log(`\n=== ${step} ===`);
  const result = spawnSync(step, {
    stdio: 'inherit',
    shell: true,
    env,
  });

  if (result.status !== 0) {
    console.error(`\n[NO-GO] Failed at step: ${step}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n[GO] audit:pre-release completed successfully.');
