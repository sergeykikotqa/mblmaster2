# Redis backup and restore runbook

This runbook is the O2.4.1 reliability contract for MBL. Redis contains lead
PII, idempotency state, the delivery queue, locks, DLQ entries and aggregate
metrics. A local AOF or VPS snapshot is useful, but neither is an off-host
backup.

## Safety invariants

- The backup job is one-shot; it is not a fifth permanently running service.
- It connects to Redis over `mbl-backend` and never mounts the production Redis
  volume.
- `redis-cli --rdb` produces a consistent RDB in container `tmpfs`.
- `redis-check-rdb` must pass before Restic receives the snapshot.
- Restic encrypts and authenticates data before it leaves the container.
- Plaintext RDB data disappears with the one-shot container.
- Automated restore writes only below `/restore/<drill-id>`. It can never write
  to `/data` or the active Redis volume.
- Application rollback and Redis restore are separate operations.
- `data/lead-backup.ndjson` is a forensic log, not a Redis backup.

The initial retention policy is 24 hourly, 7 daily and 4 weekly snapshots.
The hourly timer gives a target RPO of one hour. Record the measured restore
time from every drill as the current RTO evidence.

## Required off-host repository

Choose a private S3-compatible object-storage bucket in the approved Russian
production perimeter. Public access must be disabled. Use a credential scoped
to a dedicated bucket prefix and enable provider-side version expiry so removed
Restic packs do not retain PII indefinitely.

Create a root-owned directory on the VPS:

```text
/opt/mbl/secrets/backup/
├── repository
├── password
├── s3-access-key
└── s3-secret-key
```

All files and the directory must be readable only by root. File contents:

- `repository`: `s3:https://<endpoint>/<bucket>/<prefix>`;
- `password`: a long random Restic repository password;
- `s3-access-key`: object-storage access key;
- `s3-secret-key`: object-storage secret key.

Keep the Restic password in at least two independent offline locations. Losing
it makes every snapshot unrecoverable. Never place these values in Git,
`deploy.env`, a command line, a Docker image or monitoring output.

The production configuration must also provide:

```text
MBL_BACKUP_SECRET_DIR=/opt/mbl/secrets/backup
MBL_BACKUP_STATUS_DIR=/opt/mbl/runtime/backup-status
MBL_BACKUP_RESTORE_DIR=/opt/mbl/runtime/restore
MBL_BACKUP_S3_REGION=<provider-region>
```

Plain HTTP S3 endpoints are rejected.

## First installation

Create the production data volume before starting the stack. It is external so
that `docker compose down -v` cannot delete it:

```bash
docker volume create mbl-production-redis-data
```

Build the backup image from the same clean release SHA as the application, then
initialize an empty repository exactly once:

```bash
export MBL_BACKUP_INIT_CONFIRM=INITIALIZE_EMPTY_REPOSITORY
docker compose --env-file /opt/mbl/runtime/deploy.env \
  -f compose.production.yml -f compose.backup.yml \
  --profile backup run --rm --no-deps mbl-backup init
unset MBL_BACKUP_INIT_CONFIRM
```

Initialization must fail if the repository already exists. Do not solve an
unexpected password/repository error by initializing another repository.

Install the units from `ops/systemd/` and enable the timers:

```bash
systemctl enable --now mbl-redis-backup.timer
systemctl enable --now mbl-redis-retention.timer
systemctl enable --now mbl-redis-backup-check.timer
```

The timers run hourly backup, daily retention, and a weekly repository data
check. Systemd and `flock` prevent maintenance operations from overlapping.

## Normal verification

After a backup, verify all of the following:

1. `mbl-redis-backup.service` exited successfully.
2. `/opt/mbl/runtime/backup-status/last-success.json` has a recent timestamp.
3. `list` returns a new snapshot for host `mbl-production`.
4. No plaintext RDB remains on the host.
5. The external monitor has not reported a stale backup checkpoint.

The status JSON contains only technical metadata: snapshot ID, release SHA,
size and checksum. It contains no lead fields.

## Restore drill

Run at least monthly and after changing Redis, Restic, object storage, retention
or credentials. A drill never targets the active volume.

Select a snapshot, prepare a new empty host directory under the configured
restore root, and run:

```bash
export MBL_BACKUP_RESTORE_CONFIRM=RESTORE_TO_ISOLATED_DIRECTORY
docker compose --env-file /opt/mbl/runtime/deploy.env \
  -f compose.production.yml -f compose.backup.yml \
  --profile backup run --rm --no-deps mbl-backup \
  restore --snapshot <snapshot-id> --target /restore/<drill-id>
unset MBL_BACKUP_RESTORE_CONFIRM
```

The job verifies the encrypted repository, manifest SHA-256, RDB size and
`redis-check-rdb` before writing the isolated output.

Create a new drill volume, copy the restored `dump.rdb` into it, and start a
separate Redis container with no production network aliases or published port.
Verify at minimum:

- Redis `PING`;
- representative lead records;
- pending queue and pending-age index;
- idempotency keys and TTL;
- DLQ and metrics keys when present.

Record snapshot ID, start/end time, RTO, key counts and result. Destroy only
resources carrying the explicit drill prefix after the evidence is saved.

`npm run check:backup-restore` performs this isolated drill locally with
generated non-production values. It deletes its source data before restoring,
rejects a wrong password and a corrupted RDB, and verifies restored strings,
hashes, sorted sets and TTL.

## Disaster recovery switchover

Do not perform these steps for an ordinary application rollback.

1. Stop `mbl-worker-trigger` and `mbl-web` so no writes occur.
2. Preserve the old Redis volume unchanged and record its exact name.
3. Restore the selected snapshot to an isolated directory and validate it.
4. Create a new external volume with a unique recovery name.
5. Copy only the validated `dump.rdb` into that new volume.
6. Start an isolated Redis against the new volume and verify invariants.
7. Compare the snapshot time with downstream CRM/webhook records. A restored
   queue may contain events delivered after the snapshot; receiver-side dedupe
   by stable webhook/lead ID is mandatory before restarting the worker.
8. Change `MBL_REDIS_VOLUME_NAME` to the new volume and start Redis, web and
   worker in that order.
9. Run readiness, admin health and a bounded lead canary.
10. Keep the old volume through the agreed quarantine period. Never remove it
    during the same incident.

There is deliberately no command that overwrites the active volume or silently
switches production. Human approval is required after isolated validation.

## Remaining operational proof

The repository supplies and locally tests the mechanism. O2.4 is not fully
production-proven until an approved object-storage account is configured and a
restore drill is completed from that real off-host repository on the target
VPS. Provider/VPS snapshots remain a second, independent recovery layer.
