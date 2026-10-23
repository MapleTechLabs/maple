---
title: "Self-hosting"
description: "Run Maple Local on a server or any platform that runs containers: one image with OTLP ingest, the dashboard and the query API, guarded by an ingest key and an access token."
group: "Local Mode"
order: 3
---

The same Maple Local you run on your laptop ships as a container image, `ghcr.io/mapletechlabs/maple`. Run it anywhere that can keep a container running with a persistent volume: a VPS, a home server, or a platform such as Railway, Render or Fly.io. Your applications send OTLP to it, and your team signs in to its dashboard.

It is one process with an embedded ClickHouse, so it is built for one team's telemetry on one machine: a single tenant, a single replica, and no alerting. For more than that, use [Maple Cloud](https://maple.dev).

## Run it

The image refuses to start without two secrets:

| Variable                   | Guards                                          | Who uses it                                                         |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `MAPLE_LOCAL_INGEST_KEY`   | OTLP ingest (`/v1/traces`, `/logs`, `/metrics`) | Your applications' exporters. It can write telemetry, never read it |
| `MAPLE_LOCAL_ACCESS_TOKEN` | The dashboard and the query API                 | People signing in, scripts, and `maple` CLI commands                |

Each must be at least 16 characters. Generate them with `openssl rand -hex 32`.

```bash
docker run -d --name maple \
  -p 4318:4318 \
  -v maple-data:/data \
  -e MAPLE_LOCAL_INGEST_KEY="$(openssl rand -hex 32)" \
  -e MAPLE_LOCAL_ACCESS_TOKEN="$(openssl rand -hex 32)" \
  --stop-timeout 30 \
  ghcr.io/mapletechlabs/maple:latest
```

Open `http://<host>:4318`, paste the access token, and you stay signed in for 30 days. Read the secrets back with `docker inspect maple` if you did not keep them.

With Docker Compose:

```yaml
services:
    maple:
        image: ghcr.io/mapletechlabs/maple:latest
        ports:
            - "4318:4318"
        environment:
            MAPLE_LOCAL_INGEST_KEY: ${MAPLE_LOCAL_INGEST_KEY}
            MAPLE_LOCAL_ACCESS_TOKEN: ${MAPLE_LOCAL_ACCESS_TOKEN}
        volumes:
            - maple-data:/data
        stop_grace_period: 30s
        restart: unless-stopped

volumes:
    maple-data:
```

### On a platform

Create a service from the image `ghcr.io/mapletechlabs/maple:latest` and give it:

- a persistent volume mounted at `/data`;
- the two secrets as environment variables;
- an HTTP health check on `/health`, which needs no credentials;
- exactly one instance. The store is a local database, so a second replica would not share it.

The server listens on `$PORT` when the platform sets one, and on `4318` otherwise. Platforms that terminate TLS for you work as is: the session cookie is marked `Secure` when the request arrives over HTTPS, and the dashboard works on whatever hostname the platform assigns.

Put anything reachable from the internet behind TLS. On your own server that means a reverse proxy such as Caddy or nginx in front of port 4318.

## Send telemetry

Point any OpenTelemetry exporter at the server and send the ingest key as a Bearer token:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://maple.example.com
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<ingest key>"
```

Maple's own SDKs send their ingest key the same way, so an app already set up for Maple Cloud only needs its endpoint changed. The `x-maple-ingest-key` header works too.

## Query from the CLI

Inside the container, the CLI already has the access token and finds the server:

```bash
docker exec maple maple services
docker exec maple maple traces -s checkout --errors
```

From your own machine, point the CLI at the server:

```bash
export MAPLE_LOCAL_URL=https://maple.example.com
export MAPLE_LOCAL_ACCESS_TOKEN=<access token>
maple services
```

The CLI sends the token only to the host in `MAPLE_LOCAL_URL` and to loopback.

## Data, upgrades and restarts

- Everything lives on the `/data` volume: the store, its [restore points](/docs/local-mode/checkpoints-and-archives), and the CLI's config. Back up the volume to back up Maple.
- Give the container time to stop cleanly (`--stop-timeout 30`, or `stop_grace_period`). If it is killed anyway (out of memory, a host crash), it starts again from its last restore point and keeps the damaged store beside it as `/data/.maple/data.quarantine-*`, which you can delete. Restore points are taken every 30 minutes while new data arrives, and on each start of a store that has data. A store killed before its first restore point starts empty, since there is nothing to restore. One case needs you: a container killed and then upgraded to an image with a different storage engine cannot read the old restore point and stops with an explanation. Run the previous image once to recover, or start fresh with `docker run --rm -v maple-data:/data ghcr.io/mapletechlabs/maple:latest reset --yes`.
- Run commands that change the store as the server's user: `docker exec -u 10001 maple maple checkpoint`. Read-only commands such as `maple services` can run as any user.
- To upgrade, pull the new tag and recreate the container on the same volume. Pin a version tag (`ghcr.io/mapletechlabs/maple:v0.0.30`) if you want to choose when that happens; `latest` follows each release.
- The server runs as an unprivileged user (uid 10001). A volume mounted as root is handed to that user on start.

## Rotating secrets

Change the variable and restart the container. A new access token signs every browser out; a new ingest key needs updating in every exporter. Ten failed sign-ins within a minute pause the sign-in form for everyone for the rest of that minute. Requests with the Bearer token and existing sessions keep working.

## What connects to the internet

The server sends its own traces and metrics (service `maple-cli`) to Maple by default, as described in [What connects to the internet](/docs/local-mode#what-connects-to-the-internet). Set `MAPLE_TELEMETRY=off` to turn that off. Your telemetry never leaves the server. The image does not check for updates.
