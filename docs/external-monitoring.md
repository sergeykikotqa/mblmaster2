# External production monitoring and Telegram

This is the O2.4.3 monitoring contract for MBL. The probe and Telegram
notification adapter run on a server that is independent of the primary MBL
VPS and independent of GitHub. GitHub stores source code and may run
development checks, but it is not a production scheduler, notification relay
or secret store.

The monitor never creates a synthetic lead and never calls a worker endpoint.

## Architecture and failure boundary

Every five minutes, the independent host runs `scripts/external-monitor.mjs`.
The probe checks a strict parent-to-child hierarchy:

1. TLS validity and certificate expiry;
2. the public homepage through the real edge/Nginx entry point;
3. `/health/live`;
4. `/health/ready`, including Redis readiness;
5. bearer-protected `/api/monitoring/health` for worker heartbeat, oldest
   pending lead, delivery-pipeline state and backup freshness.

If the edge fails, deeper checks are skipped. If readiness fails, operational
worker checks are skipped. This prevents one failure from opening a cascade of
misleading child incidents. TLS expiry remains an independent warning.

The probe sends safe success/failure signals to a separate dead-man/incident
receiver and uses the Telegram adapter for owner notifications. If Telegram is
unavailable, the probe and dead-man signal continue. A Telegram delivery
failure is reported as a safe incident code and retried with a bounded delay.

The design must keep working when the primary MBL VPS and GitHub are both
unavailable. The monitoring host, dead-man receiver and Telegram must not be
hosted inside the primary MBL Docker/VM failure boundary.

## Telegram incident lifecycle

Telegram uses the existing monitor result and incident codes. It does not
perform a second health assessment.

- A new incident sends one Russian-language notification.
- Continued failure is suppressed until the explicit escalation interval
  (default: six hours).
- Recovery sends one notification and closes the local incident lifecycle.
- A later failure starts a new lifecycle and sends a new notification.
- Failed delivery is retried no sooner than the configured retry interval
  (default: five minutes); retries per HTTP attempt are bounded.

State is stored atomically in
`/var/lib/mbl-monitor/telegram-state.json`, mode `0600`. It contains only safe
incident codes and timestamps. It never contains bot tokens, Chat IDs, lead
data, URLs, backup identifiers or response bodies.

Telegram messages may contain the fault class, detection/recovery time,
duration and safe aggregate status. They must never contain names, phone
numbers, customer messages, Redis URLs, webhook/HMAC secrets, monitoring
tokens, Telegram credentials or backup contents.

## Independent host installation

Use a small Linux host or an approved monitoring provider outside the primary
VPS. Node.js 22 and `flock` are required. Copy a reviewed committed monitor
release to `/opt/mbl-monitor/current`; do not execute a mutable Git working
tree as production state.

Create the service account and secret file:

```sh
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin mbl-monitor
sudo install -d -o root -g mbl-monitor -m 0750 /etc/mbl-monitor
sudo install -o root -g mbl-monitor -m 0640 \
  ops/external-monitoring/monitor.env.example /etc/mbl-monitor/monitor.env
sudoedit /etc/mbl-monitor/monitor.env
```

Install and start the timer:

```sh
sudo install -m 0644 ops/external-monitoring/systemd/mbl-external-monitor.service /etc/systemd/system/
sudo install -m 0644 ops/external-monitoring/systemd/mbl-external-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mbl-external-monitor.timer
sudo systemctl start mbl-external-monitor.service
sudo systemctl status mbl-external-monitor.service mbl-external-monitor.timer
```

Systemd creates the persistent state and runtime lock directories. The service
runs without root privileges, with a read-only OS view except for
`/var/lib/mbl-monitor`, and prevents overlapping probes.

## Secrets and configuration

Store these values only in `/etc/mbl-monitor/monitor.env` (or the equivalent
secret store of the independent provider):

- `MBL_MONITOR_TOKEN`: dedicated bearer token also installed on the MBL VPS;
- `MBL_MONITOR_SUCCESS_URL` and `MBL_MONITOR_FAILURE_URL`: private independent
  receiver URLs;
- `TELEGRAM_BOT_TOKEN`: current BotFather token for `@MBL_Monitor_38_bot`;
- `TELEGRAM_CHAT_ID`: owner Chat ID after `/start` was sent to the bot.

Do not reuse `METRICS_ADMIN_TOKEN`, worker tokens or webhook secrets. Do not
copy the developer file `C:\Users\adida\Desktop\mbl-secrets\telegram.env` to
the repository, an image or a release bundle. That path is only a local test
input and is not a production dependency.

The signal receiver origin must differ from the monitored site origin. It must
open/deduplicate failures, close recovery, and alert when no success ping is
received for 12–15 minutes. Configure at least one contact path independent of
the direct Telegram adapter so a broken bot token or dead monitoring host is
still detectable.

## Telegram Admin Read-Only v1

Owner commands run on the same independent monitoring host and use the same
bot. The incident notifier only sends messages and does not consume Telegram
updates. `mbl-telegram-admin.service` is the single `getUpdates` consumer; a
dedicated `flock` plus its durable offset prevent parallel polling and replay
after restart. Do not configure a Telegram webhook or another polling process
for this bot while this service is active.

The available commands are `/today`, `/week`, `/funnel` and `/status`.
Commands are accepted only when both `message.from.id` and the private
`message.chat.id` match the configured owner IDs. Group messages and unknown
senders receive no response. Commands cannot read lead records or invoke any
admin, worker, shell, delivery or Redis operation.

`/today`, `/week` and `/funnel` call the minimal read-only endpoint
`/api/monitoring/owner-metrics` with `MBL_OWNER_METRICS_TOKEN`. The credential
must be strong and different from `METRICS_ADMIN_TOKEN` and
`MBL_MONITORING_TOKEN`; install it only in the MBL production secret file and
the independent monitor secret file. The monitoring host never connects to
Redis directly.

Periods are assembled from retained UTC hour buckets. Irkutsk midnight is
16:00 UTC, so the hour boundaries align exactly: today begins at local 00:00,
and the week begins Monday at local 00:00. Expired history is not interpreted
as zero. The default hourly retention is 14 days, which covers the current
week; the API returns an explicit incomplete result if configured retention is
too short.

These are deliberately labelled local funnel events, not unique visitors or
whole-site traffic. Current collection includes trusted public routes.
`page_view` and `form_opened` require analytics consent, while
`form_submitted` is recorded after every new lead from a supported page is
durably accepted, regardless of analytics consent. Historical
consent/tracking coverage is not stored, so the bot always explains this
limitation and never merges these values with Yandex Metrika.

The funnel prints the raw counters with their capture scope. Conversion
percentages are deliberately not calculated because consent-gated views and
form openings are not a compatible denominator for all server-accepted leads.
Every conversion object therefore returns `compatible=false`, `rate=null` and
an explicit reason instead of a misleading percentage.

`/status` reads `/var/lib/mbl-monitor/status-snapshot.json`, written atomically
after every independent probe. It does not call the primary VPS. If the latest
observation is older than ten minutes, the response says that it is stale.
Failure of this convenience snapshot never changes probe, dead-man or incident
notification results.

Install and enable the command timer separately from the five-minute probe:

```sh
sudo install -m 0644 ops/external-monitoring/systemd/mbl-telegram-admin.service /etc/systemd/system/
sudo install -m 0644 ops/external-monitoring/systemd/mbl-telegram-admin.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mbl-telegram-admin.timer
```

Required independent-host values are `MBL_TELEGRAM_ADMIN_USER_ID`,
`MBL_TELEGRAM_ADMIN_CHAT_ID`, `MBL_OWNER_METRICS_TOKEN`,
`MBL_TELEGRAM_ADMIN_STATE_FILE` and `MBL_MONITOR_STATUS_FILE`. Keep
`monitor.env` root-owned and unreadable by other users. Test locally with mocks
using `npm run check:telegram-admin`. After a production build,
`npm run check:owner-metrics-runtime` verifies the protected API against a
disposable Docker Redis. Live commands and the independent-host installation
remain a separate production acceptance step.

## GitHub production workflow retirement

The following legacy production workflows were removed from the source tree
and must also be disabled/deleted from the repository default branch before
public launch:

- `external-production-monitor.yaml` — GitHub-scheduled production probe;
- `lead-worker-cron.yaml` — public worker trigger, obsolete because the worker
  runs inside the production Compose envelope;
- `metrics-health-cron.yaml` — public metrics-health worker trigger;
- `metrics-snapshot-cron.yaml` — public metrics snapshot worker trigger.
- `actions.yaml` / `check-production` — push-triggered deployed-runtime smoke
  that carried production secrets and invoked contact/worker APIs.

Their repository secrets and variables must be deleted after confirming no
other workflow references them. The development-only nightly quality workflow
may remain because it neither calls the production worker nor carries
production monitoring/Telegram credentials.

## Tests and production proof

Local deterministic gates:

```sh
npm run check:external-monitor
npm run check:telegram-monitor
npx vitest run tests/monitoring-health.test.ts tests/external-monitor-policy.test.ts
```

A one-time local delivery test may load the owner-managed file without copying
it into the repository:

```powershell
node --env-file="C:\Users\adida\Desktop\mbl-secrets\telegram.env" scripts/test-telegram-delivery.mjs
```

Run it only after confirming that the BotFather token was rotated after any
exposure and the owner sent `/start` to the bot. It sends exactly this safe
message and does not create an incident:

`MBL Monitor: тестовое уведомление. Связь с Telegram работает`

Before public launch, capture evidence from the independent host for:

1. healthy probe and dead-man success signal;
2. stopped Nginx → one outage message → one recovery message;
3. stopped Redis → readiness/Redis message without child-alert noise;
4. stale worker heartbeat → delivery-delay message → recovery;
5. critical pending age and stale backup classifications;
6. Telegram/API failure while probing and dead-man signalling continue;
7. monitor host outage detected by the independent dead-man receiver;
8. logs, state and notifications containing no secrets or lead PII.

Use a reversible maintenance window. Do not submit a production lead as a
monitoring canary. Record UTC timestamps, incident/recovery times and the exact
monitor release SHA. Local and developer-machine delivery tests do not prove
production readiness until this end-to-end drill succeeds from the independent
host.
