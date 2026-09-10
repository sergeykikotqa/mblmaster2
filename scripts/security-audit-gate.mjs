import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = ['audit', '--omit=dev', '--json'];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const allowlistPath = path.resolve(scriptDir, 'security-audit-allowlist.json');
const baselinePath = path.resolve(repoRoot, 'artifacts', 'security-audit-baseline.json');
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

function extractJsonPayload(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

function parseAuditReport(raw) {
  const payload = extractJsonPayload(raw);
  if (!payload) {
    throw new Error('Unable to locate JSON payload in npm audit output.');
  }
  return JSON.parse(payload);
}

function parseDateOrNull(rawDate) {
  if (typeof rawDate !== 'string' || !rawDate.trim()) return null;
  const parsed = new Date(`${rawDate.trim()}T23:59:59.999Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function normalizeSeverity(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function normalizeRange(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizePackageName(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeDependencyPath(nodePath, fallbackPackage) {
  const fallback = normalizePackageName(fallbackPackage);
  if (typeof nodePath !== 'string' || !nodePath.trim()) return fallback;

  const parts = nodePath
    .split('node_modules/')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (parts.length === 0) return fallback;
  return parts.join(' > ');
}

function advisoryIdFromViaEntry(entry, fallbackPackage) {
  if (entry && typeof entry.url === 'string') {
    const ghsaMatch = entry.url.match(/GHSA-[a-z0-9-]+/i);
    if (ghsaMatch) return ghsaMatch[0].toUpperCase();
  }

  const sourceId =
    entry && typeof entry.source !== 'undefined' && entry.source !== null ? String(entry.source).trim() : '';
  if (sourceId) return `NPM-${sourceId}`;

  const fallback = normalizePackageName(fallbackPackage)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-');
  return `NPM-META-${fallback || 'UNKNOWN'}`;
}

function buildFindingKey(entry) {
  return [entry.advisory, entry.package, entry.path, entry.severity, entry.range].join('|');
}

function dedupeFindings(findings) {
  const deduped = [];
  const seen = new Set();

  for (const finding of findings) {
    const key = buildFindingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }

  return deduped;
}

function collectAdvisoryFindings(packageName, vulnerabilities, rootSeverity, stack = new Set()) {
  const vulnerability = vulnerabilities[packageName];
  if (!vulnerability || typeof vulnerability !== 'object') return [];
  if (stack.has(packageName)) return [];

  const nextStack = new Set(stack);
  nextStack.add(packageName);

  const vulnerabilityName = normalizePackageName(vulnerability.name || packageName);
  const vulnerabilitySeverity = normalizeSeverity(vulnerability.severity) || rootSeverity;
  const vulnerabilityRange = normalizeRange(vulnerability.range);
  const nodes =
    Array.isArray(vulnerability.nodes) && vulnerability.nodes.length > 0
      ? vulnerability.nodes
      : [vulnerabilityName || packageName];

  const viaEntries = Array.isArray(vulnerability.via) ? vulnerability.via : [];
  const findings = [];

  for (const viaEntry of viaEntries) {
    if (typeof viaEntry === 'string') {
      const nested = collectAdvisoryFindings(viaEntry, vulnerabilities, vulnerabilitySeverity, nextStack);
      findings.push(...nested);
      continue;
    }

    if (!viaEntry || typeof viaEntry !== 'object') continue;

    const advisorySeverity = normalizeSeverity(viaEntry.severity) || vulnerabilitySeverity;
    if (!BLOCKING_SEVERITIES.has(advisorySeverity)) continue;

    const advisoryRange = normalizeRange(viaEntry.range) || vulnerabilityRange;
    const advisoryId = advisoryIdFromViaEntry(viaEntry, vulnerabilityName || packageName);

    for (const nodePath of nodes) {
      findings.push({
        advisory: advisoryId,
        package: vulnerabilityName,
        path: normalizeDependencyPath(nodePath, vulnerabilityName || packageName),
        severity: advisorySeverity,
        range: advisoryRange,
      });
    }
  }

  if (findings.length > 0) {
    return dedupeFindings(findings);
  }

  if (!BLOCKING_SEVERITIES.has(vulnerabilitySeverity)) {
    return [];
  }

  const metaAdvisory = advisoryIdFromViaEntry(null, vulnerabilityName || packageName);
  const fallbackFindings = nodes.map((nodePath) => ({
    advisory: metaAdvisory,
    package: vulnerabilityName,
    path: normalizeDependencyPath(nodePath, vulnerabilityName || packageName),
    severity: vulnerabilitySeverity,
    range: vulnerabilityRange,
  }));

  return dedupeFindings(fallbackFindings);
}

function extractBlockingFindings(report) {
  const vulnerabilities = report?.vulnerabilities || {};
  const vulnerabilityItems = Object.values(vulnerabilities).filter(
    (item) => BLOCKING_SEVERITIES.has(normalizeSeverity(item?.severity)) && normalizePackageName(item?.name)
  );

  const findings = [];
  for (const item of vulnerabilityItems) {
    const packageName = normalizePackageName(item.name);
    const rootSeverity = normalizeSeverity(item.severity);
    const advisoryFindings = collectAdvisoryFindings(packageName, vulnerabilities, rootSeverity);
    findings.push(...advisoryFindings);
  }

  return dedupeFindings(findings).sort((a, b) =>
    buildFindingKey(a).localeCompare(buildFindingKey(b), 'en', { sensitivity: 'base' })
  );
}

function loadAllowlist() {
  if (!fs.existsSync(allowlistPath)) {
    return {
      entries: [],
      map: new Map(),
    };
  }

  const raw = fs.readFileSync(allowlistPath, 'utf8');
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];

  const map = new Map();
  const normalizedEntries = [];

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

    const key = buildFindingKey(normalized);
    map.set(key, normalized);
    normalizedEntries.push(normalized);
  }

  return {
    entries: normalizedEntries,
    map,
  };
}

function isoDateInDays(daysFromNow) {
  const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

const result = spawnSync(npmCommand, args, {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const rawOutput = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
if (!rawOutput) {
  console.error('npm audit returned no output.');
  process.exit(1);
}

let report;
try {
  report = parseAuditReport(rawOutput);
} catch (error) {
  console.error('Failed to parse npm audit output.');
  console.error(error);
  process.exit(1);
}

try {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  const baselinePayload = {
    generatedAt: new Date().toISOString(),
    report,
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baselinePayload, null, 2)}\n`, 'utf8');
} catch (error) {
  console.warn('Failed to write security audit baseline.');
  console.warn(error);
}

const highOrCriticalFindings = extractBlockingFindings(report);
const { entries: allowlistEntries, map: allowlist } = loadAllowlist();

const now = new Date();
const invalidDateEntries = allowlistEntries.filter((entry) => !parseDateOrNull(entry.allowedUntil));
if (invalidDateEntries.length > 0) {
  console.error('Security audit gate failed: allowlist contains invalid allowedUntil date values.');
  for (const entry of invalidDateEntries) {
    console.error(
      `- ${entry.advisory} ${entry.package} [${entry.severity}] path="${entry.path}" range="${entry.range}" allowedUntil="${entry.allowedUntil}"`
    );
  }
  process.exit(1);
}

const expiredAllowlistEntries = allowlistEntries.filter((entry) => {
  const expiryDate = parseDateOrNull(entry.allowedUntil);
  return Boolean(expiryDate && expiryDate < now);
});
if (expiredAllowlistEntries.length > 0) {
  console.error('Security audit gate failed: allowlist contains expired entries.');
  for (const entry of expiredAllowlistEntries) {
    console.error(
      `- ${entry.advisory} ${entry.package} [${entry.severity}] path="${entry.path}" range="${entry.range}" expiredOn="${entry.allowedUntil}"`
    );
  }
  process.exit(1);
}

const blocking = [];
const allowlisted = [];
const usedAllowlistKeys = new Set();

for (const item of highOrCriticalFindings) {
  const key = buildFindingKey(item);
  const allowed = allowlist.get(key);
  if (!allowed) {
    blocking.push(item);
    continue;
  }

  const expiresAt = parseDateOrNull(allowed.allowedUntil);
  if (expiresAt && expiresAt < now) {
    blocking.push({
      ...item,
      _allowlistExpired: true,
      _allowlistUntil: allowed.allowedUntil,
    });
    continue;
  }

  usedAllowlistKeys.add(key);
  allowlisted.push({
    ...item,
    _allowlistReason: allowed.reason || 'allowlisted (no reason provided)',
    _allowlistUntil: allowed.allowedUntil || 'n/a',
    _allowlistOwner: allowed.owner || 'n/a',
  });
}

if (blocking.length > 0) {
  console.error('Security audit gate failed (production dependencies).');
  for (const item of blocking) {
    const details = `${item.advisory} ${item.package} [${item.severity}] path="${item.path}" range="${item.range}"`;
    if (item._allowlistExpired) {
      console.error(`- ${details} (allowlist expired on ${item._allowlistUntil})`);
      continue;
    }
    console.error(`- ${details}`);
  }

  console.error('\nAllowlist entry template (strict match):');
  for (const item of blocking) {
    const template = {
      advisory: item.advisory,
      package: item.package,
      path: item.path,
      severity: item.severity,
      range: item.range,
      allowedUntil: isoDateInDays(45),
      owner: 'team',
      reason: 'temporary exception with tracked remediation',
    };
    console.error(`- ${JSON.stringify(template)}`);
  }
  process.exit(1);
}

if (allowlisted.length > 0) {
  console.log('Allowlisted vulnerabilities (strict advisory/path/range/severity match):');
  for (const item of allowlisted) {
    console.log(
      `- ${item.advisory} ${item.package} [${item.severity}] path="${item.path}" range="${item.range}" until=${item._allowlistUntil} owner=${item._allowlistOwner} reason="${item._allowlistReason}"`
    );
  }
}

const staleEntries = allowlistEntries.filter((entry) => !usedAllowlistKeys.has(buildFindingKey(entry)));
if (staleEntries.length > 0) {
  console.warn(`Unused allowlist entries detected: ${staleEntries.length}`);
  for (const entry of staleEntries) {
    console.warn(
      `- ${entry.advisory} ${entry.package} [${entry.severity}] path="${entry.path}" range="${entry.range}" until=${entry.allowedUntil}`
    );
  }
}

console.log('Security audit gate passed: no unallowlisted high/critical vulnerabilities in production dependencies.');
