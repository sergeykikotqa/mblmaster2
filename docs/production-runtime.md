# MBL production runtime envelope

`compose.production.yml` is the production authority for the O2.3 runtime. It
starts only Nginx, Astro Node, the local worker trigger and Redis. Only Nginx
publishes a host port; Node, the worker endpoint and Redis remain private.

## One-time host preparation

Keep runtime secrets outside the repository and Docker images:

```sh
sudo install -d -m 0700 /opt/mbl/secrets
sudo install -m 0600 .env.example /opt/mbl/secrets/prod.env
sudoedit /opt/mbl/secrets/prod.env
sudo chmod 0600 /opt/mbl/secrets/prod.env
```

Replace every placeholder before deployment. Never commit `prod.env`, pass it
as a build argument, or print it in CI logs.

## Deterministic build and start

Build and tag both application images with the exact Git revision:

```sh
export MBL_IMAGE_TAG="$(git rev-parse HEAD)"
export MBL_ENV_FILE=/opt/mbl/secrets/prod.env
export PUBLIC_SITE_URL=https://mebel-irkutsk.ru
export MBL_BIND_ADDRESS=0.0.0.0
export MBL_HTTP_PORT=8080

docker compose -f compose.production.yml config --quiet
docker compose -f compose.production.yml build
docker compose -f compose.production.yml up -d --no-build
docker compose -f compose.production.yml ps
```

The image label `org.opencontainers.image.revision` and image tag both contain
`MBL_IMAGE_TAG`. The pinned build/runtime base is Node 22.22.0 on Alpine 3.23.
Do not reuse a tag for different source.

The O2.3 container listens on HTTP port 8080. TLS certificate installation and
the final VPS firewall/system integration belong to the deployment rehearsal;
they are not represented as completed here.

Canonical-host redirects are keyed by both Nginx's own `$scheme` and `$host`.
This preserves the policy distinction between the canonical HTTP origin and its
HTTPS origin and avoids a loop when TLS is later terminated by this Nginx. Do
not place an unconfigured TLS terminator in front and trust arbitrary client
`X-Forwarded-Proto`; that proxy chain requires an explicit trusted-proxy policy.

## Runtime boundaries

- Nginx is the only service with a published port.
- `/api/workers/*` is blocked at the public edge; the trigger calls Astro over
  the private backend network.
- Redis has AOF (`everysec`), periodic RDB snapshots, `noeviction` and a
  pre-created external persistent volume. The external volume is intentionally
  immune to `docker compose down -v`.
- Web, worker, Redis and Nginx use read-only root filesystems. Nginx alone gets
  a small `/tmp` tmpfs for its PID and request/proxy buffers.
- The test-only `compose.runtime-test.yml` overlay adds host-gateway resolution
  for a local mock webhook. It is not part of production startup.

The one-shot encrypted off-host backup and isolated restore procedure lives in
[`backup-restore-runbook.md`](backup-restore-runbook.md). A persistent volume,
AOF and provider snapshot are still not substitutes for a tested Restic
restore from separate object storage.
