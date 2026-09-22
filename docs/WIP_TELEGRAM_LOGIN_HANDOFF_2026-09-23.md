# WIP checkpoint: Telegram web-admin login

Status: incomplete, not validated for release or deployment. Development stopped
at the owner's request to save work before the Codex limit.

- Branch: `codex/o2-4-reliability`.
- Parent/base: `7fc83d432cd5f2e89c4a3eb57a3e0fe6ff0b4aae`.
- Checkpoint message: `chore: save MBL work checkpoint before Codex limit`.
- The checkpoint SHA is the commit containing this file; obtain it with
  `git log -1 --format=%H -- docs/WIP_TELEGRAM_LOGIN_HANDOFF_2026-09-23.md`.
- Exact pushed SHA and synchronization result are recorded in the task's final
  response after push verification; they cannot be embedded in their own commit.

## Work saved

- Added `jose` 6.1.3 with lockfile for standard JWT signature validation.
- Draft Telegram OIDC authorization-code exchange, PKCE, state/nonce, RS256
  JWKS verification, issuer/audience/expiry checks and numeric owner-ID allowlist.
- Draft opaque server sessions, Redis TTLs, one-use login flows, session/logout
  endpoints and CSRF token handling. Existing Redis client is reused.
- Admin HTML changed to dynamic rendering with session protection and a login
  page. Existing dashboard sections remain; the manual token input was replaced
  with session status/logout. Browser API fetches now use same-origin cookies.
- Draft admin authorization requires identity AND configured IP allowlist;
  explicit service-token overrides are intended to remain independent.
- A development-only mock session route was added. It is a session/UI harness,
  not a mock OIDC provider and not evidence that the real login flow works.

Official contract consulted:
https://core.telegram.org/bots/telegram-login

No real login keys/owner IDs were configured. `PUBLIC_SITE_URL`, existing
containers, volumes, backups, private audit artifacts and generated Nginx
configuration were not changed. Public design, SEO/content and images were not
changed. No release/deploy or main-branch change is authorized by this checkpoint.

## Checks actually run

- Reviewed current tracked diff and the ten new implementation files; staged
  contents and filenames must also be checked immediately before commit.
- Secret-pattern scan over the 18 implementation/package files: no candidates.
  This is a scoped inspection, not a guarantee from a full secret-scanning audit.
- `git diff --check`: passed before checkpoint staging.
- `node --check` for admin-health.js, admin-metrics.js and admin-session.js: passed.
- `npm run typecheck`: FAILED, with these three diagnostics:
  - `src/server/admin/auth.ts:620`: access to `session.code` without narrowing
    the success/failure union.
  - `tests/admin-health.test.ts:164` and `:183`: obsolete `allowlist` auth-method
    fixtures after the auth-method type changed.
- Installation reported 12 dependency advisories (2 low, 3 moderate, 7 high).
  Reachability and whether any predate this change were not investigated.
- Full check, unit/regression, production build, browser/E2E, real Redis session
  runtime, Nginx runtime and actual Telegram login have NOT been run for this diff.

## Remaining work and known limitations

1. Fix type errors, update existing authorization expectations and add the agreed
   negative/positive tests. Do not treat current UI text as proof of working login.
2. Review security before release: fail-closed Redis sessions; owner allowlist
   changes during existing sessions; invalid IP-allowlist configuration; service
   endpoints with missing override tokens; trusted proxy spoofing; duplicate
   middleware/route auth checks; session rotation; logout during Redis failure;
   CSRF and origin validation; cookie transport behind HTTPS termination;
   exact next-path allowlisting; callback no-store/referrer/log behavior;
   provider-response size/timeout coverage and login-start rate limiting.
3. Verify the mock route cannot operate in production. Replace or complement the
   current shortcut with signed mock-provider tests exercising state, nonce,
   PKCE, forged/expired/wrong issuer/audience tokens and callback replay.
4. Check admin HTML cannot remain available as stale static build artifacts and
   that login/callback reach Node through Nginx. Do not overwrite local generated
   files or operate on existing Docker resources.
5. Complete configuration documentation and secure runtime setup. Draft private
   env names are TELEGRAM_LOGIN_CLIENT_ID, TELEGRAM_LOGIN_CLIENT_SECRET,
   TELEGRAM_LOGIN_REDIRECT_URI, TELEGRAM_ADMIN_ALLOWED_USER_IDS,
   ADMIN_SESSION_TTL_SEC and ADMIN_OIDC_FLOW_TTL_SEC. No real values in Git.
   Real testing later requires BotFather Allowed URLs and an HTTPS callback at
   `/api/admin/auth/telegram/callback`. Do not buy/change the project domain.
6. CI working-branch check/typecheck/test coverage is still unmodified. Existing
   push workflow already builds Node 22/24 and checks the Nginx image on Node 22;
   add missing checks once without duplicating the heavy suite.
7. Independent no-header lead idempotency is still UNFIXED. Current fallback
   hashes phone/message/minute, so Ivan/Maria can collide. Explicit request keys
   must retain same-payload replay and different-payload 409 semantics. Actual
   no-JS forms cannot obtain required SmartCaptcha; do not introduce a bypass.
8. Telegram inventory started: independent incident/recovery/reminder notifier
   and owner-only `/today`, `/week`, `/funnel`, `/status` commands already exist.
   Lead delivery uses the existing generic webhook/Redis worker. No new lead
   notifications or customer-data transfer to Telegram were implemented.
9. Run the originally requested targeted tests, check/typecheck/unit/build and
   local browser login/logout checks after implementation is complete. Determine
   a bounded isolated runtime test for the changed authorization contract.
   Do not repeat the full Compose gate without a concrete reason.

Next safe step: inspect this WIP commit and current status, repair the known
type errors, then complete security review and targeted tests before any claim
of local PASS. Do not merge/deploy this checkpoint.
