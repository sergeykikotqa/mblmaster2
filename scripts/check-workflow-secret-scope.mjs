import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'actions.yaml');
const MONITOR_WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'external-production-monitor.yaml');
const TARGET_JOB = 'check-production';

function fail(message) {
  throw new Error(message);
}

function extractJobBlock(lines, jobName) {
  const header = `  ${jobName}:`;
  const start = lines.findIndex((line) => line.startsWith(header));
  if (start === -1) {
    fail(`Job "${jobName}" not found in .github/workflows/actions.yaml`);
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-zA-Z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }

  return {
    start,
    lines: lines.slice(start, end),
  };
}

function main() {
  if (!fs.existsSync(WORKFLOW_PATH)) {
    fail('Missing .github/workflows/actions.yaml');
  }

  const source = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const lines = source.split(/\r?\n/);
  const job = extractJobBlock(lines, TARGET_JOB);

  const npmCiIndex = job.lines.findIndex((line) => /\brun:\s*npm ci\b/.test(line));
  if (npmCiIndex === -1) {
    fail(`Job "${TARGET_JOB}" must contain "run: npm ci".`);
  }

  const jobLevelEnvIndex = job.lines.findIndex((line) => /^ {4}env:\s*$/.test(line));
  if (jobLevelEnvIndex !== -1) {
    fail(`Job "${TARGET_JOB}" has job-level env. Secrets must be scoped to specific steps.`);
  }

  const secretReferenceBeforeNpmCi = job.lines.slice(0, npmCiIndex + 1).find((line) => line.includes('${{ secrets.'));
  if (secretReferenceBeforeNpmCi) {
    fail(`Secrets are referenced before npm ci in "${TARGET_JOB}". Move them to post-install step env scope.`);
  }

  if (!fs.existsSync(MONITOR_WORKFLOW_PATH)) {
    fail('Missing .github/workflows/external-production-monitor.yaml');
  }
  const monitorSource = fs.readFileSync(MONITOR_WORKFLOW_PATH, 'utf8');
  const monitorLines = monitorSource.split(/\r?\n/);
  if (/pull_request(?:_target)?:/.test(monitorSource)) {
    fail('External production monitor must never run in a pull-request context.');
  }
  if (monitorLines.some((line) => /^ {4}env:\s*$/.test(line))) {
    fail('External production monitor has job-level env. Secrets must stay on the probe step.');
  }
  const probeStart = monitorLines.findIndex((line) =>
    line.includes('- name: Probe production and signal independent monitor')
  );
  if (probeStart === -1) fail('External production monitor probe step not found.');
  let probeEnd = monitorLines.length;
  for (let index = probeStart + 1; index < monitorLines.length; index += 1) {
    if (/^ {6}- name:/.test(monitorLines[index])) {
      probeEnd = index;
      break;
    }
  }
  const secretLines = monitorLines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.includes('${{ secrets.'));
  if (secretLines.length !== 3 || secretLines.some((entry) => entry.index < probeStart || entry.index >= probeEnd)) {
    fail('External monitor secrets must appear only in the bounded probe step.');
  }

  console.log(`Secrets scope guard passed for "${TARGET_JOB}" and the external production monitor.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
