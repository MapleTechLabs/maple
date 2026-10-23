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

Each must be at least 16 characters. Generate both and keep them somewhere safe, such as your password manager:

```bash
export MAPLE_LOCAL_INGEST_KEY="$(openssl rand -hex 32)"
export MAPLE_LOCAL_ACCESS_TOKEN="$(openssl rand -hex 32)"
echo "ingest key:   $MAPLE_LOCAL_INGEST_KEY"
echo "access token: $MAPLE_LOCAL_ACCESS_TOKEN"
```

Then start the container:

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

Open `http://<host>:4318` and sign in with the access token. If you lose the secrets, `docker inspect maple` shows them.

With Docker Compose, put the two secrets in a `.env` file next to `compose.yaml`:

```bash
# .env
MAPLE_LOCAL_INGEST_KEY=<ingest key>
MAPLE_LOCAL_ACCESS_TOKEN=<access token>
```

```yaml
# compose.yaml
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

### Behind a reverse proxy

Put anything reachable from the internet behind TLS. On your own server, run a reverse proxy in front of port 4318. With [Caddy](https://caddyserver.com), which gets a certificate for you, the whole config is:

```
maple.example.com {
	reverse_proxy localhost:4318
}
```

Any other proxy works too if it forwards the `Host` header unchanged and sets `X-Forwarded-Proto`. Then publish the container on loopback only (`-p 127.0.0.1:4318:4318`) so it is reachable only through the proxy.

## Signing in

Everyone signs in with the same access token. A sign-in lasts 30 days in that browser. There are no separate user accounts: to remove someone's access, rotate the token (see [Rotating secrets](#rotating-secrets)).

Ten failed sign-ins within a minute pause the sign-in form for everyone for the rest of that minute. Browsers already signed in, and scripts sending the token as a Bearer header, keep working.

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

The CLI sends the token only to the host in `MAPLE_LOCAL_URL` (over the same scheme, so an `https` URL never gets it over plain `http`) and to this machine's own addresses.

## Data, upgrades and restarts

- Everything lives on the `/data` volume: the store, its [restore points](/docs/local-mode/checkpoints-and-archives), and the CLI's config. Back up the volume to back up Maple.
- Give the container time to stop cleanly: `--stop-timeout 30`, or `stop_grace_period` in Compose.
- Run commands that change the store as the server's user: `docker exec -u 10001 maple maple checkpoint`. Read-only commands such as `maple services` can run as any user.
- To upgrade, pull the new image and recreate the container on the same volume. `latest` follows each stable release; pin a release tag (`ghcr.io/mapletechlabs/maple:<version>`) if you want to choose when you upgrade.
- The server runs as an unprivileged user (uid 10001). A volume mounted as root is handed to that user on start.

### If the container is killed

When the container is killed before it can stop cleanly (out of memory, a host crash), it starts again from its last restore point. It moves the damaged store aside as `/data/.maple/data.quarantine-*`, which you can delete once Maple is running again.

Restore points are taken on each start of a store that has data, and every 30 minutes while new data arrives. So a kill loses at most the data since the last one. A store killed before its first restore point starts empty, since there is nothing to restore.

One case needs you: a container killed and then upgraded to an image with a different storage engine cannot read the old restore point, and stops with an explanation. Run the previous image once to recover, or start fresh with:

```bash
docker run --rm -v maple-data:/data \
  ghcr.io/mapletechlabs/maple:latest reset --yes
```

## Rotating secrets

Change the variable and recreate the container. A new access token signs every browser out and needs updating in scripts and CLI setups. A new ingest key needs updating in every exporter.

## What connects to the internet

The server sends its own traces and metrics (service `maple-cli`) to Maple by default, as described in [What connects to the internet](/docs/local-mode#what-connects-to-the-internet). Set `MAPLE_TELEMETRY=off` to turn that off. Your telemetry never leaves the server. The image does not check for updates.
