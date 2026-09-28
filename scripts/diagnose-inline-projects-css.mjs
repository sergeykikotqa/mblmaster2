/**
 * DIAGNOSTIC ONLY — mutates build output, never source.
 *
 * A/B experiment: does the separate render-blocking network request for the
 * /projects-specific compiled CSS materially affect simulated FCP/LCP?
 *
 * The CSS bytes are preserved exactly as the production build emitted them. This
 * only removes one network round trip; it does not change a single declaration,
 * does not reorder rules, and leaves the global PageLayout bundle external.
 *
 * Identification of the route bundle is deterministic and not guesswork: Astro
 * emits a stylesheet linked from exactly one page for a route-scoped import, so
 * the /projects bundle is the one referenced by dist/projects/index.html and by
 * no other built page. Counting selector occurrences is not used, because the
 * global bundle also defines some .projects-* rules and would be ambiguous.
 *
 * Usage:
 *   node scripts/diagnose-inline-projects-css.mjs [dist/projects/index.html]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TARGET_HTML = path.resolve(ROOT, process.argv[2] || 'dist/projects/index.html');
const DIST_DIR = path.resolve(ROOT, 'dist');
const MANIFEST = path.join(path.dirname(TARGET_HTML), 'inline-projects-css-manifest.json');
// Pristine snapshot of the page before the substitution, so equivalence can be
// proven by reverse-substitution byte-equality. Kept outside dist/ so it can
// never be served as a page by the static server.
const PRISTINE_COPY = path.join(ROOT, '.tmp', 'diagnostic-inline-projects-css', 'pristine.html.txt');

// Sanity markers that the candidate really is the projects route CSS.
const PROJECT_SELECTORS = ['.projects-filters', '.projects-price'];

function listHtmlFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
    }
  }
  return out;
}

function stylesheetLinks(html) {
  return [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map((m) => m[0]);
}

function hrefOf(tag) {
  const m = tag.match(/\bhref="([^"]+)"/);
  return m ? m[1] : null;
}

/** Counts how many built pages reference a given href. */
function referenceCount(href, targetHtmlPath) {
  let count = 0;
  for (const file of listHtmlFiles(DIST_DIR)) {
    const html = fs.readFileSync(file, 'utf8');
    if (!html.includes(href)) continue;
    // A page linking it more than once still counts as one referencing page.
    count += 1;
    if (path.resolve(file) === targetHtmlPath) continue;
  }
  return count;
}

function main() {
  if (!fs.existsSync(TARGET_HTML)) {
    throw new Error(`target HTML not found: ${TARGET_HTML} (run the production build first)`);
  }

  const html = fs.readFileSync(TARGET_HTML, 'utf8');
  const links = stylesheetLinks(html);
  const before = links.length;

  if (html.includes('data-diagnostic-inline-projects-css')) {
    throw new Error('target already inlined; rebuild before re-running this helper');
  }

  // Candidate = linked here, and referenced by no other built page.
  const candidates = [];
  for (const tag of links) {
    const href = hrefOf(tag);
    if (!href) continue;
    const assetPath = path.join(DIST_DIR, href.replace(/^\//, ''));
    if (!fs.existsSync(assetPath)) continue;
    const refs = referenceCount(href, TARGET_HTML);
    if (refs === 1) candidates.push({ tag, href, assetPath, refs });
  }

  if (candidates.length !== 1) {
    const detail = links
      .map((tag) => {
        const href = hrefOf(tag);
        const assetPath = href ? path.join(DIST_DIR, href.replace(/^\//, '')) : null;
        return `    ${href}  refs=${href ? referenceCount(href, TARGET_HTML) : '?'}  exists=${
          assetPath ? fs.existsSync(assetPath) : false
        }`;
      })
      .join('\n');
    throw new Error(
      `expected exactly one /projects-specific stylesheet, found ${candidates.length}. ` +
        `Stylesheets in this page:\n${detail}`
    );
  }

  const [target] = candidates;
  const css = fs.readFileSync(target.assetPath, 'utf8');

  const missingSelectors = PROJECT_SELECTORS.filter((selector) => !css.includes(selector));
  if (missingSelectors.length) {
    throw new Error(
      `candidate ${target.href} does not contain expected project selectors: ${missingSelectors.join(', ')}`
    );
  }
  if (/<\/style/i.test(css)) {
    throw new Error('candidate CSS contains a closing style tag; refusing to inline');
  }

  const inlineTag = `<style data-diagnostic-inline-projects-css>${css}</style>`;
  const inlined = html.replace(target.tag, inlineTag);
  if (inlined === html) throw new Error('stylesheet tag was not replaced');

  fs.mkdirSync(path.dirname(PRISTINE_COPY), { recursive: true });
  fs.writeFileSync(PRISTINE_COPY, html, 'utf8');
  fs.writeFileSync(TARGET_HTML, inlined, 'utf8');

  // Verify the result rather than trusting the substitution.
  const after = stylesheetLinks(inlined);
  const manifest = {
    diagnostic: 'inline-projects-css',
    generatedAt: new Date().toISOString(),
    target: path.relative(ROOT, TARGET_HTML).replace(/\\/g, '/'),
    originalHref: target.href,
    originalLinkTag: target.tag,
    pristineCopy: path.relative(ROOT, PRISTINE_COPY).replace(/\\/g, '/'),
    cssBytes: Buffer.byteLength(css, 'utf8'),
    stylesheetsBefore: before,
    stylesheetsAfter: after.length,
    remainingStylesheets: after.map(hrefOf),
    pageLayoutStillExternal: after.some((tag) => {
      const href = hrefOf(tag);
      return href ? /PageLayout/i.test(href) : false;
    }),
    inlinedSelectorCounts: Object.fromEntries(
      PROJECT_SELECTORS.map((selector) => [selector, (css.match(new RegExp(`\\${selector}`, 'g')) || []).length])
    ),
    cssContentPreserved: fs.readFileSync(target.assetPath, 'utf8') === css,
    otherLinksUntouched:
      after.filter((tag) => hrefOf(tag) === target.href).length === 0 &&
      links.filter((tag) => hrefOf(tag) !== target.href).length === after.length,
  };

  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[inline-css] original href            = ${manifest.originalHref}`);
  console.log(`[inline-css] css bytes                = ${manifest.cssBytes}`);
  console.log(`[inline-css] stylesheets before/after = ${before} -> ${after.length}`);
  console.log(`[inline-css] PageLayout still external= ${manifest.pageLayoutStillExternal}`);
  console.log(`[inline-css] remaining stylesheets    = ${manifest.remainingStylesheets.join(', ')}`);
  console.log(`[inline-css] manifest                 = ${path.relative(ROOT, MANIFEST).replace(/\\/g, '/')}`);
}

try {
  main();
} catch (error) {
  console.error(`[inline-css] BLOCKED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
