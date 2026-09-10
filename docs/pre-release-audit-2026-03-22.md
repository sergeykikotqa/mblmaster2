# Pre-release Audit 2026-03-22

Verdict: GO

## Scope

- Workspace-only audit based on the repository state in `C:\Users\adida\Desktop\yes`
- No live production consoles, search-console crawl data, or real secret values were accessed
- The audit used current code, scripts, tests, generated build artifacts, and the Claude prompt export

## Executive Summary

Green today:

- `npm run lint`
- `npm run typecheck`
- `npm run check:astro`
- `npm run test`
- `$env:PUBLIC_SITE_URL='https://example.com'; $env:NODE_OPTIONS='--max-old-space-size=4096'; npm run build`
- `$env:PUBLIC_SITE_URL='https://example.com'; $env:LHCI_NUMBER_OF_RUNS='1'; $env:LHCI_BUILD_CONTEXT__CURRENT_BRANCH='local'; npm run check:lighthouse:smoke`
- `npm run check:no-legacy-project-fields`
- `npm run check:image-policy`, `npm run check:architecture`, `npm run check:performance-budgets`
- `$env:PUBLIC_SITE_URL='https://example.com'; $env:METRICS_ADMIN_TOKEN='__SENTINEL__'; npm run predeploy:seo`
- `npm run audit:pre-release` (Phase 0-3 local runner with safe local env defaults)

Blocking today:

None from automated gates. Manual follow-ups remain for content/E-E-A-T scoring, schema completeness review, and CTA uniformity on money pages.

## Commands Run

- `npm run lint`
- `npm run typecheck`
- `npm run check:astro`
- `npm run test`
- `$env:PUBLIC_SITE_URL='https://example.com'; $env:NODE_OPTIONS='--max-old-space-size=4096'; npm run build`
- `npm run check:no-legacy-project-fields`
- `npm run check:image-policy`
- `npm run check:architecture`
- `npm run check:lighthouse-routes`
- `$env:PUBLIC_SITE_URL='https://example.com'; $env:LHCI_NUMBER_OF_RUNS='1'; $env:LHCI_BUILD_CONTEXT__CURRENT_BRANCH='local'; npm run check:lighthouse:smoke`
- `npm run check:performance-budgets`
- `npm run check:links`
- `npm run check:related-links`
- `npm run check:indexable-link-coverage`
- `$env:PUBLIC_SITE_URL='https://example.com'; $env:METRICS_ADMIN_TOKEN='__SENTINEL__'; npm run predeploy:seo`
- `npm run audit:pre-release`

## Top 15 Thin Pages by Local Word Count

Source: `artifacts/claude-content-audit/pages.csv`

| Route | Word count | Note |
| --- | ---: | --- |
| `/thanks` | 21 | support page |
| `/guides` | 39 | index page |
| `/terms` | 89 | legal/support |
| `/faq` | 119 | index page |
| `/privacy` | 136 | legal/support |
| `/faq/voprosy-ob-ispolzovanii-kuhen` | 240 | thin FAQ detail |
| `/contacts` | 420 | below 450 words |
| `/articles` | 494 | index page |
| `/guides/process-izgotovleniya-kuhni` | 616 | above thin threshold |
| `/articles/kak-splanirovat-garderobnuyu` | 620 | above thin threshold |
| `/articles/kuhnya-s-ostrovom-irkutsk` | 655 | above thin threshold |
| `/articles/garderobnaya-na-zakaz-irkutsk` | 667 | above thin threshold |
| `/articles/kuhnya-s-barnoy-stoykoy-irkutsk` | 667 | above thin threshold |
| `/articles/kuhnya-bez-verhnih-shkafov-irkutsk` | 675 | above thin threshold |
| `/o-kompanii` | 696 | above thin threshold |

E-E-A-T scoring was not executed locally. The required manual prompt pack is ready in:

- `artifacts/claude-content-audit/prompts/full-content-audit.md`
- `artifacts/claude-content-audit/prompts/thin-eeat-quick-scan.md`
- `artifacts/claude-content-audit/prompts/money-pages-audit.md`
- `artifacts/claude-content-audit/prompts/deepen-weakest-pages.md`

## 28-question Checklist

| # | Status | Evidence | Answer |
| --- | --- | --- | --- |
| 1 | PASS | `src/lib/projects/normalized-project-content.ts`; project-layer grep for `NormalizedProjectContent` and `normalizeProjectContent` | `NormalizedProjectContent` is the current project-data source of truth across adapters, view-model, and renderer. |
| 2 | PASS | `npm run check:no-legacy-project-fields`; `src/lib/projects/project-render-plan.ts` | Legacy fields are removed and the render plan is blocks-only with no synthetic fallback path. |
| 3 | PASS | `npm run check:image-policy`; grep for `/images/projects/` | No raw `/images/projects/...` strings were found leaking from project templates; remaining occurrences are resolver fallback code and frontmatter thumbnail strings. |
| 4 | PASS | `npm run check:slugs`; `npm run check:content-duplicates` | No duplicate slugs or duplicate ids were found in the current content corpus. |
| 5 | MANUAL | `artifacts/claude-content-audit/pages.csv`; prompt pack | Local word counts are available and listed above, but E-E-A-T scoring still requires prompt execution in Claude. |
| 6 | FAIL | `src/content/config.ts`; `src/lib/projects/normalized-project-content.ts`; `src/lib/projects/project-view-model.ts` | A new frontmatter field no longer requires touching many render branches, but it still needs schema work plus normalization, and often view-model work when the UI derives data from it. |
| 7 | PASS | `src/components/projects/block-registry.ts`; `src/components/projects/ProjectRenderer.astro`; `src/lib/projects/project-render-plan.ts` | Authored blocks are registry-driven and do not require renderer surgery. There is no legacy fallback path. |
| 8 | FAIL | grep for `<img|<Image` in `src/components/projects` | Primary project media mostly use `Image.astro`, but raw `<img>` remains in the gallery lightbox, project modal preview, and rail video poster. |
| 9 | PASS | `npm run check:lighthouse:smoke`; `artifacts/lighthouse-summary.json` | LCP element checks passed for sampled project routes, and the homepage payload budget passed under the smoke gate (INP auditRan warnings only). |
| 10 | FAIL | grep for `any`, `unknown`, `as` in project layer | `any` is gone in `src/lib/projects/*` and `src/components/projects/*`, but there are still `14` `unknown` matches and `121` lines containing ` as `. |
| 11 | FAIL | grep for `CostBreakdown|FactsGrid|ProcessSteps|CostSummary|LinksSection` in `tests/` | The new atoms are covered indirectly by integration tests, but they do not have direct unit tests today. |
| 12 | PASS | Phase 0 build; build-dependent scripts | Build output is reproducible when `PUBLIC_SITE_URL` is explicit. Without that env, build-dependent audit commands fail operationally, not functionally. |
| 13 | MANUAL | `npm run check:indexable-coverage`; `npm run check:content-length`; `money-pages-audit.md` | Local structural gates for money pages pass, but trust-signal duplication on `/kuhni`, `/shkafy`, and `/garderobnye` still requires editorial/manual review. |
| 14 | MANUAL | `full-content-audit.md` | Semantic and E-E-A-T score distribution is not computed locally; the prompt pack is ready. |
| 15 | MANUAL | `npm run check:indexable-link-coverage`; prompt pack | Structural indexable-link coverage passes, but the specific question about weak pages receiving `3-5` strong internal links still requires manual/content review. |
| 16 | MANUAL | `npm run check:schema`; rendered HTML/JSON-LD | Schema coverage passes, but "basic vs complete" for `LocalBusiness`, `Product`, and `Review` still needs manual JSON-LD review on target routes. |
| 17 | NA/ops | `npm run check:sitemap-coverage`; build-data output; `data/article-seo-state.json` | Repo invariants are healthy and sitemap coverage passes, but actual crawl-budget behavior for noindex pages cannot be confirmed without production crawler/search-console data. |
| 18 | PASS | phases 1-3 evidence | Current top support-cost hotspots are: cast-heavy project view-model/block layer, stale architecture docs, and audit wrappers that still depend on implicit env knowledge. |
| 19 | PASS | phases 1-3 evidence | If project volume jumps, the first breakpoints are likely homepage payload/perf drift, manual content-review scale, and onboarding friction caused by stale architecture docs. |
| 20 | PASS | `docs/QUALITY_GATES.md`; workflow inventory in `.github/workflows/` | The repo documents `8` PR-baseline commands and a heavier nightly/full-audit baseline. Slow gates observed locally are `build` (~11s) and `check:lighthouse:smoke` (~113s). |
| 21 | PASS | `src/lib/projects/normalized-project-content.ts`; slug guards | Missing `imageBaseDir` falls back to slug-derived project paths, while slug conflicts are caught explicitly by `check:slugs` and `check:content-duplicates`. |
| 22 | FAIL | `ARCHITECTURE.md`; `src/content/config.ts` | `ARCHITECTURE.md` exists, but it is stale. Example: it still describes `street` as mandatory while the schema is now `optional()`. |
| 23 | MANUAL | architecture split plus current scripts | The normalized/render split improves upgrade readiness, but there is no explicit Astro 5 / Content Layer v2 / Server Islands migration assessment yet. |
| 24 | MANUAL | component audit required across money pages | Project pages use shared CTA primitives, but a repo-wide audit is still needed to prove that all money pages use one unified CTA system with A/B-ready variants. |
| 25 | PASS | workflows, metrics checks, audit synthesis | The repo has backend/admin metrics automation, but it still lacks first-class frontend/content monitoring for page-level LCP, thin-content percentage, and image-404 drift. |
| 26 | PASS | normalized flow + docs review | Adding a project is now a single block-based contract; the remaining friction is stale docs rather than mixed data paths. |
| 27 | PASS | phases 0-3 evidence | Current top release risks are manual money-page trust review, homepage perf budget headroom being tight, and stale architecture documentation. |
| 28 | PASS | scoring rubric below | Final category scores are provided below. |

## Top 3 Support-cost Hotspots

1. The project layer still carries high cast density (`unknown` and `as`) in `normalized-project-content.ts`, `project-view-model.ts`, and multiple block components.
2. Architecture and onboarding docs are stale, so new contributors still need tribal knowledge to navigate the data pipeline.
3. Full audit wrappers are not yet fully self-describing: build-based checks need `PUBLIC_SITE_URL`, and some security/ops guards need an explicit token or sentinel.

## First-break Risks at Scale

1. Frontend perf risk: the homepage payload budget is now within the gate, but headroom is tight, so new media or hydration could regress it.
2. Content scale risk: manual E-E-A-T review does not scale well without tighter editorial workflows.
3. Team/process risk: stale architecture docs plus manual content-review steps will slow onboarding and release confidence.

## Gate Inventory

- PR baseline in `docs/QUALITY_GATES.md`: `8` commands
- Workflow files present: `actions.yaml`, `nightly-quality.yaml`, `lead-worker-cron.yaml`, `metrics-health-cron.yaml`, `metrics-snapshot-cron.yaml`
- Slow gates observed locally:
  - `npm run check:lighthouse:smoke`: about `113s`
  - `$env:PUBLIC_SITE_URL='https://example.com'; npm run build`: about `11s`

## Top 3 Release Risks

1. The editorial trust audit for money pages and weak content clusters is still pending manual prompt execution.
2. Homepage payload/perf headroom is tight, so it is easy to regress without noticing.
3. Architecture docs are stale, which increases onboarding and maintenance risk.

## Final Scores

- Architecture cases: `8/10`
- Content moat: `6/10`
- Perf / Core Web Vitals: `7/10`
- Maintainability: `7/10`
- SEO invariants: `8/10`

Scoring notes:

- `Architecture cases = 8/10`: normalized content and unified rendering are solid, with legacy fallback removed.
- `Content moat = 6/10`: money-page structure is healthy, yet E-E-A-T review is still manual and several support pages are thin.
- `Perf / Core Web Vitals = 7/10`: perf budgets pass, but the homepage payload has limited headroom.
- `Maintainability = 7/10`: the project stack is cleaner, but cast density and stale docs still cost team time.
- `SEO invariants = 8/10`: schema, sitemap, internal links, and indexability checks pass, with remaining gaps concentrated in manual content quality review rather than broken SEO mechanics.

## Recommended Next Actions Before Re-audit

1. Execute the Claude prompt pack for `full-content-audit.md` and `money-pages-audit.md`, then append the manual verdicts to this report.
2. Reduce cast density and add direct unit tests for project atoms that are currently only integration-covered.
3. Update `ARCHITECTURE.md` and make predeploy env defaults turnkey (avoid manual `PUBLIC_SITE_URL` / token setup).
