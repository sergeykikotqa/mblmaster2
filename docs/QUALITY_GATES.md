# Quality Gates

For the full 28-question release audit flow and the dated verdict format, use `docs/release-audit-playbook.md`.
For the 42-question pre-launch audit flow, use `docs/pre-launch-audit-playbook.md`.

## PR Baseline

Use this command set for pull requests and local pre-push checks:

```powershell
npm run check
npm run typecheck
npm test
$env:PUBLIC_SITE_URL='https://example.com'; npm run build
npm run check:e2e:smoke
npm run check:accessibility
npm run check:seo:smoke
npm run check:lighthouse:smoke
```

Notes:

- `npm run check` is the blocking PR baseline and includes `check:astro`, `check:eslint`, `check:nap-consistency`, and `check:privacy-disclosure`.
- `npm test` creates and removes an isolated production build with a synthetic
  `.invalid` origin. HTML-dependent tests never read the repository's existing
  `dist`; a failed or incomplete build stops the suite before Vitest starts.
- `npm run check:prettier` stays available as a separate style cleanup task until the legacy formatting backlog is reduced.
- Keep `PUBLIC_SITE_URL` explicit in any environment that runs `npm run build`, including CI.

## Redis Integration Gate

`npm test` stays hermetic and skips the native Redis integration suite. Run
`npm run check:redis-integration` as a separate named gate with an explicit,
isolated loopback `REDIS_URL` selecting database `/1` through `/15`. A missing
or unsafe URL is a gate failure, never a skipped PASS. The working-branch and
full-audit CI jobs use `/14` for this gate and keep the metrics state-store
smoke isolated on `/15`.

## Nightly / Full Audit Baseline

Use this command set for main-branch or scheduled full audits:

```powershell
npm run check:architecture
npm run check:generated-pages-sync
npm run check:slugs
npm run check:no-district-left
npm run check:secrets-scope
npm run check
npm run typecheck
npm test
$env:REDIS_URL='redis://127.0.0.1:6379/14'; npm run check:redis-integration
npm run check:external-monitor
npm run check:telegram-monitor
npm run check:image-policy
$env:PUBLIC_SITE_URL='https://example.com'; npm run build
npm run check:performance-budgets
npm run check:redirects-sitemap
npm run check:no-admin-in-sitemap
npm run check:no-legacy-index
npm run check:indexability-runtime-consistency
npm run check:indexable-link-coverage
npm run check:admin-token-storage
npm run check:contact-hidden-fields
npm run check:metrics-smoke
npm run check:metrics-health-smoke
npm run check:metrics-health-state-store
npm run check:metrics-health-fallback
npm run check:metrics-health-fallback-alert
npm run check:lead-api
npm run check:redis-outage
npm run check:webhook-delivery
npm run check:accessibility:full
npm run check:e2e
npm run check:mobile-audit
npm run check:seo
npm run check:lighthouse
npm run check:audit
```

## Playwright suite ownership

`tests/e2e/*.spec.ts` is split by required environment, and every spec belongs to exactly one
suite declared in `playwright.suites.ts`.

| Suite          | Config                       | Environment    | npm gate                                          |
| -------------- | ---------------------------- | -------------- | ------------------------------------------------- |
| Functional     | `playwright.config.ts`       | `PUBLIC_E2E=1` | `check:e2e`, `check:e2e:smoke`                    |
| Accessibility  | `playwright.a11y.config.ts`  | `PUBLIC_E2E=0` | `check:accessibility`, `check:accessibility:full` |
| SEO / artifact | `playwright.audit.config.ts` | `PUBLIC_E2E=1` | `check:seo:smoke`, `check:mobile-audit`           |

`check:e2e` runs the functional suite only. The accessibility suite is deliberately not
reused there: `a11y-all` and `a11y-smoke` assert that `html` has no `data-e2e="true"`
attribute, which only holds when `PUBLIC_E2E=0`, so running them under the functional
environment fails on configuration rather than on product behaviour.

`check:accessibility:full` intentionally passes no file arguments, so newly owned
accessibility specs (for example `smartcaptcha-a11y.spec.ts` and
`project-modal-focus.spec.ts`) are covered automatically instead of being pinned to a
hardcoded subset.

`check:seo:smoke` regenerates `artifacts/smoke-manifest.json` in the same command before
launching the browser, so the SEO browser gate cannot pass on a stale manifest.
`check:mobile-audit` owns `mobile-adaptation-audit.spec.ts`, which needs a fresh
`npm run build` (`dist/` plus `sitemap.xml`).

`tests/playwright-config.test.ts` enforces the ownership contract: every spec on disk must
resolve to exactly one owner, specialized suites must stay out of the functional gate, and
adding a spec without declaring an owner fails the test and the Playwright config load.
It also verifies that gate scripts such as `check-compose-runtime.mjs` and
`audit-pre-launch.mjs` invoke each spec through its owning config.

Current suite sizes (`playwright test --list`): functional 58 tests in 11 files,
accessibility 153 tests in 5 files, SEO and artifact audits 5 tests in 2 files.

`check:performance-budgets` separates three client-JavaScript constraints: a strict 15 KB gzip initial
payload per public HTML page, a conservative 30 KB gzip per-route runtime graph including local scripts
loaded dynamically, and a 36 KB gzip repository-wide cap across all non-admin assets. The repository cap
is intentionally only about 1 KB above the measured 35 KB post-cleanup baseline, so route splitting cannot
hide aggregate growth. Failures print the largest assets and the heaviest initial/runtime routes.

`npm run check:audit` is a read-only production dependency security gate. It
runs the current audit and applies the strict, expiring allowlist without
changing tracked repository files. To deliberately refresh the tracked audit
snapshot after a successful policy verdict, run
`npm run audit:security:update-baseline`. The baseline is evidence only: it is
not an allowlist and does not permit any vulnerability.

## CI Policy

- PR workflows should stay fast and deterministic.
- Full visual, SEO, accessibility, runtime, and security-heavy audits belong in nightly or `main` workflows.
- Do not duplicate `npm run lint` in workflows that already run `npm run check`.
- GitHub must not hold production monitoring/Telegram credentials or invoke production worker APIs.
- `npm run check:dev-runtime` is a development-server smoke only. Its result is
  reported as `DEV_SMOKE_PASS` and must never be used as production evidence.
- Run `npm run check:prod-runtime` on a trusted release host with Docker. It
  executes the built-image, Redis-backed Compose gate and is the only local
  result reported as `PRODUCTION_RUNTIME_PASS`.
- Run `npm run check:deployed-runtime` only from the authorised
  release/monitoring perimeter with an explicit target URL. Production runtime
  and deployed checks are not GitHub workflow jobs.
