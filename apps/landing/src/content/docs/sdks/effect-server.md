---
title: "Effect SDK on servers"
description: "Set up the Effect SDK on Node.js, Bun, or Deno with environment-variable auto-detection."
group: "Instrumentation"
order: 2
navLabel: "Server"
sdk: "effect"
---

The server entry point of `@maple-dev/effect-sdk` runs on Node.js, Bun, and Deno. It uses Effect's `Otlp.layerJson` exporter with a background fiber that batches and ships telemetry to Maple's ingest endpoint, and reads its configuration from environment variables when it is not passed in code.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Node.js</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Bun</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Deno</span>
</div>

> Already installed the SDK? If not, see the [install instructions](/docs/sdks/effect#install).

## Quick Start

```typescript
import { Maple } from "@maple-dev/effect-sdk"
import { Effect } from "effect"

const TracerLive = Maple.layer({
	serviceName: "my-effect-app",
})

const program = Effect.gen(function* () {
	yield* Effect.log("Hello from Effect!")
}).pipe(Effect.withSpan("hello-maple"))

Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
```

The default import (`@maple-dev/effect-sdk`) resolves to the server build under Node.js. You can also import the entry point explicitly:

```typescript
import { Maple } from "@maple-dev/effect-sdk/server"
```

Set `MAPLE_INGEST_KEY` to an ingest key from **Settings → Ingestion** (use the private key, `maple_sk_…`) and the SDK picks it up. With nothing else set, telemetry goes to the US ingest, `https://ingest.maple.dev`. For an EU organization, set `MAPLE_REGION=eu` or pass `region: "eu"`, and it goes to `https://ingest.eu.maple.dev`.

The server layer always exports; there is no disable switch. A missing ingest key does not turn export off, so a keyless app pointed at [Maple Local](/docs/local-mode) or your own OTLP collector still sends telemetry. Keyless against Maple's hosted ingest cannot work: every request is rejected with `401`, and the SDK logs a one-time warning. For local development that exports nothing, point `MAPLE_ENDPOINT` at a sink you control, or use `MapleFlush.make`, which does nothing without a key.

## Environment variables

The server layer reads these variables when the matching config option is not set:

| Variable                      | Used for                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `MAPLE_INGEST_KEY`            | Ingest key, sent as a bearer token. Omitted from requests when unset                  |
| `MAPLE_REGION`                | `us` (default) or `eu`. Only used when no endpoint is set anywhere                    |
| `MAPLE_ENDPOINT`              | Ingest base URL, for a proxy, collector or Maple Local. Overrides the region          |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Endpoint fallback when `MAPLE_ENDPOINT` is unset                                      |
| `OTEL_SERVICE_NAME`           | Service name when `serviceName` is not passed. Without either, the name is `unknown` |
| `MAPLE_ENVIRONMENT`           | Deployment environment                                                                |
| `MAPLE_REPOSITORY_URL`        | Repository URL, emitted as `vcs.repository.url.full`                                  |
| `OTEL_RESOURCE_ATTRIBUTES`    | Extra resource attributes as `key=value` pairs                                        |

**Ingest endpoint:** `endpoint` option, then `MAPLE_ENDPOINT`, then `OTEL_EXPORTER_OTLP_ENDPOINT`, then the ingest for `region` or `MAPLE_REGION`, then `https://ingest.maple.dev`. Any explicit endpoint beats any region setting.

**Commit SHA** (first match wins):

1. `COMMIT_SHA`
2. `RAILWAY_GIT_COMMIT_SHA`
3. `VERCEL_GIT_COMMIT_SHA`
4. `CF_PAGES_COMMIT_SHA`
5. `RENDER_GIT_COMMIT`

**Deployment environment** (first match wins):

1. `MAPLE_ENVIRONMENT`
2. `RAILWAY_ENVIRONMENT_NAME`
3. `DEPLOYMENT_ENV`
4. Falls back to `"development"`

`VERCEL_ENV` and `NODE_ENV` are **not** read. On any platform outside that list, set `MAPLE_ENVIRONMENT` explicitly or your telemetry lands under `development`.

**Repository URL:** `MAPLE_REPOSITORY_URL`, then `GITHUB_SERVER_URL` + `GITHUB_REPOSITORY` (GitHub Actions), then `VERCEL_GIT_REPO_OWNER` + `VERCEL_GIT_REPO_SLUG`.

The SDK also detects the **runtime** (Node.js, Bun, Deno) and **cloud provider** (Railway, Vercel, Cloudflare, Render) and adds them as `maple.runtime` and `maple.provider` resource attributes.

## Deployment platform notes

Managed platforms expose the commit SHA automatically. The **environment** is only detected on Railway. Everywhere else, set `MAPLE_ENVIRONMENT` yourself:

| Platform         | Commit SHA env var       | Environment                                 |
| ---------------- | ------------------------ | ------------------------------------------- |
| Railway          | `RAILWAY_GIT_COMMIT_SHA` | `RAILWAY_ENVIRONMENT_NAME` (automatic)      |
| Vercel           | `VERCEL_GIT_COMMIT_SHA`  | Set `MAPLE_ENVIRONMENT`                     |
| Cloudflare Pages | `CF_PAGES_COMMIT_SHA`    | Set `MAPLE_ENVIRONMENT`                     |
| Render           | `RENDER_GIT_COMMIT`      | Set `MAPLE_ENVIRONMENT`                     |
| Other hosts      | `COMMIT_SHA` (set in CI) | Set `MAPLE_ENVIRONMENT` or `DEPLOYMENT_ENV` |

On other hosts, set `COMMIT_SHA` in your build pipeline and `MAPLE_ENVIRONMENT` at runtime.

## Server-side `track()`

Some funnel steps only happen on the backend: a `signup_completed` in a webhook handler, a `plan_started` when billing confirms a subscription. `MapleEvents` posts those to Maple's [product events endpoint](/docs/product-events/api) so they land next to the browser SDK's `track()` calls, keyed to the same person.

```typescript
import { MapleEvents } from "@maple-dev/effect-sdk/server"
import { Effect, Layer } from "effect"

const EventsLive = MapleEvents.layer({ serviceName: "billing" })

const onSubscriptionCreated = Effect.fn("onSubscriptionCreated")(function* (
	userId: string,
	orgId: string,
	plan: string,
) {
	const events = yield* MapleEvents.MapleEvents
	yield* events.track("plan_started", { userId, groupId: orgId, attributes: { plan } })
})
```

`track(name, options)` buffers the event and returns immediately; batches go out every 5 seconds, at 100 events, and when the layer's scope closes. It never fails the caller: a rejected batch is dropped with a rate-limited console warning. `options` are all optional: `userId`, `groupId`, `visitorId` (the browser cookie value, if your backend has it), `sessionId`, `timestamp`, `url`, `pagePath`, and `attributes` (coerced and capped exactly like the browser `track()`).

The endpoint and ingest key resolve the same way as the tracer (`endpoint`/`ingestKey` in config, else `MAPLE_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT` or the region, and `MAPLE_INGEST_KEY`). Without a key, events are dropped with a one-shot warning. Outside an Effect runtime, `MapleEvents.makeHandle(config)` returns a plain `{ track, flush, dispose }`. Call `dispose()` on shutdown so the last batch is sent.

## Verify

1. Start your application and send it a few requests.
2. In Maple, open **Explore → Traces**. The layer exports spans every 5 seconds and metrics every 10 seconds by default.
3. Each request should show up as one trace, with the spans you created with `Effect.withSpan` (or an HTTP server span, if you use Effect's HTTP server) at the root.

Your service also appears on the **Services** page once its first spans arrive.

## Troubleshooting

- **A warning about sending without an ingest key.** `MAPLE_INGEST_KEY` is not set in the process environment and no `ingestKey` was passed. Every request to Maple's ingest is rejected with `401`.
- **`401` responses with a key set.** The key is wrong, or it belongs to the other region. A key from an EU organization needs `MAPLE_REGION=eu` (or `region: "eu"`), and a US key needs the default region.
- **Telemetry goes somewhere else.** If `MAPLE_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set, it wins over the region. A Kubernetes operator or platform can set `OTEL_EXPORTER_OTLP_ENDPOINT` for you; unset it or set `MAPLE_ENDPOINT` to the ingest you want.
- **Network.** From the machine running the app, run `curl -i https://ingest.maple.dev/v1/traces -X POST`. Any HTTP status code means the host can reach Maple.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Track errors](/docs/errors/overview)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)
