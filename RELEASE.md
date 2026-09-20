# Release Checklist

## Pre-release

1. Confirm production env is complete.
   Required:
   - `PUBLIC_SITE_URL`
   - `REDIS_URL`
   - `CONTACT_WORKER_URL`
   - `CONTACT_WORKER_TOKEN`
   - `CONTACT_WEBHOOK_URL`
   - `CONTACT_WEBHOOK_SECRET`
   - `CONTACT_ALERT_WEBHOOK_URL` or `CONTACT_ALERT_WEBHOOK_URL_SECONDARY`
   - `CONTACT_SMARTCAPTCHA_REQUIRED=true`
   - `SMARTCAPTCHA_CLIENT_KEY` (public key served at runtime, never baked into the image)
   - `SMARTCAPTCHA_SERVER_KEY` (secret, VPS env only)
   - `SMARTCAPTCHA_ALLOWED_HOSTS` (exact hostnames also enabled in Yandex Cloud)
   - `METRICS_ADMIN_TOKEN`
   - `DEPLOY_SMOKE_BASE_URL`
2. Run release gates.
   ```bash
   npm run check:runtime-config
   npm run check:prod-runtime
   npm run check:deployed-runtime
   ```
3. Verify DNS and mail records before go-live.
   Required:
   - SPF record published
   - DKIM selector published and validated with provider
   - DMARC policy published
   - production domain resolves to the active deployment
4. Verify external ownership tasks.
   Required:
   - Yandex Webmaster ownership confirmed
   - Yandex Business ownership confirmed
   - `PUBLIC_YANDEX_VERIFICATION` value matches deployed head tag

## Deploy

1. Keep the worker unpaused before the deploy smoke unless there is an active incident.
   Worker pause flag:
   - `CONTACT_WORKER_PAUSED=false`
2. Deploy the release artifact.
3. Run post-deploy smoke against an isolated test configuration. A fresh SmartCaptcha token is single-use: never retry a positive submission with the same token, and never use real client data in a smoke test.
   ```bash
   npm run check:deployed-runtime
   ```
4. Confirm admin health endpoints are clean.
   Required:
   - `/api/admin/health/worker` reports `webhookSecretConfigured=true`
   - `/api/admin/health/worker` reports `alertChannelConfigured=true`
   - `/api/admin/health/worker` reports `alertEndpointReachable=true`
   - `/api/admin/health/worker` reports `smartCaptchaRequired=true` and `smartCaptchaReady=true`
   - `/api/admin/health/pipeline` reports `workerPaused=false`
   - `/api/admin/health/pipeline` reports `queueDepth < queueBackpressureThreshold`
   - `/api/admin/health/pipeline` reports `dlqLastHour=0`

## Pause And Rollback

1. Pause delivery safely with config, not with process kills.
   Set:
   - `CONTACT_WORKER_PAUSED=true`
2. Re-run worker health after the config change.
   Expected:
   - worker endpoint still returns `200`
   - worker summary includes `paused=true`
   - admin worker health becomes degraded
3. Roll back the application if deploy smoke or live health fails.
4. Leave `CONTACT_WORKER_PAUSED=true` during rollback if webhook delivery is unstable.
5. After rollback, confirm:
   - contact submissions no longer return `QUEUE_BACKPRESSURE`
   - admin health no longer reports paused/backpressure unless intentionally kept on

## DLQ Replay

1. Inspect DLQ entries before replay.
   ```bash
   node scripts/dlq-cli.mjs list --limit=20
   ```
2. Pause the worker before replaying older entries.
3. Replay only after the downstream webhook receiver is healthy and dedupes by `X-Webhook-Id`.
4. Replay a single lead or a bounded batch.
   ```bash
   node scripts/dlq-cli.mjs replay --lead-id=<uuid>
   node scripts/dlq-cli.mjs replay-all --limit=20 --confirm=YES
   ```
5. Unpause the worker after replay validation.

## Downstream Webhook Contract

Receiver requirements:

- Reject requests with timestamp skew greater than `300` seconds.
- Verify `X-Hub-Signature-256` against `${timestamp}.${webhookId}.${rawBody}` using `CONTACT_WEBHOOK_SECRET`.
- Deduplicate successfully processed events by `X-Webhook-Id`.
- Treat delivery as `at-least-once` on transport and `exactly-once` only after receiver-side dedupe.

## Post-release Monitoring

Watch for the first 30-60 minutes:

- lead queue depth growth
- worker health degradation
- alert endpoint reachability failures
- retry rate spikes
- DLQ growth
- SmartCaptcha failures (all lead submissions fail closed while the service is unavailable)
- unexpected `WORKER_PAUSED` or `QUEUE_BACKPRESSURE` responses

If any of the above spikes unexpectedly:

1. Set `CONTACT_WORKER_PAUSED=true`.
2. Stabilize webhook/Redis/alerts.
3. Replay DLQ only after downstream dedupe is confirmed.
