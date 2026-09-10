# Pre-release Audit 2026-03-08

Verdict: NO-GO

Scope:

- Workspace audit only, based on repository state in `C:\Users\adida\Desktop\yes`
- Live production/Yandex consoles/CI secret values were not accessible
- Commands executed locally: `npm run build`, `npm run predeploy:seo`, `npm run test:seo`, `npm test`, selected smoke/e2e checks

How to read:

- `✅` verified locally and passes
- `❌` verified locally and fails or required artifact is missing
- `NA` not verifiable from local repo alone; must be closed operationally before release

## Blocking Findings

1. P1: CI release gate is not green as currently written.
   Evidence:
   - `npm run check:metrics-smoke` failed with `401` because [scripts/check-metrics-smoke.mjs](../scripts/check-metrics-smoke.mjs) calls `/api/admin/metrics` without guaranteed token injection, while [.github/workflows/actions.yaml](../.github/workflows/actions.yaml) runs it in `check` with no env for `METRICS_ADMIN_TOKEN`.
   - `npm run check:webhook-delivery` failed with `401` because [scripts/check-webhook-delivery.mjs](../scripts/check-webhook-delivery.mjs) clears `CONTACT_WORKER_TOKEN` and then posts to the worker without auth.
   - `npx playwright test tests/e2e/admin-auth.spec.ts tests/e2e/tracking-funnel.spec.ts` failed in `admin-auth.spec.ts`.
   - `npm run check:redis-outage` failed because the smoke script expects fail-open behavior, but product code is now fail-closed in prod.
     Owner: infra/backend/test. ETA: before release.

2. P1: Geo proof coverage is below the stated threshold.
   Evidence:
   - Only one project case exists, in Irkutsk: [src/content/projects/kuhnya-lermontova.md](../src/content/projects/kuhnya-lermontova.md)
   - No Angarsk/Shelekhov cases were found under `src/content/projects/`
     Owner: content. ETA: before release if local ranking proof is a release gate.

3. P1: NAP is not internally consistent across the site.
   Evidence:
   - Layout/schema uses `ул. Красных Героев, 5`: [src/layouts/Layout.astro](../src/layouts/Layout.astro)
   - Contacts page uses `Иркутск, ул. Красных Героев, 5`: [src/pages/contacts.astro](../src/pages/contacts.astro)
   - Footer uses `Иркутск, ул. Красных Героев, дом 5`: [src/components/widgets/Footer.astro](../src/components/widgets/Footer.astro)
     Owner: frontend/marketing. ETA: before release.

4. P1: Legal/privacy content is incomplete for Yandex.Metrika tracking.
   Evidence:
   - [src/pages/privacy.astro](../src/pages/privacy.astro) mentions personal data but does not mention cookies, analytics, or Yandex.Metrika
   - No terms page was found in `src/pages/`
     Owner: legal/ops. ETA: before release.

5. P1: Security audit gate currently fails on high vulnerabilities.
   Evidence:
   - `npm run check:audit` failed on `minimatch`, `tar`, `rollup`, and `svgo` advisories
     Owner: security/deps. ETA: before release or add explicit, time-boxed allowlist exceptions.

6. P0/P1 operational blockers remain unclosed from local context.
   Evidence:
   - Yandex verification and Metrika are env-gated via [src/components/common/SiteVerification.astro](../src/components/common/SiteVerification.astro) and [src/components/common/YandexMetrika.astro](../src/components/common/YandexMetrika.astro)
   - Current local `dist/index.html` contains neither `yandex-verification` nor `mc.yandex.ru/watch`
   - Yandex.Webmaster ownership/submission cannot be verified from repo
     Owner: ops/marketing. ETA: must be closed before go-live.

7. P1: Release documentation is missing.
   Evidence:
   - No project-level `RELEASE.md` or release checklist found under repo root or `docs/`
   - [README.md](../README.md) is still the generic AstroWind template
     Owner: product/ops. ETA: before release.

## Checklist

| #   | Status | Sev | Owner            | Evidence                                                                                                                                                                                        | Note / ETA                                                                                                      |
| --- | ------ | --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | NA     | P0  | ops              | [.github/workflows/actions.yaml](../.github/workflows/actions.yaml), [scripts/check-yandex-release-env.mjs](../scripts/check-yandex-release-env.mjs)                                            | Workflow expects secrets, but actual CI/prod values were not accessible locally                                 |
| 2   | ✅     | P0  | infra            | [.github/workflows/actions.yaml](../.github/workflows/actions.yaml), [scripts/check-yandex-release-env.mjs](../scripts/check-yandex-release-env.mjs)                                            | Missing required env causes pipeline failure                                                                    |
| 3   | ❌     | P1  | product/ops      | [README.md](../README.md), `docs/` contents                                                                                                                                                     | No project release checklist or owner map found                                                                 |
| 4   | NA     | P1  | ops              | repo only                                                                                                                                                                                       | Staging/prod parity cannot be verified from local repo                                                          |
| 5   | ✅     | P1  | infra/security   | `npm run check:secrets-scope`, [.github/workflows/actions.yaml](../.github/workflows/actions.yaml)                                                                                              | Secrets are scoped after `npm ci`; no job-level env before install                                              |
| 6   | ✅     | P0  | frontend/seo     | `npm run check:canonical-absolute`                                                                                                                                                              | Passed for 32 HTML files                                                                                        |
| 7   | ✅     | P0  | frontend/seo     | `npm run check:canonical-in-sitemap`                                                                                                                                                            | Passed                                                                                                          |
| 8   | ✅     | P1  | frontend/seo     | `npm run check:city-hubs-policy`                                                                                                                                                                | 3 hubs are `noindex,follow` and self-canonical                                                                  |
| 9   | ✅     | P0  | seo/infra        | `npm run check:sitemap-coverage`                                                                                                                                                                | expected=12, actual=12                                                                                          |
| 10  | ✅     | P1  | content          | [src/config/indexability-policy.ts](../src/config/indexability-policy.ts), [data/article-seo-state.json](../data/article-seo-state.json), `npm run check:article-seo-rollout`                   | All articles remain temporary `noindex,follow` (`ready=0`)                                                      |
| 11  | NA     | P0  | ops              | [src/components/common/SiteVerification.astro](../src/components/common/SiteVerification.astro), current `dist/index.html` grep                                                                 | Live production head not accessible locally                                                                     |
| 12  | NA     | P0  | analytics/ops    | [src/components/common/YandexMetrika.astro](../src/components/common/YandexMetrika.astro), current `dist/index.html` grep                                                                       | Live production hit/init not accessible locally                                                                 |
| 13  | ✅     | P2  | seo/ops          | [public/robots.txt](../public/robots.txt)                                                                                                                                                       | `Clean-param` includes `tag` and common UTM params                                                              |
| 14  | ✅     | P0  | seo              | `npm run check:sitemap-coverage`, `npm run check:indexability-runtime-consistency`                                                                                                              | Noindex pages excluded from sitemap                                                                             |
| 15  | ✅     | P1  | frontend/seo     | [src/config/indexability-policy.ts](../src/config/indexability-policy.ts), [src/layouts/Layout.astro](../src/layouts/Layout.astro), [astro.config.ts](../astro.config.ts)                       | Single policy source wired into layout + sitemap                                                                |
| 16  | NA     | P1  | content          | [data/article-seo-state.json](../data/article-seo-state.json)                                                                                                                                   | No indexable articles yet, so nothing to sign off                                                               |
| 17  | ✅     | P1  | content          | `npm run check:no-seo-jargon`                                                                                                                                                                   | Passed                                                                                                          |
| 18  | ❌     | P1  | content          | [src/content/projects/kuhnya-lermontova.md](../src/content/projects/kuhnya-lermontova.md)                                                                                                       | Only 1 Irkutsk case found; no Angarsk/Shelekhov coverage                                                        |
| 19  | ✅     | P1  | content          | `npm run check:content-length`                                                                                                                                                                  | Passed: main>=600, city-block>=200                                                                              |
| 20  | ✅     | P1  | content/seo      | custom dist meta scan, `npm run check:seo`                                                                                                                                                      | No duplicate titles/descriptions in 32 HTML files                                                               |
| 21  | ✅     | P2  | content/frontend | project page dist scan, [src/content/projects/kuhnya-lermontova.md](../src/content/projects/kuhnya-lermontova.md)                                                                               | 4 project images, all with non-empty `alt` in rendered page                                                     |
| 22  | ✅     | P1  | frontend/seo     | `npm run check:orphan-detection`                                                                                                                                                                | Passed                                                                                                          |
| 23  | ✅     | P1  | frontend/seo     | `npm run test:seo`                                                                                                                                                                              | Graph suite had no fail bucket                                                                                  |
| 24  | ✅     | P1  | frontend         | `npm run check:canonical-nav-links`                                                                                                                                                             | Passed; only content-area support links warn to allowed noindex hubs                                            |
| 25  | ✅     | P1  | infra/frontend   | `npm test`, `npm run predeploy:seo`                                                                                                                                                             | Trailing-slash tests pass; canonical policy consistent                                                          |
| 26  | ✅     | P2  | seo/ops          | [public/robots.txt](../public/robots.txt), `npm run test:seo`                                                                                                                                   | Query-param inventory warnings exist, but `tag` is handled via `Clean-param`                                    |
| 27  | NA     | P1  | frontend/perf    | [.lighthouserc.json](../.lighthouserc.json), `npm run check:lighthouse-routes`, local `npm run check:lighthouse`                                                                                | Routes are valid; full LHCI thresholds were not verifiable locally because no Chrome installation was available |
| 28  | ✅     | P2  | frontend/perf    | dist asset scan                                                                                                                                                                                 | External JS footprint is small; inline JS on key pages is ~10-20 KB                                             |
| 29  | ✅     | P2  | frontend         | dist image scan                                                                                                                                                                                 | Money pages render `srcset` and responsive image markup                                                         |
| 30  | ❌     | P1  | frontend/seo     | [src/layouts/Layout.astro](../src/layouts/Layout.astro), [src/pages/contacts.astro](../src/pages/contacts.astro), [src/components/widgets/Footer.astro](../src/components/widgets/Footer.astro) | Single `LocalBusiness` node exists, but NAP text is not exact-match across site                                 |
| 31  | ✅     | P1  | frontend/seo     | `npm run check:schema`, custom JSON-LD scan                                                                                                                                                     | `Service.provider.@id="#localbusiness"` and 3-city `AdministrativeArea` coverage verified                       |
| 32  | ✅     | P1  | frontend/seo     | custom JSON-LD scan of `/irkutsk`, `/angarsk`, `/shelekhov`                                                                                                                                     | City hubs expose LocalBusiness-related types only, no Service/Offer page schema                                 |
| 33  | ✅     | P1  | frontend         | custom JSON-LD scan                                                                                                                                                                             | No page with `LocalBusiness > 1` found in 32 HTML files                                                         |
| 34  | ✅     | P1  | backend          | [src/pages/api/leads.ts](../src/pages/api/leads.ts)                                                                                                                                             | Product code is fail-closed in prod when Redis is absent                                                        |
| 35  | ✅     | P1  | backend/ops      | `npm run check:lead-api`, [tests/worker-fencing.test.ts](../tests/worker-fencing.test.ts), [scripts/dlq-cli.mjs](../scripts/dlq-cli.mjs)                                                        | Idempotency and replay protections exist; `replay-all` requires explicit confirm                                |
| 36  | ✅     | P1  | backend/security | [src/pages/api/leads.ts](../src/pages/api/leads.ts)                                                                                                                                             | Fail-open only for `BOT_PROTECTION_UNAVAILABLE` + alert hook path exists                                        |
| 37  | ✅     | P1  | backend/security | [src/pages/api/leads.ts](../src/pages/api/leads.ts), [src/server/admin/auth.ts](../src/server/admin/auth.ts), [src/server/utils/ip.ts](../src/server/utils/ip.ts)                               | Proxy headers are untrusted by default                                                                          |
| 38  | ✅     | P1  | devlead          | [package.json](../package.json)                                                                                                                                                                 | `predeploy:seo` wrapper exists and passed locally                                                               |
| 39  | ✅     | P1  | devops/test      | [.github/workflows/actions.yaml](../.github/workflows/actions.yaml), [package.json](../package.json)                                                                                            | CI runs multiple SEO checks plus `test:seo`; failing checks break pipeline                                      |
| 40  | ❌     | P1  | qa               | [tests/e2e/admin-auth.spec.ts](../tests/e2e/admin-auth.spec.ts), local Playwright run                                                                                                           | E2E exists but admin-auth subset is not green locally                                                           |
| 41  | ✅     | P1  | content/dev      | `npm run check:slugs`                                                                                                                                                                           | Passed                                                                                                          |
| 42  | ✅     | P0  | security         | secret-pattern `git grep` returned no matches, [.env.example](../.env.example)                                                                                                                  | No obvious secrets committed; examples are placeholders/config docs                                             |
| 43  | ❌     | P1  | legal/ops        | [src/pages/privacy.astro](../src/pages/privacy.astro)                                                                                                                                           | No Metrika/cookie/analytics disclosure text found                                                               |
| 44  | ❌     | P1  | backend/security | [src/server/admin/auth.ts](../src/server/admin/auth.ts), [tests/e2e/admin-auth.spec.ts](../tests/e2e/admin-auth.spec.ts)                                                                        | Protection code exists, but the current test harness is not passing                                             |
| 45  | NA     | P1  | ops/oncall       | alert code + smoke scripts exist                                                                                                                                                                | Live alert destinations/webhooks were not accessible locally                                                    |
| 46  | NA     | P2  | data/ops         | [.github/workflows/metrics-snapshot-cron.yaml](../.github/workflows/metrics-snapshot-cron.yaml)                                                                                                 | Snapshot automation exists, but live config/storage baseline not verifiable locally                             |
| 47  | NA     | P0  | marketing/ops    | repo only                                                                                                                                                                                       | Yandex.Webmaster ownership/submission cannot be verified from repo                                              |
| 48  | ❌     | P2  | ops              | repo scan                                                                                                                                                                                       | No repo evidence of 301/410 hit aggregation/alerting for first 14 days                                          |
| 49  | ❌     | P1  | marketing/ops    | [src/layouts/Layout.astro](../src/layouts/Layout.astro), [src/pages/contacts.astro](../src/pages/contacts.astro), [src/components/widgets/Footer.astro](../src/components/widgets/Footer.astro) | Internal site NAP already diverges; Yandex Business card also unverified                                        |
| 50  | ❌     | P1  | legal            | [src/pages/privacy.astro](../src/pages/privacy.astro)                                                                                                                                           | Privacy page exists, but no terms page was found                                                                |

## Commands Run

- `npm run build`
- `npm run predeploy:seo`
- `npm run test:seo`
- `npm test`
- `npm run check:lead-api`
- `npm run check:redis-outage`
- `npm run check:webhook-delivery`
- `npm run check:metrics-smoke`
- `npm run check:metrics-health-smoke`
- `npm run check:metrics-health-state-store`
- `npm run check:metrics-health-fallback`
- `npm run check:metrics-health-fallback-alert`
- `npm run check:secrets-scope`
- `npm run check:audit`
- `npm run check:lighthouse`
- `npx playwright test tests/e2e/admin-auth.spec.ts tests/e2e/tracking-funnel.spec.ts`

## Recommended Release Decision

Do not release until these are closed:

- operational P0 items 1, 11, 12, 47
- P1 items 3, 18, 30, 40, 43, 44, 49, 50
- CI instability in `metrics-smoke`, `webhook-delivery`, and `redis-outage` checks
- dependency audit failures from `npm run check:audit`
