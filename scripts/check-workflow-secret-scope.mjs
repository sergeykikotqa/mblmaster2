import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'actions.yaml');
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

  console.log(`Secrets scope guard passed for workflow job "${TARGET_JOB}".`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
