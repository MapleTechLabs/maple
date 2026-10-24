---
title: "Self-hosting"
description: "Run Maple on your own server or any platform that runs containers: one image with OTLP ingest, the dashboard and the query API, guarded by an ingest key and an access token."
group: "Self-hosting"
order: 1
navLabel: "Overview"
---

[Maple Local](/docs/local-mode), the same Maple you can run on your laptop, ships as a container image: `ghcr.io/mapletechlabs/maple`. Run it anywhere that can keep a container running with a persistent volume, such as a VPS, a home server, or a platform like Railway, Render or Fly.io. Your applications send OTLP to it, and your team signs in to its dashboard.

## What you get

- **One container, one port.** OTLP ingest, the dashboard, the query API and the `maple` CLI, backed by an embedded ClickHouse. No separate database to run.
- **Your data stays on your server.** Everything lives on one volume, which you back up like any other.
- **Two secrets guard it.** An ingest key for your applications and an access token for people and scripts. The image refuses to start without them.

It is built for one team's telemetry on one machine: a single tenant, a single replica, and no alerting. For more than that, use [Maple Cloud](https://maple.dev).

## The two secrets

| Variable                   | Guards                                          | Who uses it                                                         |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `MAPLE_LOCAL_INGEST_KEY`   | OTLP ingest (`/v1/traces`, `/logs`, `/metrics`) | Your applications' exporters. It can write telemetry, never read it |
| `MAPLE_LOCAL_ACCESS_TOKEN` | The dashboard and the query API                 | People signing in, scripts, and `maple` CLI commands                |

Each must be at least 16 characters. Keeping them separate means the ingest key, which ends up in every service's config, cannot be used to read your telemetry.

## Quick start

Generate both secrets and keep them somewhere safe, such as your password manager:

```bash
export MAPLE_LOCAL_INGEST_KEY="$(openssl rand -hex 32)"
export MAPLE_LOCAL_ACCESS_TOKEN="$(openssl rand -hex 32)"
echo "ingest key:   $MAPLE_LOCAL_INGEST_KEY"
echo "access token: $MAPLE_LOCAL_ACCESS_TOKEN"
```

Start the container:

```bash
docker run -d --name maple \
  -p 4318:4318 \
  -v maple-data:/data \
  -e MAPLE_LOCAL_INGEST_KEY \
  -e MAPLE_LOCAL_ACCESS_TOKEN \
  --stop-timeout 30 \
  --restart unless-stopped \
  ghcr.io/mapletechlabs/maple:latest
```

Open `http://<host>:4318` and sign in with the access token.

This serves plain HTTP on every interface, which is fine on a private network. On a machine reachable from the internet, publish the port on loopback only (`-p 127.0.0.1:4318:4318`) and put [a TLS proxy](/docs/self-hosting/deploy#behind-a-reverse-proxy) in front, so the access token and ingest key never cross the internet unencrypted.

## Next steps

- [Deploy](/docs/self-hosting/deploy): Docker Compose, container platforms (with one-click deploy to Render), and TLS with a reverse proxy.
- [Connect](/docs/self-hosting/connect): send telemetry, sign in, and query from the CLI.
- [Operations](/docs/self-hosting/operations): backups, upgrades, crash recovery and rotating secrets.
