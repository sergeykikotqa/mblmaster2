# External production monitoring

This is the O2.4.3 monitoring contract for MBL. The probe runs outside the VPS,
uses only read-only HTTP requests, and reports both failures and recovery to an
independent incident/dead-man service. It never creates a synthetic lead and
never calls a worker endpoint.

## What is monitored

The probe checks a strict parent-to-child hierarchy every five minutes:

1. TLS validity and certificate expiry;
2. the public homepage through the real edge/Nginx entry point;
3. `/health/live`;
4. `/health/ready`, including Redis readiness;
5. bearer-protected `/api/monitoring/health` for worker heartbeat, oldest
   pending lead, delivery-pipeline state and backup freshness.

If an edge check fails, deeper application checks are skipped. If readiness
fails, worker/pipeline checks are skipped. This prevents one Redis or edge
incident from producing a misleading cascade of child alerts. TLS expiry is a
parallel warning and does not suppress application checks.

The protected endpoint returns only bounded technical status and incident
codes. It does not return lead fields, Redis URLs, backup paths, snapshot IDs,
checksums or secrets. HTTP `200` means every strict check is healthy; `503`
means at least one incident is active.

Initial thresholds:

- TLS warning: 30 days remaining;
- TLS critical: 14 days remaining;
- backup stale: more than 8,100 seconds after the last successful hourly
  backup (two hours plus 15 minutes for timer jitter);
- backup clock-skew tolerance: five minutes;
- worker and queue thresholds: the existing production worker-health settings.

## Independent alert receiver

The GitHub workflow alone is not the alerting system. Scheduled GitHub Actions
can be delayed or disabled and run only from the repository's default branch.
The configured receiver must therefore:

- live outside the MBL VPS and outside the application containers;
- accept a success URL and a failure URL over HTTPS;
- open/deduplicate an incident for a failure signal;
- close or mark the incident recovered after a later success signal;
- alert when no success signal arrives for 12-15 minutes;
- notify at least two maintained operator channels;
- retain an audit trail without storing the URL secrets in notifications.

Use a provider and notification path approved for the Russian production
perimeter. Provider configuration is operational state, not repository code.

## Production configuration

Generate one random monitoring token of at least 32 bytes. Store the same value
in two secret stores only:

- VPS `prod.env`: `MBL_MONITORING_TOKEN`;
- GitHub Actions secret: `PRODUCTION_MONITOR_TOKEN`.

Do not reuse `METRICS_ADMIN_TOKEN`, a worker token or an alert-webhook token.
The monitoring route deliberately ignores the admin IP allowlist and requires
its dedicated bearer token.

Configure these repository values on the default branch:

| Kind     | Name                             | Purpose                                                                                |
| -------- | -------------------------------- | -------------------------------------------------------------------------------------- |
| Variable | `PRODUCTION_MONITOR_BASE_URL`    | Canonical public HTTPS origin                                                          |
| Secret   | `PRODUCTION_MONITOR_TOKEN`       | Dedicated route bearer token                                                           |
| Secret   | `PRODUCTION_MONITOR_SUCCESS_URL` | Private receiver success URL                                                           |
| Secret   | `PRODUCTION_MONITOR_FAILURE_URL` | Private receiver failure URL                                                           |
| Variable | `MBL_BACKUP_STATUS_DIR`          | Optional override; defaults to `/opt/mbl/runtime/backup-status` in the production gate |

The signal receiver origin must differ from the monitored site origin. The
probe sends a stable incident fingerprint, safe incident codes, target host and
GitHub run URL. It does not forward response bodies.

The backup checkpoint directory is shared by numeric UID/GID 1000: the one-shot
backup container writes it and the web container mounts it read-only:

```sh
sudo install -d -o 1000 -g 1000 -m 0750 /opt/mbl/runtime/backup-status
```

Set `MBL_BACKUP_STATUS_DIR=/opt/mbl/runtime/backup-status` in
`/opt/mbl/runtime/deploy.env`. Keep the directory outside release bundles so a
deploy or rollback cannot erase the last-success checkpoint.

## Activation and proof

The workflow can be dispatched manually after it exists on the default branch.
Before public launch, capture evidence for all of the following from a real
external runner and the target VPS:

1. healthy run sends a success signal;
2. stopping Nginx opens an edge incident and recovery closes it;
3. stopping Redis opens a readiness incident without child-alert noise;
4. stopping the worker produces `WORKER_HEARTBEAT_STALE` after its configured
   threshold and recovery closes it;
5. an intentionally stale test checkpoint produces `BACKUP_STALE`, then a real
   successful off-host backup clears it;
6. an invalid bearer token is rejected without exposing details;
7. disabling the workflow or withholding success pings triggers the receiver's
   dead-man alert;
8. notification messages contain no bearer token, signal URL, lead data or
   backup identifiers.

Use a reversible maintenance window and the incident provider's test contacts.
Do not submit a production lead as a monitoring canary. Record UTC timestamps,
GitHub run URLs, incident open/recovery times and the exact release SHA.

Local gates prove the mechanism only:

```sh
npm run check:external-monitor
npx vitest run tests/monitoring-health.test.ts tests/external-monitor-policy.test.ts
```

O2.4.3 is production-proven only after the external provider, default-branch
schedule, real notification channels and VPS failure/recovery drill have all
been observed. A local PASS is not a substitute for that evidence.
