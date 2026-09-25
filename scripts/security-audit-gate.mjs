import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmArgs = ['audit', '--omit=dev', '--json'];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultAllowlistPath = path.resolve(scriptDir, 'security-audit-allowlist.json');
const defaultBaselinePath = path.resolve(repoRoot, 'artifacts', 'security-audit-baseline.json');
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

function extractJsonPayload(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

export function parseAuditReport(raw) {
  const payload = extractJsonPayload(raw);
  if (!payload) throw new Error('Unable to locate JSON payload in npm audit output.');
  const report = JSON.parse(payload);
  if (
    report?.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== 'object' ||
    Array.isArray(report.vulnerabilities) ||
    !report.metadata?.vulnerabilities ||
    typeof report.metadata.vulnerabilities !== 'object'
  ) {
    throw new Error('npm audit output does not contain a supported audit report.');
  }
  return report;
}

function parseDateOrNull(rawDate) {
  if (typeof rawDate !== 'string' || !rawDate.trim()) return null;
  const parsed = new Date(`${rawDate.trim()}T23:59:59.999Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeSeverity(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeRange(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePackageName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDependencyPath(nodePath, fallbackPackage) {
  const fallback = normalizePackageName(fallbackPackage);
  if (typeof nodePath !== 'string' || !nodePath.trim()) return fallback;
  const parts = nodePath
    .split('node_modules/')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return parts.length === 0 ? fallback : parts.join(' > ');
}

function advisoryIdFromViaEntry(entry, fallbackPackage) {
  if (entry && typeof entry.url === 'string') {
    const match = entry.url.match(/GHSA-[a-z0-9-]+/i);
    if (match) return match[0].toUpperCase();
  }
  const sourceId = entry?.source == null ? '' : String(entry.source).trim();
  if (sourceId) return `NPM-${sourceId}`;
  const fallback = normalizePackageName(fallbackPackage)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-');
  return `NPM-META-${fallback || 'UNKNOWN'}`;
}

export function buildFindingKey(entry) {
  return [entry.advisory, entry.package, entry.path, entry.severity, entry.range].join('|');
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = buildFindingKey(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectAdvisoryFindings(packageName, vulnerabilities, rootSeverity, stack = new Set()) {
  const vulnerability = vulnerabilities[packageName];
  if (!vulnerability || typeof vulnerability !== 'object' || stack.has(packageName)) return [];
  const nextStack = new Set(stack);
  nextStack.add(packageName);
  const name = normalizePackageName(vulnerability.name || packageName);
  const severity = normalizeSeverity(vulnerability.severity) || rootSeverity;
  const range = normalizeRange(vulnerability.range);
  const nodes =
    Array.isArray(vulnerability.nodes) && vulnerability.nodes.length > 0 ? vulnerability.nodes : [name || packageName];
  const findings = [];

  for (const via of Array.isArray(vulnerability.via) ? vulnerability.via : []) {
    if (typeof via === 'string') {
      findings.push(...collectAdvisoryFindings(via, vulnerabilities, severity, nextStack));
      continue;
    }
    if (!via || typeof via !== 'object') continue;
    const advisorySeverity = normalizeSeverity(via.severity) || severity;
    if (!BLOCKING_SEVERITIES.has(advisorySeverity)) continue;
    const advisoryRange = normalizeRange(via.range) || range;
    for (const nodePath of nodes) {
      findings.push({
        advisory: advisoryIdFromViaEntry(via, name || packageName),
        package: name,
        path: normalizeDependencyPath(nodePath, name || packageName),
        severity: advisorySeverity,
        range: advisoryRange,
      });
    }
  }

  if (findings.length > 0) return dedupeFindings(findings);
  if (!BLOCKING_SEVERITIES.has(severity)) return [];
  return dedupeFindings(
    nodes.map((nodePath) => ({
      advisory: advisoryIdFromViaEntry(null, name || packageName),
      package: name,
      path: normalizeDependencyPath(nodePath, name || packageName),
      severity,
      range,
    }))
  );
}

export function extractBlockingFindings(report) {
  const vulnerabilities = report?.vulnerabilities || {};
  const findings = [];
  for (const item of Object.values(vulnerabilities)) {
    if (!BLOCKING_SEVERITIES.has(normalizeSeverity(item?.severity)) || !normalizePackageName(item?.name)) continue;
    findings.push(
      ...collectAdvisoryFindings(normalizePackageName(item.name), vulnerabilities, normalizeSeverity(item.severity))
    );
  }
  return dedupeFindings(findings).sort((a, b) =>
    buildFindingKey(a).localeCompare(buildFindingKey(b), 'en', { sensitivity: 'base' })
  );
}

export function normalizeAllowlist(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  const normalizedEntries = [];
  const map = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const normalized = {
      advisory: typeof entry.advisory === 'string' ? entry.advisory.trim().toUpperCase() : '',
      package: normalizePackageName(entry.package),
      path: typeof entry.path === 'string' ? entry.path.trim() : '',
      severity: normalizeSeverity(entry.severity),
      range: normalizeRange(entry.range),
      allowedUntil: typeof entry.allowedUntil === 'string' ? entry.allowedUntil.trim() : '',
      owner: typeof entry.owner === 'string' ? entry.owner.trim() : '',
      reason: typeof entry.reason === 'string' ? entry.reason.trim() : '',
    };
    if (
      !normalized.advisory ||
      !normalized.package ||
      !normalized.path ||
      !normalized.severity ||
      !normalized.range ||
      !normalized.allowedUntil
    ) {
      continue;
    }
    map.set(buildFindingKey(normalized), normalized);
    normalizedEntries.push(normalized);
  }
  return { entries: normalizedEntries, map };
}

function loadAllowlist(allowlistPath) {
  if (!fs.existsSync(allowlistPath)) return normalizeAllowlist({ entries: [] });
  return normalizeAllowlist(JSON.parse(fs.readFileSync(allowlistPath, 'utf8')));
}

export function evaluateSecurityPolicy(report, allowlistData, now = new Date()) {
  const invalidDateEntries = allowlistData.entries.filter((entry) => !parseDateOrNull(entry.allowedUntil));
  const expiredAllowlistEntries = allowlistData.entries.filter((entry) => {
    const expiry = parseDateOrNull(entry.allowedUntil);
    return Boolean(expiry && expiry < now);
  });
  const blocking = [];
  const allowlisted = [];
  const usedAllowlistKeys = new Set();

  for (const item of extractBlockingFindings(report)) {
    const key = buildFindingKey(item);
    const allowed = allowlistData.map.get(key);
    if (!allowed) {
      blocking.push(item);
      continue;
    }
    usedAllowlistKeys.add(key);
    allowlisted.push({ finding: item, allowlist: allowed });
  }

  return {
    passed: invalidDateEntries.length === 0 && expiredAllowlistEntries.length === 0 && blocking.length === 0,
    invalidDateEntries,
    expiredAllowlistEntries,
    blocking,
    allowlisted,
    staleEntries: allowlistData.entries.filter((entry) => !usedAllowlistKeys.has(buildFindingKey(entry))),
  };
}

function isoDateInDays(daysFromNow) {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

function reportPolicyResult(result, logger) {
  if (result.invalidDateEntries.length > 0) {
    logger.error('Security audit gate failed: allowlist contains invalid allowedUntil date values.');
    for (const entry of result.invalidDateEntries) {
      logger.error(
        `- ${entry.advisory} ${entry.package} [${entry.severity}] path="${entry.path}" range="${entry.range}" allowedUntil="${entry.allowedUntil}"`
      );
    }
  }
  if (result.expiredAllowlistEntries.length > 0) {
    logger.error('Security audit gate failed: allowlist contains expired entries.');
    for (const entry of result.expiredAllowlistEntries) {
      logger.error(
        `- ${entry.advisory} ${entry.package} [${entry.severity}] path="${entry.path}" range="${entry.range}" expiredOn="${entry.allowedUntil}"`
      );
    }
  }
  if (result.blocking.length > 0) {
    logger.error('Security audit gate failed (production dependencies).');
    for (const item of result.blocking) {
      logger.error(`- ${item.advisory} ${item.package} [${item.severity}] path="${item.path}" range="${item.range}"`);
      logger.error(
        `- ${JSON.stringify({ ...item, allowedUntil: isoDateInDays(45), owner: 'team', reason: 'temporary exception with tracked remediation' })}`
      );
    }
  }
  for (const item of result.allowlisted) {
    logger.log(
      `Allowlisted: ${item.finding.advisory} ${item.finding.package} [${item.finding.severity}] path="${item.finding.path}" range="${item.finding.range}" until=${item.allowlist.allowedUntil} owner=${item.allowlist.owner || 'n/a'} reason="${item.allowlist.reason || 'allowlisted (no reason provided)'}"`
    );
  }
  if (result.staleEntries.length > 0) {
    logger.warn(`Unused allowlist entries detected: ${result.staleEntries.length}`);
    for (const entry of result.staleEntries) {
      logger.warn(
        `- ${entry.advisory} ${entry.package} [${entry.severity}] path="${entry.path}" range="${entry.range}" until=${entry.allowedUntil}`
      );
    }
  }
}

export function applySecurityAuditPolicy({
  report,
  allowlist = normalizeAllowlist({ entries: [] }),
  updateBaseline = false,
  writeBaseline = () => {},
  now = new Date(),
  logger = { log: console.log, warn: console.warn, error: console.error },
}) {
  const result = evaluateSecurityPolicy(report, allowlist, now);
  reportPolicyResult(result, logger);
  if (!result.passed) throw new Error('Security audit policy rejected the current production dependency report.');
  if (updateBaseline) writeBaseline({ generatedAt: now.toISOString(), report });
  logger.log('Security audit gate passed: no unallowlisted high/critical vulnerabilities in production dependencies.');
  return result;
}

function runNpmAudit() {
  const npmExecPath = typeof process.env.npm_execpath === 'string' ? process.env.npm_execpath.trim() : '';
  const command = npmExecPath ? process.execPath : npmCommand;
  const args = npmExecPath ? [npmExecPath, ...npmArgs] : npmArgs;
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const rawOutput = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (!rawOutput) throw new Error('npm audit returned no output.');
  return parseAuditReport(rawOutput);
}

export function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== '--update-baseline');
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const updateBaseline = argv.includes('--update-baseline');
  const report = runNpmAudit();
  const allowlist = loadAllowlist(defaultAllowlistPath);
  return applySecurityAuditPolicy({
    report,
    allowlist,
    updateBaseline,
    writeBaseline(payload) {
      fs.mkdirSync(path.dirname(defaultBaselinePath), { recursive: true });
      fs.writeFileSync(defaultBaselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      console.log(`Security audit baseline updated: ${path.relative(repoRoot, defaultBaselinePath)}`);
    },
  });
}

const isDirectExecution =
  typeof process.argv[1] === 'string' && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
