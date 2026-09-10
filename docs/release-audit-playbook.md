# Release Audit Playbook

## Purpose

Use this playbook to run the 28-question pre-release audit as a single, evidence-driven workflow. The audit is not a brainstorm. It is a four-phase release gate that ends with one dated Markdown report and a binary verdict: `GO` or `NO-GO`.

This repo should be treated in this order of trust:

1. current code, scripts, and tests
2. generated local artifacts
3. older docs and previous audit notes

If an older document disagrees with the codebase, the codebase wins.

## Inputs

- Workspace root: `C:\Users\adida\Desktop\yes`
- Main sources of truth:
  - `package.json`
  - `scripts/check-*.mjs`
  - `tests/*`
  - `ARCHITECTURE.md`
  - `docs/QUALITY_GATES.md`
- Generated audit artifacts:
  - `artifacts/claude-content-audit/`
  - `artifacts/smoke-manifest.json`
  - `.lighthouseci/`

## Operator Preconditions

1. Run from the repo root.
2. Use PowerShell.
3. Set a non-production URL for local build-based checks if a real release URL is not available:

```powershell
$env:PUBLIC_SITE_URL='https://example.com'
```

4. For local `check:admin-token-leak` or `predeploy:seo` runs without a real admin token, use the documented sentinel:

```powershell
$env:METRICS_ADMIN_TOKEN='__SENTINEL__'
```

5. Do not use ad hoc prompts for content quality. Generate the prompt pack with:

```powershell
$env:PUBLIC_SITE_URL='https://example.com'; npm run audit:content:claude
```

Optional one-command runner for automated local gating:

```powershell
npm run audit:pre-release
```

## Status Vocabulary

- `PASS`: verified locally and meets the gate
- `FAIL`: verified locally and does not meet the gate
- `NA/ops`: not decidable from repo state alone; must be closed operationally
- `MANUAL`: requires explicit human review, usually with prompt packs or rendered artifacts

## Phase 0: Hard Stop Baseline

Run these commands first and in this order:

```powershell
npm run lint
npm run typecheck
npm run check:astro
npm run test
$env:PUBLIC_SITE_URL='https://example.com'; npm run build
```

Rules:

- If any command fails, stop the audit.
- The release is automatically `NO-GO`.
- Questions `1, 2, 3, 6, 10, 12, 18, 19, 20, 27` are marked blocked by baseline instability.

## Phase 1: Fast Scan

Goal: answer questions `1-5` with evidence, not opinion.

Run:

```powershell
npm run check:slugs
npm run check:content-duplicates
npm run check:no-legacy-project-fields
npm run check:image-policy
Get-ChildItem src -Recurse -File | Select-String -Pattern 'isBlockMode|legacy-mode|/images/projects/'
Get-ChildItem src -Recurse -File | Select-String -Pattern 'NormalizedProjectContent|resolveProjectImage|project-render-plan'
$env:PUBLIC_SITE_URL='https://example.com'; npm run audit:content:claude
```

Then use:

- `artifacts/claude-content-audit/prompts/full-content-audit.md`
- `artifacts/claude-content-audit/prompts/thin-eeat-quick-scan.md`

Required outputs from this phase:

- whether `NormalizedProjectContent` is the current single source of truth
- whether any legacy render path still exists
- whether raw `/images/projects/...` strings still leak into templates
- whether any slug or id conflicts exist
- top thin pages by local `word_count`
- a manual follow-up queue for E-E-A-T scoring

## Phase 2: Deep Technical Audit

Goal: answer questions `6-12`.

Run:

```powershell
npm run check:architecture
npm run check:lighthouse-routes
npm run check:lighthouse:smoke
npm run check:performance-budgets
Get-ChildItem src/lib/projects,src/components/projects -Recurse -File | Select-String -Pattern '\bany\b|\bunknown\b| as '
Get-ChildItem tests -Recurse -File | Select-String -Pattern 'CostBreakdown|FactsGrid|ProcessSteps|CostSummary|LinksSection'
Get-ChildItem src/components/projects,src/pages/projects,src/lib/projects -Recurse -File | Select-String -Pattern '<img|/images/projects/|<Image'
Get-ChildItem src/components/projects,src/lib/projects,src/pages/projects -Recurse -File | Select-String -Pattern 'PROJECT_BLOCK_REGISTRY|getProjectBlockComponent|buildProjectRenderPlan|NormalizedProjectContent|normalizeProjectContent'
```

Decision rules:

- If `npm run check:lighthouse:smoke` fails, the release is `NO-GO` for frontend architecture.
- If block registration requires renderer surgery for authored blocks, mark question `7` as `FAIL`.
- If raw `<img>` remains in primary project media paths, mark question `8` as `FAIL`.

Artifacts to capture:

- `artifacts/smoke-manifest.json`
- `.lighthouseci/assertion-results.json`

## Phase 3: SEO, Content, and Money Pages

Goal: answer questions `13-17`.

Run:

```powershell
$env:PUBLIC_SITE_URL='https://example.com'; $env:METRICS_ADMIN_TOKEN='__SENTINEL__'; npm run predeploy:seo
npm run check:seo
$env:PUBLIC_SITE_URL='https://example.com'; npm run check:semantic
npm run check:schema
npm run check:links
npm run check:related-links
npm run check:indexable-link-coverage
npm run check:indexable-coverage
npm run check:sitemap-coverage
```

Then use the Claude prompt pack:

- `artifacts/claude-content-audit/prompts/money-pages-audit.md`
- `artifacts/claude-content-audit/prompts/full-content-audit.md`
- `artifacts/claude-content-audit/prompts/deepen-weakest-pages.md`
- `artifacts/claude-content-audit/prompts/faq-guides-audit.md`

Rules:

- Local invariant checks decide schema, sitemap, indexability, and internal-link baselines.
- Claude prompts are for editorial judgment only: thinness, trust duplication, semantic strength, and E-E-A-T.
- Search Console or live crawl behavior is always `NA/ops` unless production evidence is available.

## Phase 4: Strategic Verdict

Create one dated report:

- path format: `docs/pre-release-audit-YYYY-MM-DD.md`
- status per question: `PASS`, `FAIL`, `NA/ops`, `MANUAL`
- verdict: `GO` or `NO-GO`

The report must include:

- top 3 support-cost hotspots
- first-break risks if project volume grows
- current gate inventory and slow gates
- top 3 release risks
- final scores for:
  - architecture cases
  - content moat
  - perf / Core Web Vitals
  - maintainability
  - SEO invariants

## Release Rules

- Any red in Phase 0: `NO-GO`
- Any P1 fail in duplicates, schema, indexability, LCP smoke, or lead/runtime: `NO-GO`
- Content-only weaknesses may ship only if they do not affect money pages or indexability

## 28-Question Evidence Matrix

| # | Phase | Question | Primary evidence | How to answer |
| --- | --- | --- | --- | --- |
| 1 | 1 | Single source of truth for project data | `NormalizedProjectContent`, `normalizeProjectContent`, project layer grep | code + command |
| 2 | 1 | Legacy render path still exists | `npm run check:no-legacy-project-fields`, `buildProjectRenderPlan` | code + command |
| 3 | 1 | Raw `/images/projects/...` leakage | image-policy + template grep | code + command |
| 4 | 1 | Slug/id conflicts | `check:slugs`, `check:content-duplicates` | command |
| 5 | 1 | Thin pages and weak pages | `pages.csv`, `thin-eeat-quick-scan.md`, `full-content-audit.md` | local shortlist + manual |
| 6 | 2 | New frontmatter field touchpoints | `src/content/config.ts`, `src/lib/projects/normalized-project-content.ts` | code review |
| 7 | 2 | New block without renderer surgery | `block-registry.ts`, `ProjectRenderer.astro`, `project-render-plan.ts` | code review |
| 8 | 2 | Image contract coverage | `<img|<Image` grep in project components | code review |
| 9 | 2 | LCP stays on hero media | `check:lighthouse:smoke`, `.lighthouseci/` | command + manual |
| 10 | 2 | Type-safety debt in project layer | grep for `any`, `unknown`, `as` | command |
| 11 | 2 | Atom-level tests exist | grep in `tests/` for atom names | command |
| 12 | 2 | Build reproducibility | Phase 0 build + build-dependent scripts with explicit env | command |
| 13 | 3 | Trust signal duplication on money pages | `money-pages-audit.md`, `check:indexable-coverage`, `check:content-length` | command + manual |
| 14 | 3 | Semantics and E-E-A-T score distribution | `full-content-audit.md` | manual |
| 15 | 3 | Weak pages fed by internal links | `check:indexable-link-coverage`, prompt pack | command + manual |
| 16 | 3 | Schema completeness vs basic coverage | `check:schema`, rendered JSON-LD review | command + manual |
| 17 | 3 | Crawl budget and noindex behavior | `check:sitemap-coverage`, build-data state, Search Console if available | command + ops |
| 18 | 4 | Top 3 support-cost hotspots | synthesis from phases 1-3 | report synthesis |
| 19 | 4 | First-break scalability risks | synthesis from phases 1-3 | report synthesis |
| 20 | 4 | Gate inventory and slow gates | `docs/QUALITY_GATES.md`, workflow inventory, observed runtimes | docs + command |
| 21 | 4 | Missing `imageBaseDir` or slug conflict behavior | resolver code + slug guards | code + command |
| 22 | 4 | Architecture docs are current | `ARCHITECTURE.md` vs current code | doc + code review |
| 23 | 4 | Astro future-proofing | current architecture + manual upgrade judgment | manual |
| 24 | 4 | CTA unification and A/B readiness | component audit on money pages | manual |
| 25 | 4 | Missing monitoring metrics | workflows, metrics scripts, report synthesis | code + synthesis |
| 26 | 4 | New developer can add a project safely | docs + normalized flow + legacy field check | synthesis |
| 27 | 4 | Top 3 release risks | synthesis from phases 0-3 | report synthesis |
| 28 | 4 | Final category scores | report synthesis with scoring rubric | report synthesis |

## Dated Report Skeleton

Use this structure:

```md
# Pre-release Audit YYYY-MM-DD

Verdict: GO | NO-GO

Scope:
- local repo audit only
- commands run
- missing live/ops contexts

## Blocking Findings

## Top 15 Thin Pages

## 28-question Checklist

## Top 3 Support-cost Hotspots

## First-break Risks at Scale

## Gate Inventory

## Top 3 Release Risks

## Final Scores
```
