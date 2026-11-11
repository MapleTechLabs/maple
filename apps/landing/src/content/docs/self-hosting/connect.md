---
title: "Connect"
description: "Send telemetry to a self-hosted Maple, sign in to its dashboard, and query it from the CLI."
group: "Self-hosting"
order: 3
---

## Send telemetry

Point any OpenTelemetry exporter at the server and send the ingest key as a Bearer token:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://maple.example.com
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<ingest key>"
```

The server takes OTLP over HTTP, as protobuf or JSON. It does not take gRPC, which some SDKs (Java, .NET) use by default, so set the protocol explicitly.

Maple's own SDKs send their ingest key the same way, so an app already set up for Maple Cloud only needs two changes: the endpoint, and the ingest key, which becomes the server's `MAPLE_LOCAL_INGEST_KEY`. The `x-maple-ingest-key` header works too.

## Sign in

Open the server in a browser and sign in with the access token. Everyone uses the same token, and a sign-in lasts 30 days in that browser. There are no separate user accounts: to remove someone's access, [rotate the token](/docs/self-hosting/operations#rotating-secrets).

Failed sign-ins and wrong Bearer tokens are rate-limited: after 10 failures from one address (an IPv6 /64 counts as one) within a minute, that address gets `429 Too Many Requests` until the oldest failure is a minute old, even with the right token. Past 100 failures a minute from all addresses together, every new attempt is refused the same way. Browsers that are already signed in keep working.

## Query from the CLI

Inside the container, the CLI already has the access token and finds the server:

```bash
docker exec maple maple services
docker exec maple maple traces -s checkout --errors
```

With Docker Compose, use `docker compose exec maple maple services`.

From your own machine, point the CLI at the server:

```bash
export MAPLE_LOCAL_URL=https://maple.example.com
export MAPLE_LOCAL_ACCESS_TOKEN=<access token>
maple services
```

If you are signed in to Maple Cloud and have pinned `maple use remote`, the CLI ignores `MAPLE_LOCAL_URL` and queries Maple Cloud. Add `--local`, or run `maple use auto`.

The CLI sends the token only to the host in `MAPLE_LOCAL_URL` (over the same scheme, so an `https` URL never gets it over plain `http`) and to this machine's own addresses.

Scripts can call the query API directly with the same token:

```bash
curl https://maple.example.com/local/status \
  -H "Authorization: Bearer <access token>"
```
