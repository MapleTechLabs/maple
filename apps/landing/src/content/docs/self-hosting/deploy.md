---
title: "Deploy"
description: "Run the Maple image with Docker Compose or on a container platform, and put it behind TLS."
group: "Self-hosting"
order: 2
---

Every deployment needs the same four things: the image `ghcr.io/mapletechlabs/maple`, a persistent volume at `/data`, the [two secrets](/docs/self-hosting#the-two-secrets), and exactly one instance. For a plain `docker run`, see the [quick start](/docs/self-hosting#quick-start).

## Docker Compose

Put the two secrets in a `.env` file next to `compose.yaml`:

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

Then run `docker compose up -d`. On a machine reachable from the internet, change the port to `"127.0.0.1:4318:4318"` and put [a reverse proxy](#behind-a-reverse-proxy) in front. Where the docs show `docker exec maple ...`, use `docker compose exec maple ...` instead.

## On a platform

Create a service from the image `ghcr.io/mapletechlabs/maple:latest` and give it:

- a persistent volume mounted at `/data`;
- the two secrets as environment variables;
- an HTTP health check on `/health`, which needs no credentials;
- exactly one instance. The store is a local database, so a second replica would not share it.

The server listens on `$PORT` when the platform sets one, and on `4318` otherwise. Platforms that terminate TLS for you work as is: the session cookie is marked `Secure` when the request arrives over HTTPS, and the dashboard works on whatever hostname the platform assigns.

## Platforms

Guides for a specific platform, with the service already configured:

- [Render](/docs/self-hosting/platforms/render): one-click deploy from a blueprint.
- [Railway](/docs/self-hosting/platforms/railway): one-click deploy from a template.

## Behind a reverse proxy

Put anything reachable from the internet behind TLS. On your own server, run a reverse proxy in front of port 4318. With [Caddy](https://caddyserver.com), which gets a certificate for you, the whole config is:

```
maple.example.com {
	reverse_proxy localhost:4318
}
```

Any other proxy works too if it forwards the `Host` header unchanged and sets `X-Forwarded-Proto`. Then publish the container on loopback only (`-p 127.0.0.1:4318:4318`) so it is reachable only through the proxy.
