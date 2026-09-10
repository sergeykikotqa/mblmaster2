# Release Notes — 2026-03-23

## Money Page Conversion Contract

- Money pages (`/kuhni`, `/shkafy`, `/garderobnye`, `/kuhni-3-metra`) now use one primary path only: `#contact`.
- Hero secondary action is standardized to `#service-projects`.
- Re-entry CTA and mobile sticky CTA use the same conversion contract across all 4 money pages.
- Money pages no longer render the floating call button or the mobile header call button, so mobile first-screen CTA choices stay limited and non-competing.
- DOM and analytics markers are standardized:
  - `service_hero_primary`
  - `service_hero_secondary`
  - `service_reentry_primary`
  - `service_reentry_call`
  - `service_sticky_primary`
  - `service_sticky_call`
- Pre-launch audit `Q13` is aligned to the new re-entry contract and no longer checks the removed `service_mid_*` markers.

## Validation

- `npm run audit:pre-launch` => `GO`
- `Auto Score` => `10`
- Manual browser QA confirmed:
  - sticky appears after hero exit,
  - sticky hides near `#contact`,
  - sticky stays hidden while the contact form is focused.

## Form Conversion Contract

- Contact form now optimizes the path from CTA click to first input:
  - hero CTA to `#contact` visually highlights the form,
  - first input receives focus after money-page anchor navigation,
  - minimal submission flow is covered by e2e.
- Form copy is simplified for lower friction:
  - first field uses `Как к вам обращаться`,
  - CTA note now promises response time and no spam instead of repeating trust copy.
- New client-side analytics events are emitted for the form funnel:
  - `form_view`
  - `form_first_input_focus`
  - `form_submit_attempt`
  - `form_submit_success`
- Dedicated e2e coverage now checks:
  - CTA -> `#contact`
  - first input focus
  - minimal valid submit
  - expected analytics events in `dataLayer`
