# O2.5.1 — Yandex SmartCaptcha

SmartCaptcha is the sole CAPTCHA provider for lead forms. The browser obtains the public client key from the dynamic, no-store `/api/captcha/config` endpoint and loads the widget only when the form is in use. The server verifies the one-time token before Redis enqueue/idempotency handling. Rate limiting, consent, queue and worker delivery remain on the existing lead path.

## Official contract

- Widget script: `https://smartcaptcha.cloud.yandex.ru/captcha.js` with the advanced `render` API; the form reserves at least 100 px for it.
- Verification: `POST https://smartcaptcha.cloud.yandex.ru/validate` as `application/x-www-form-urlencoded` with `secret`, `token` and, when available, the trusted client `ip`.
- A token is valid for five minutes and is single-use. `status: ok` is accepted only if its `host` matches the configured allowlist. `status: failed` (including expired/reused tokens), unknown status, missing host, non-200, malformed response, timeout and network error all reject the lead.
- Yandex recommends treating some non-200 responses as success to avoid delays. MBL intentionally does not: the owner requires fail-closed. The UI shows an error, resets the used token, and offers a new attempt or a phone call.
- Keep Yandex Cloud's allowed-domain check enabled. The server host allowlist is additional protection, not a substitute.

Sources: [validation](https://yandex.cloud/ru/docs/smartcaptcha/operations/validate-captcha), [widget API](https://yandex.cloud/en/docs/smartcaptcha/concepts/widget-methods), [allowed domains](https://yandex.cloud/en/docs/smartcaptcha/concepts/domain-validation), [keys](https://yandex.cloud/ru/docs/smartcaptcha/concepts/keys).

## Owner configuration before a real-domain check

1. Create a SmartCaptcha in the Russian Yandex Cloud account. Keep domain validation enabled and add the exact canonical domain and any public `www` alias, without a protocol or trailing slash. Add a separate test domain/key pair if real-provider testing is needed before the launch.
2. Obtain its `ysc1_` client key and matching `ysc2_` server key. Store both in a `0600` VPS environment file or secret manager, never in Git, Docker build arguments, images, release bundles or reports. The client key is public at runtime; the server key never leaves the backend.
3. Set `CONTACT_SMARTCAPTCHA_REQUIRED=true`, `SMARTCAPTCHA_CLIENT_KEY`, `SMARTCAPTCHA_SERVER_KEY`, `SMARTCAPTCHA_ALLOWED_HOSTS`. Leave `SMARTCAPTCHA_VERIFY_URL` empty and `SMARTCAPTCHA_ALLOW_LOCAL_VERIFY_OVERRIDE=false` in production.
4. Decide the Yandex Cloud organization, contract and data-processing options with the owner. The Russian Yandex Cloud service page states the service runs in its infrastructure and complies with Russian law; that alone is not a technical guarantee of a particular storage region for every request. Confirm residency requirements with the provider before launch.
5. Verify the actual widget, keyboard and mobile challenge, CSP and one successful/one failed synthetic lead on the test domain with test-only keys. Do not use real customer names or phone numbers.

The keys are not needed for local unit, API or Chromium mock tests. A production deployment without complete configuration reports not-ready and rejects leads; it never silently bypasses CAPTCHA or delivers directly to the webhook.

The existing full production Compose/release canary accepts a lead. It therefore cannot pass with fictitious keys or with CAPTCHA disabled: run that gate with an isolated SmartCaptcha test configuration and synthetic lead data before declaring a release ready. Its old `CONTACT_SMARTCAPTCHA_REQUIRED=false` fixture is intentionally ineffective in production; the application enforces verification regardless of that value.

## Local tests

`npm test`, `npm run build`, `npm run check`, `npm run typecheck`, `npm run check:audit`, `npm run check:node-runtime`, targeted Chromium tests and the a11y smoke run without contacting Yandex. The provider verifier supports a localhost-only URL override in non-production for local integration tests. The release config gate rejects that override in production.
