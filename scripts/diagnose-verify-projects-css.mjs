/**
 * DIAGNOSTIC ONLY — read-only verification, never mutates anything.
 *
 * Deterministic replacement for the shell A-F checks that failed in CI run
 * 36375010968. The shell version parsed minified HTML with `grep -o ... | head -1`
 * under `set -euo pipefail`, which is broken twice over: `-o`/`-m`/`head` have
 * different matching semantics, and a downstream `head` exit can SIGPIPE grep and
 * abort the job. None of that has a place in HTML verification, so every check
 * here goes through the DOM/strings in Node with no pipeline semantics at all.
 *
 * Checks, each fatal with its own message:
 *   A  the /projects route stylesheet is no longer linked
 *   B  exactly one inline style block, byte-for-byte equal to the compiled route CSS
 *   C  the global PageLayout stylesheet is still external
 *   D  apply-color-mode.js is present, as in the pristine build
 *   E  the first project-card image is still loading=eager + fetchpriority=high
 *   F  apart from the intended link -> style substitution, the page is unchanged
 *
 * Usage:
 *   node scripts/diagnose-verify-projects-css.mjs [dist/projects/index.html]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TARGET_HTML = path.resolve(ROOT, process.argv[2] || 'dist/projects/index.html');
const MANIFEST = path.join(path.dirname(TARGET_HTML), 'inline-projects-css-manifest.json');
const INLINE_MARKER = 'data-diagnostic-inline-projects-css';

const failures = [];
const results = [];

function check(id, description, fn) {
  try {
    const detail = fn();
    results.push({ id, description, status: 'PASS', detail: detail ?? '' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ id, message });
    results.push({ id, description, status: 'FAIL', detail: message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stylesheetLinks(html) {
  return [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map((m) => m[0]);
}

function hrefOf(tag) {
  const m = tag.match(/\bhref="([^"]+)"/);
  return m ? m[1] : null;
}

function main() {
  assert(fs.existsSync(TARGET_HTML), `target HTML not found: ${TARGET_HTML}`);
  assert(fs.existsSync(MANIFEST), `manifest not found: ${MANIFEST} (run diagnose-inline-projects-css.mjs first)`);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const html = fs.readFileSync(TARGET_HTML, 'utf8');
  const links = stylesheetLinks(html);
  const routeCssPath = path.join(ROOT, 'dist', manifest.originalHref.replace(/^\//, ''));
  assert(fs.existsSync(routeCssPath), `compiled route CSS not found: ${manifest.originalHref}`);

  check('A', 'projects route stylesheet is no longer linked', () => {
    const stillLinked = links.filter((tag) => hrefOf(tag) === manifest.originalHref);
    assert(
      stillLinked.length === 0,
      `route stylesheet still linked ${stillLinked.length} time(s): ${manifest.originalHref}`
    );
    return `link absent (${manifest.originalHref}), stylesheets now: ${links.map(hrefOf).join(', ')}`;
  });

  check('B', 'exactly one inline style block equal to the compiled route CSS', () => {
    const occurrences = html.split(`<style ${INLINE_MARKER}>`).length - 1;
    assert(occurrences === 1, `expected exactly 1 <style ${INLINE_MARKER}>, found ${occurrences}`);

    const inline = html.match(new RegExp(`<style ${INLINE_MARKER}>([\\s\\S]*?)</style>`));
    assert(inline, 'inline style block could not be parsed');
    const compiled = fs.readFileSync(routeCssPath, 'utf8');
    assert(
      inline[1] === compiled,
      `inline payload differs from compiled CSS: inline ${Buffer.byteLength(inline[1], 'utf8')} bytes vs compiled ${Buffer.byteLength(compiled, 'utf8')} bytes`
    );
    return `${occurrences} block, ${Buffer.byteLength(inline[1], 'utf8')} bytes byte-for-byte equal to ${manifest.originalHref}`;
  });

  check('C', 'global PageLayout stylesheet remains external', () => {
    const external = links.map(hrefOf);
    const global = external.find((href) => href && /PageLayout/i.test(href));
    assert(global, `no external PageLayout stylesheet among: ${external.join(', ')}`);
    assert(!html.includes(`<style ${INLINE_MARKER}>`) || html.indexOf(global) !== -1, 'PageLayout link missing');
    return `external: ${global} (${links.length} stylesheet link(s) total)`;
  });

  check('D', 'apply-color-mode.js present as in the pristine build', () => {
    const tag = html.match(/<script\b[^>]*\bsrc="[^"]*apply-color-mode\.js"[^>]*>/);
    assert(tag, 'apply-color-mode.js script tag not found in the page');
    assert(html.includes('data-apply-color-mode'), 'data-apply-color-mode marker missing');
    return tag[0].slice(0, 120);
  });

  check('E', 'first project-card image is eager + high priority', () => {
    // Identified by project-card context, not by document order: the first
    // <a class="project-link"> card and the <img> inside it.
    const cards = [...html.matchAll(/<a\b[^>]*class="[^"]*\bproject-link\b[^"]*"[^>]*>/g)];
    assert(cards.length > 0, 'no a.project-link cards found');
    const firstCard = cards[0][0];
    const href = hrefOf(firstCard);
    const start = cards[0].index;
    const slice = html.slice(start, start + 3000);
    const img = slice.match(/<img\b[^>]*>/);
    assert(img, `no <img> inside the first project card (${href})`);
    assert(/loading="eager"/.test(img[0]), `first project card image (${href}) is not loading="eager"`);
    assert(/fetchpriority="high"/.test(img[0]), `first project card image (${href}) is not fetchpriority="high"`);
    const eagerCount = (html.match(/loading="eager"/g) || []).length;
    return `${cards.length} cards, first=${href}, eager images in page=${eagerCount}`;
  });

  check('F', 'page otherwise equivalent to the pristine build', () => {
    assert(manifest.pristineCopy, 'manifest has no pristineCopy path');
    const pristinePath = path.resolve(ROOT, manifest.pristineCopy);
    assert(
      fs.existsSync(pristinePath),
      `pristine copy not found: ${manifest.pristineCopy} (run diagnose-inline-projects-css.mjs again)`
    );
    const pristine = fs.readFileSync(pristinePath, 'utf8');

    // Reverse the one intended substitution and require byte equality.
    const inline = html.match(new RegExp(`<style ${INLINE_MARKER}>([\\s\\S]*?)</style>`));
    assert(inline, 'inline style block could not be parsed for reversal');
    const reconstructed = html.replace(inline[0], manifest.originalLinkTag);
    assert(
      reconstructed === pristine,
      `reverse-substitution does not reproduce the pristine build: ${Buffer.byteLength(reconstructed, 'utf8')} vs ${Buffer.byteLength(pristine, 'utf8')} bytes`
    );

    const scriptSrcs = (src) => [...src.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]).join('|');
    assert(scriptSrcs(html) === scriptSrcs(pristine), 'script src set changed relative to the pristine build');
    assert(
      (html.match(/<script\b/g) || []).length === (pristine.match(/<script\b/g) || []).length,
      'script tag count changed relative to the pristine build'
    );
    return `reverse-substitution byte-equal (${Buffer.byteLength(pristine, 'utf8')} bytes), scripts identical`;
  });

  for (const result of results) {
    console.log(`${result.status === 'PASS' ? 'OK  ' : 'FAIL'} ${result.id}. ${result.description}`);
    if (result.detail) console.log(`       ${result.detail}`);
  }

  if (failures.length) {
    console.error('\n[verify-css] FAILED invariants:');
    for (const failure of failures) {
      console.error(`  ${failure.id}: ${failure.message}`);
    }
    process.exit(1);
  }
  console.log(`\n[verify-css] all ${results.length} invariants (A-F) PASS`);
}

try {
  main();
} catch (error) {
  console.error(`[verify-css] BLOCKED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
