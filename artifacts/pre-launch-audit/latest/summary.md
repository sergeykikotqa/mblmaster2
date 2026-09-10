# Pre-Launch Auto Audit Summary

- Started: 2026-03-23T13:49:14.524Z
- Finished: 2026-03-23T13:58:11.317Z
- Duration (sec): 536.79
- Auto Score: 10
- Final Score: pending-manual
- Verdict: GO

## Block Scores

| Block | Pass | Total | Score |
| --- | ---: | ---: | ---: |
| block1 | 10 | 10 | 10 |
| block2 | 9 | 9 | 10 |
| block3 | 4 | 4 | 10 |
| block4 | 1 | 1 | 10 |
| block5 | 1 | 1 | 10 |

## Blocker State

- hasBlockingFailure: false
- failedAt: none
- failedBlockers: none

## Lead Runtime Smoke

- local: PASS — Local production-like lead runtime smoke passed.
- deployed: NA/ops — Deployed runtime smoke requires DEPLOY_SMOKE_BASE_URL and remains enforced in the main release workflow.

## Question Status

| ID | Status | Type | Blocker | Comment |
| --- | --- | --- | --- | --- |
| Q1 | PASS | auto | yes | All baseline gates are green. |
| Q2 | PASS | auto | yes | Pre-release 28-question baseline is green. |
| Q3 | PASS | auto | no | Q3 PASS = unsafe typing allowed only in boundary layer; no as/any in render pipeline and normalized project flow. Residual debt outside strict pipeline: any=0, unknown=9, as=87. |
| Q4 | PASS | auto | yes | No raw /images/projects/ leakage in templates/dist. |
| Q5 | PASS | auto | yes | Lighthouse smoke + hero-LCP contract evidence is present. |
| Q6 | PASS | auto | yes | No duplicate slug/id collisions detected. |
| Q7 | PASS | auto | no | Build and core URL invariants are stable under alternative PUBLIC_SITE_URL. |
| Q8 | PASS | auto | no | Integration coverage references all key block atoms. |
| Q9 | PASS | auto | yes | No legacy-mode path remains. |
| Q10 | PASS | auto | yes | Single renderer orchestration path is in place. |
| Q11 | MANUAL | manual | no | Manual review required. |
| Q12 | PASS | auto | no | All money pages include service-project binding markers. |
| Q13 | PASS | auto | no | Re-entry conversion CTAs are present. |
| Q14 | MANUAL | manual | no | Manual review required. |
| Q15 | MANUAL | manual | no | Manual review required. |
| Q16 | PASS | auto | no | Indexable internal-link baseline is green. |
| Q17 | PASS | auto | no | Schema baseline gate is green. |
| Q18 | NA/ops | ops | no | Operational evidence required. |
| Q19 | PASS | auto | yes | Sitemap/robots/indexability constraints are green. |
| Q20 | PASS | auto | yes | Thin-content gate is green for current indexable set. |
| Q21 | MANUAL | manual | no | Manual review required. |
| Q22 | PASS | auto | yes | Required money-page CWV smoke set is green. |
| Q23 | PASS | auto | no | Mobile adaptation smoke audit passed. |
| Q24 | PASS | auto | yes | NAP and local SEO schema signals are present on money pages. |
| Q25 | MANUAL | manual | no | Manual review required. |
| Q26 | PASS | auto | no | Block registry stays declarative. |
| Q27 | PASS | auto | no | Normalization contract remains the canonical project-data path. |
| Q28 | MANUAL | manual | no | Manual review required. |
| Q29 | MANUAL | manual | no | Manual review required. |
| Q30 | MANUAL | manual | no | Manual review required. |
| Q31 | PASS | auto | no | No legacy temporary markers found. |
| Q32 | PASS | auto | yes | Release runtime gates are wired. Local smoke=PASS; deployed smoke=NA/ops. Deployed runtime smoke requires DEPLOY_SMOKE_BASE_URL and remains enforced in the main release workflow. |
| Q33 | MANUAL | manual | no | Manual review required. |
| Q34 | MANUAL | manual | no | Manual review required. |
| Q35 | PASS | auto | no | A11y smoke baseline is green. |
| Q36 | MANUAL | manual | no | Manual review required. |
| Q37 | MANUAL | manual | no | Manual review required. |
| Q38 | MANUAL | manual | no | Manual review required. |
| Q39 | PASS | auto | yes | No P1 auto-blockers detected in auto run. |
| Q40 | MANUAL | manual | no | Manual review required. |
| Q41 | MANUAL | manual | no | Manual review required. |
| Q42 | PASS | auto | no | Dual score and auto verdict computed. |
