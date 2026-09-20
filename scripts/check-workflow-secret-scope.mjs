import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const RETIRED_PRODUCTION_WORKFLOWS = [
  'external-production-monitor.yaml',
  'lead-worker-cron.yaml',
  'metrics-health-cron.yaml',
  'metrics-snapshot-cron.yaml',
];
const PRODUCTION_SECRET_PATTERN =
  /PRODUCTION_MONITOR_|TELEGRAM_(?:BOT_TOKEN|CHAT_ID)|secrets\.(?:REDIS_URL|CONTACT_WORKER_TOKEN|CONTACT_WEBHOOK_SECRET|SMARTCAPTCHA_SERVER_KEY|METRICS_ADMIN_TOKEN)/;

function fail(message) {
  throw new Error(message);
}

function main() {
  if (!fs.existsSync(WORKFLOWS_DIR)) fail('Missing .github/workflows directory');

  for (const retired of RETIRED_PRODUCTION_WORKFLOWS) {
    if (fs.existsSync(path.join(WORKFLOWS_DIR, retired))) {
      fail(`Retired GitHub production workflow must stay removed: ${retired}`);
    }
  }

  const workflowFiles = fs.readdirSync(WORKFLOWS_DIR).filter((entry) => /\.ya?ml$/i.test(entry));
  if (workflowFiles.length === 0) fail('No development workflows found');

  for (const workflowFile of workflowFiles) {
    const workflowSource = fs.readFileSync(path.join(WORKFLOWS_DIR, workflowFile), 'utf8');
    if (PRODUCTION_SECRET_PATTERN.test(workflowSource)) {
      fail(`GitHub workflow references a production runtime/monitoring secret: ${workflowFile}`);
    }
    if (/\/api\/workers\/|check:deployed-runtime/.test(workflowSource)) {
      fail(`GitHub workflow invokes a production worker/deployed runtime: ${workflowFile}`);
    }
    if (
      /^\s+schedule:\s*$/m.test(workflowSource) &&
      /CONTACT_WORKER_URL|METRICS_\w*_WORKER_URL|MBL_MONITOR_BASE_URL/.test(workflowSource)
    ) {
      fail(`Scheduled GitHub workflow contains a production endpoint: ${workflowFile}`);
    }
  }

  console.log(
    'Workflow scope guard passed: GitHub contains development checks only; production monitoring and worker triggers are absent.'
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
