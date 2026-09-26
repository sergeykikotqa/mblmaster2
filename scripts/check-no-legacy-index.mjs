import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REDIRECTS_PATH = path.join(ROOT, '_redirects');

const REQUIRED_REDIRECT_RULES = [
  '/kuhni-na-zakaz /kuhni 301!',
  '/shkafy-kupe /shkafy 301!',
  '/vstroennye-shkafy /shkafy 301!',
  '/irkutsk/kuhni /kuhni 301!',
  '/irkutsk/shkafy /shkafy 301!',
  '/irkutsk/garderobnye /garderobnye 301!',
  '/kuhni/irkutsk /kuhni 301!',
  '/shkafy/irkutsk /shkafy 301!',
  '/garderobnye/irkutsk /garderobnye 301!',
  '/raiony /410 410',
  '/raiony/* /410 410',
];

const FORBIDDEN_REDIRECT_PATTERNS = [
  /^\/(irkutsk|angarsk|shelekhov|shelehov)\/\*\s+/i,
  /^\/(irkutsk|angarsk|shelekhov|shelehov)\/(kuhni|shkafy|garderobnye)\/:[a-z0-9_-]+\s+/i,
  /^\/(kuhni|shkafy|garderobnye)\/(irkutsk|angarsk|shelekhov|shelehov)\/:[a-z0-9_-]+\s+/i,
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readUtf8(filePath) {
  assert(fs.existsSync(filePath), `File is missing: ${path.relative(ROOT, filePath)}`);
  return fs.readFileSync(filePath, 'utf8');
}

function getRedirectLines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function checkRedirects() {
  const redirects = readUtf8(REDIRECTS_PATH);
  const redirectLines = getRedirectLines(redirects);
  const missing = REQUIRED_REDIRECT_RULES.filter((rule) => !redirectLines.includes(rule));
  const forbidden = redirectLines.filter((line) => FORBIDDEN_REDIRECT_PATTERNS.some((pattern) => pattern.test(line)));

  assert(
    missing.length === 0,
    `Required geo redirect rules are missing in _redirects:\n${missing.map((item) => `- ${item}`).join('\n')}`
  );

  assert(
    forbidden.length === 0,
    `Strict redirect matrix violated: wildcard geo rules are not allowed.\n${forbidden.map((item) => `- ${item}`).join('\n')}`
  );
}

function main() {
  checkRedirects();
  console.log(
    'Redirect matrix guard passed: explicit geo service rules are present and wildcard geo rules are absent.'
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
