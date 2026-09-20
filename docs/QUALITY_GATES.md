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
- `npm run check:prettier` stays available as a separate style cleanup task until the legacy formatting backlog is reduced.
- Keep `PUBLIC_SITE_URL` explicit in any environment that runs `npm run build`, including CI.

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
npm run check:seo
npm run check:lighthouse
npm run check:audit
```

## CI Policy

- PR workflows should stay fast and deterministic.
- Full visual, SEO, accessibility, runtime, and security-heavy audits belong in nightly or `main` workflows.
- Do not duplicate `npm run lint` in workflows that already run `npm run check`.
- GitHub must not hold production monitoring/Telegram credentials or invoke production worker APIs.
- Run `npm run check:prod-runtime` on a trusted release host and
  `npm run check:deployed-runtime` only from the authorised release/monitoring
  perimeter with an explicit target URL. They are not GitHub workflow jobs.
