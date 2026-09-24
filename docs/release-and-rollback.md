# Application release and rollback runbook

This runbook changes only the MBL application layer: `mbl-web`,
`mbl-worker-trigger` and `mbl-nginx`. Redis is not a release target. Its
container, image and external volume are captured before every operation and
must be identical afterwards.

## Two separate recovery operations

- **Rollback** selects the previous application images. It does not read or
  restore a Redis backup.
- **Restore** rebuilds Redis data in a new isolated volume from an encrypted
  backup. It follows `backup-restore-runbook.md` and is never started by the
  release tool.

Do not combine these operations. A bad application release is not evidence of
lost Redis data.

## Release artifact contract

A release bundle can only be created from a clean committed working tree. Its
release ID is the full 40-character Git SHA. The bundle contains:

- exact Linux web, Nginx and backup images saved as Docker archives;
- the image IDs and OCI revision labels in `manifest.json`;
- production, backup and release-only Compose files;
- the release policy and this tool/runbook;
- `SHA256SUMS` covering every bundled file.

The release overlay removes all build definitions and sets `pull_policy:
never`. Deployment on the VPS therefore cannot silently rebuild source or pull
a moving application tag.

Create a bundle on the trusted build host. Populate every key listed in
`config/public-build-env.json` in a dedicated public build environment file;
the release command rejects missing values and never forwards unlisted
variables. These values are embedded in public HTML and must contain no
runtime credentials.

```sh
set -a
. /secure/config/mbl-public-build.env
set +a
npm run release:bundle -- --output /secure/export/mbl
```

The public build file must explicitly provide the canonical origin, analytics
and webmaster identifiers, approved contact/address/legal details and public
links. Docker Compose uses the same allowlist for a source build. Runtime-only
secrets remain in the separate mode-0600 production environment file and must
not be present in the public build file, Docker build arguments or bundle.

The normal command runs the production Compose gate against the built SHA
images before it writes the bundle. `--skip-runtime-gate` exists only for an
explicitly authorised diagnostic and is not a release procedure.

Transfer the complete SHA-named directory to the VPS over an authenticated
channel. Never add `prod.env`, TLS keys, backup credentials or admin tokens to
the bundle. Verify it before any Docker mutation:

```sh
npm run release:verify -- --bundle /opt/mbl/incoming/<full-sha>
```

## One-time VPS preparation

Prepare the production environment file and external Redis volume separately:

```sh
sudo install -d -m 0700 /opt/mbl/runtime /opt/mbl/incoming
sudo install -d -o 1000 -g 1000 -m 0750 /opt/mbl/runtime/backup-status
sudo install -m 0600 /path/to/prod.env /opt/mbl/runtime/deploy.env
docker volume create mbl-production-redis-data
```

The pinned Redis image is provisioned during the initial production bootstrap,
not by an application release. Start Redis once from the verified bundle's
Compose envelope. All later release and rollback commands require it to be
healthy already and refuse to target it.

The environment file must keep the stable volume identity:

```dotenv
MBL_REDIS_VOLUME_NAME=mbl-production-redis-data
MBL_REDIS_VOLUME_EXTERNAL=true
MBL_BACKUP_STATUS_DIR=/opt/mbl/runtime/backup-status
```

On Linux, the release tool rejects an environment file readable by group or
other users. The tool also pins Compose's `MBL_ENV_FILE` interpolation to the
exact `--env-file` path; a stale shell variable cannot redirect containers to
a different secrets file.

## Apply a release

```sh
node /opt/mbl/incoming/<full-sha>/scripts/release-tool.mjs apply \
  --bundle /opt/mbl/incoming/<full-sha> \
  --runtime-root /opt/mbl/runtime \
  --env-file /opt/mbl/runtime/deploy.env \
  --base-url http://127.0.0.1:8080
```

The tool performs these bounded steps:

1. verifies all bundle checksums and the release manifest;
2. loads the exact local image archives and verifies their immutable IDs;
3. records the Redis container, image and volume IDs;
4. writes a durable `release-operation.json` journal before the first container
   mutation;
5. stops the worker, replaces web, then Nginx, using `--no-deps --no-build
--pull never`;
6. checks container health, readiness and representative public routes;
7. starts the worker and requires a successful cycle timestamp newer than that
   worker container's own start time;
8. proves the Redis identity is unchanged and records current/previous release
   state atomically;
9. atomically points `/opt/mbl/runtime/current` at that exact stored release so
   systemd backup/retention jobs use the same committed Compose bundle.

If a candidate fails, the tool restores the previously recorded application
images. If that recovery also fails, it stops the entire application layer so
the host cannot continue serving a random mixture of versions. Redis remains
running and untouched. The failure is written to
`last-release-failure.json` without environment secrets.

If the release process is killed or the host restarts between phases, the
journal and stale process lock remain. The next `apply` or `rollback` command
first reconciles the recorded stable release (or stops the application layer
when no stable release exists), verifies Redis image and volume identity, clears
the journal, and exits. Rerun the requested command only after that explicit
reconciliation. The tool never continues a new release on top of a mixed
interrupted state.

## Roll back application code

```sh
node /opt/mbl/runtime/releases/<current-sha>/scripts/release-tool.mjs rollback \
  --runtime-root /opt/mbl/runtime \
  --env-file /opt/mbl/runtime/deploy.env \
  --base-url http://127.0.0.1:8080
```

Rollback uses the previously verified bundle stored under
`/opt/mbl/runtime/releases/`. It swaps the current and previous application
records and the stable `current` symlink, enabling an explicit roll-forward if
required. It never runs the backup container and never calls the Redis restore
command.

After either operation, verify:

```sh
cat /opt/mbl/runtime/release-state.json
readlink -f /opt/mbl/runtime/current
docker compose --project-name mbl-production \
  --env-file /opt/mbl/runtime/deploy.env \
  --file /opt/mbl/runtime/releases/<active-sha>/compose.production.yml \
  --file /opt/mbl/runtime/releases/<active-sha>/compose.backup.yml \
  --file /opt/mbl/runtime/releases/<active-sha>/compose.release.yml ps
```

Keep at least the current and previous verified bundles and their image
archives. Deleting the previous bundle removes the deterministic rollback
target and must be treated as a separate retention operation.

## Evidence gate

`npm run check:release-rollback` executes an isolated A → B → A drill. It
proves that a queued Redis lead survives deploy and rollback, all three
application services return to the previous image IDs, Redis container/image/
volume identity never changes, a failed candidate is automatically contained,
forced interruption during both web replacement and worker startup is
reconciled, an interrupted rollback during Nginx replacement returns to its
recorded stable version, corrupt bundles are rejected before mutation and logs
do not expose the test secret.
