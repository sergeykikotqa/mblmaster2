# O1.1 accessibility checkpoint — 2026-09-13/14

Baseline: `main` at `c1d43736a1d735e885c54dcb9860a4176e43b3eb`. O1 was pushed to `origin/main` before this work. O1.1 contains only accessibility fixes and their verification; production runtime migration is a separate stage.

## Confirmed defects and shared causes

| Route / component | Before | Change |
| --- | --- | --- |
| `/`, scroll-revealed sections | 47 desktop / 43 mobile targets in the initial normal-mode sweep; shared ancestor opacity reduced otherwise adequate text contrast | `.mbl-reveal` keeps transform, duration and delay; opacity no longer reduces text contrast |
| `/`, hero title | An additional early-load scan found `#home-title` and its `em` at both widths while entering | Hero entrance keeps translation and timing, with fully opaque text |
| Article detail, shared `SEOText` | Heading 1.10:1 and body 2.32:1: dark-theme light text on a legacy white card | Card background/border use existing elevated-surface tokens; text roles remain unchanged |
| Contact widget on secondary pages | Desktop CTA transient contrast around 2.1–2.25:1 during whole-wrapper fade; settled contrast 10.64:1 | Removed whole-wrapper opacity entrance from shared `WidgetWrapper` |
| `/projects/detskaya-krovat-cherdak-so-stolom-irkutsk`, shared project FAQ | Heading `#1f1a17` on `#080a0d`, 1.14:1 | FAQ heading uses `--mbl-color-text-primary` |
| Same project, mobile process badge | Broad dark-theme span rule made text `#a5abad` on the badge's light `#f5ede4` background, 2.00:1 | The shared process badge explicitly uses `--mbl-color-text-inverse` |
| `/projects/kuhnya-grafitovaya` and `/projects/kuhnya-verkhnyaya-naberezhnaya`, mobile video block | The mobile-only video section still used legacy dark heading and muted copy on the dark project surface: 1.11:1, 3.12:1 and 3.53:1 | Shared video heading, description and note use the existing primary/secondary text tokens |
| Secondary public routes, mobile floating call button | The fixed button lived directly under `body`, outside a landmark; the first expanded full scan flagged `region` on 34 mobile routes | The shared floating-call wrapper is now a named complementary landmark, with no visual change |
| `/articles/materialy-dlya-kuhni`, mobile comparison table | The generated `overflow:auto` table wrapper was not keyboard-focusable | The shared responsive-table renderer adds `tabindex="0"` to scroll containers |

The article defect was reproduced on `/articles/kak-splanirovat-garderobnuyu`, `/articles/kak-vybrat-kuhnyu-na-zakaz`, `/articles/materialy-dlya-kuhni`, and `/articles/kuhnya-bez-verhnih-shkafov-irkutsk`. All share the same component; content was not changed.

Initially clean for **color contrast at settled state** on both widths: `/articles`, `/projects`, `/projects/kuhnya-bogdana`, `/guides?q=кухня`, `/kuhni`, `/contacts`. The last two share the transient contact-wrapper issue; their settled CTA colors were already adequate. The mobile floating-call landmark issue is separate from color contrast. Homepage failures were animation-state defects, not an incorrect settled palette.

Resolved solid-color pairs: article heading 16.52:1, article body 7.88:1, FAQ heading 17.87:1, process badge 14.93:1. These calculations do not certify text over arbitrary photography or gradients.

## Permanent checks

- `check:accessibility`: eight representative routes at 1440/390 with five scroll positions, plus lightbox pointer/focus/reduced-motion checks. `color-contrast` is enabled.
- `check:accessibility:full`: derives public routes from built HTML, including public `noindex` pages. Administrative `/admin` and `/decapcms` interfaces are outside this public-site scope.
- The full test checks both 1440 and 390, with five scroll positions. Routes run independently so one failure does not skip the remainder.
- Both commands use `playwright.a11y.config.ts`, which starts normal public mode (`PUBLIC_E2E=0`). Tests assert the E2E override is absent. No Axe rules are disabled and reduced motion is not forced for the contrast scan.

The browser still runs against the local Astro server to exercise real image rendering and public behavior. Built HTML determines route coverage; this is not a production Node/Redis/Nginx integration gate. The full inventory contains 72 public HTML routes from 75 built pages; the 404 entry is requested as `/404.html`, which is how Astro's dev server returns its actual 404 response.

## Verification

The first expanded scan found the additional mobile-only defects above and a test URL mismatch for the 404 page. After the fixes, targeted rechecks passed 8/8 on desktop/mobile. A subsequent broad run passed 142 checks and lost three browser contexts when other verification commands rewrote generated content during its execution. Those were test-environment interruptions, not Axe findings. The uninterrupted final rerun passed **145/145**: 72 public routes at 1440 and 390, five scroll positions each, plus route-inventory check, with **zero Axe violations** and no disabled rules.

Other final checks passed: build (75 HTML files), `npm run check` (0 errors, 0 warnings, 39 existing hints), typecheck, 51 unit tests, representative accessibility including lightbox/reduced motion (18/18), E2E smoke for forms/navigation (6/6), Prettier for changed TypeScript/tests, and `git diff --check`. The mandatory general accessibility gate now includes `color-contrast` without exceptions in normal public mode.

Screenshots are kept under ignored `.tmp/` for 1440/390 homepage, article card, project FAQ and mobile process badge. No images, content, slugs, SEO, dependency versions, lead pipeline or CMS/admin source files were changed.

## Limits

Zero Axe violations is not a claim that every accessibility criterion has been manually certified. Axe `incomplete` findings for gradients, images and pseudo-elements require contextual inspection. Production readiness remains a separate runtime/security/release decision.
