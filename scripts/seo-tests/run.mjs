import { spawn } from 'node:child_process';
import process from 'node:process';

import { buildSiteGraph, writeCrawlReport } from './lib/site-graph.mjs';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const EXISTING_GATES = [
  'check:canonical-absolute',
  'check:canonical-in-sitemap',
  'check:sitemap-coverage',
  'check:article-seo-rollout',
  'check:indexability-runtime-consistency',
  'check:schema',
  'check:seo',
  'check:canonical-nav-links',
  'check:decapcms-headers',
  'check:lighthouse-routes',
];

function summarizeOutput(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return 'No output.';
  }

  return lines[lines.length - 1];
}

function runGate(scriptName) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(npmCommand, ['run', '--silent', scriptName], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk || '');
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt;
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      resolve({
        id: scriptName,
        status: code === 0 ? 'pass' : 'fail',
        durationMs,
        output,
        summary: summarizeOutput(output || (code === 0 ? 'Passed.' : 'Failed.')),
      });
    });
  });
}

function printBucket(title, rows) {
  console.log(title);
  if (rows.length === 0) {
    console.log('- none');
    return;
  }

  for (const row of rows) {
    console.log(`- ${row}`);
  }
}

async function main() {
  const gateResults = [];
  for (const gate of EXISTING_GATES) {
    const result = await runGate(gate);
    gateResults.push(result);
  }

  let graphReport;
  let reportPaths = null;
  let graphBuildError = null;

  try {
    const graph = await buildSiteGraph();
    graphReport = {
      ...graph,
      gateResults,
    };
    reportPaths = writeCrawlReport(graphReport);
  } catch (error) {
    graphBuildError = error instanceof Error ? error : new Error(String(error));
  }

  const gateFailures = gateResults.filter((gate) => gate.status === 'fail');
  const graphFailures = graphReport?.failures || [];
  const graphWarnings = graphReport?.warnings || [];
  const failBucket = [
    ...gateFailures.map((gate) => `[gate] ${gate.id}: ${gate.summary}`),
    ...graphFailures.map((issue) => `[graph] ${issue.routePath}: ${issue.code} - ${issue.message}`),
  ];
  const warnBucket = graphWarnings.map((issue) => `[graph] ${issue.routePath}: ${issue.code} - ${issue.message}`);

  if (graphBuildError) {
    failBucket.push(`[graph] build failed: ${graphBuildError.message}`);
  }

  console.log('SEO graph suite finished.');
  if (reportPaths) {
    console.log(`Report JSON: ${reportPaths.jsonPath}`);
    console.log(`Report HTML: ${reportPaths.htmlPath}`);
  }
  printBucket('Fail bucket', failBucket);
  printBucket('Warn bucket', warnBucket);

  if (failBucket.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
