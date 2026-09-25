---
name: maple-effect-style
description: "Effect-TS OpenTelemetry style for Maple via @maple-dev/effect-sdk: Maple.layer() bootstrap, Effect.withSpan / Effect.annotateCurrentSpan call sites, Effect.log for trace-correlated logging, server / browser / Cloudflare entry points."
---

# Maple Effect style

For Effect apps, use `@maple-dev/effect-sdk`. It wraps Effect's built-in `Otlp.layerJson` exporter and handles batching, shutdown, and resource attributes.

## Install

```bash
npm install @maple-dev/effect-sdk effect
```

The current release requires Effect 4 (`effect >= 4.0.0-rc.113`). For Effect 3, install `@maple-dev/effect-sdk@effect-v3 effect @effect/platform @effect/opentelemetry`. The API and import paths are the same.

## Bootstrap

Pick the entry point per runtime. Each has different lifecycle requirements:

- **Server (Node.js, Bun, Deno):** background-export fiber, env-var auto-detection, graceful shutdown.
- **Browser:** explicit config (no env vars), browser metadata baked in.
- **Cloudflare Workers:** manual `flush()` in `ctx.waitUntil`, lazy env resolution, in-isolate buffering.

### Server

```ts
import { Maple } from "@maple-dev/effect-sdk"
import { Effect } from "effect"

const TracerLive = Maple.layer({
	serviceName: "orders-api",
	endpoint: "https://ingest.maple.dev", // EU: https://ingest.eu.maple.dev
	ingestKey: "MAPLE_TEST", // public ingest key (maple_pk_…), or MAPLE_TEST until the user has one
	repositoryUrl: "https://github.com/acme/orders-api",
})

const program = Effect.gen(function* () {
	yield* Effect.log("Order received")
}).pipe(Effect.withSpan("order.submit"))

Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
```

The default import resolves to the server build under Node.js. Import `@maple-dev/effect-sdk/server` explicitly when needed.

If `endpoint` is omitted, the server layer reads `MAPLE_ENDPOINT`, then `OTEL_EXPORTER_OTLP_ENDPOINT`, then falls back to the public ingest for the region (`https://ingest.maple.dev`, or `https://ingest.eu.maple.dev` with `region: "eu"` / `MAPLE_REGION=eu`). The key falls back to `MAPLE_INGEST_KEY`. `Maple.layer` always exports. A missing ingest key does not disable it, so keyless local-mode and self-hosted-collector setups keep working. Inline the key when telemetry must flow regardless of env (the maple-onboard inline-key pattern). `MapleFlush.make` and the Cloudflare `make()` differ: they no-op without a key.

The server layer also auto-fills `vcs.ref.head.revision` from `COMMIT_SHA` / `RAILWAY_GIT_COMMIT_SHA` / `VERCEL_GIT_COMMIT_SHA` / `CF_PAGES_COMMIT_SHA` / `RENDER_GIT_COMMIT` (first match wins). For `vcs.repository.url.full`, use the `repositoryUrl` option or `MAPLE_REPOSITORY_URL`. Do not hand-write the attribute. The layer also dual-emits `deployment.environment` and `deployment.environment.name` from the `environment` option or `MAPLE_ENVIRONMENT`.

### Cloudflare Workers

The Cloudflare entry point exports `make()`, not a `Maple` namespace. Build the telemetry object **once at module scope**. It buffers in-isolate and resolves `env` lazily on the first flush:

```ts
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { Effect } from "effect"

const telemetry = MapleCloudflareSDK.make({
	serviceName: "orders-edge",
	endpoint: "https://ingest.maple.dev", // EU: https://ingest.eu.maple.dev
	ingestKey: "MAPLE_TEST",
})

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext) {
		const program = Effect.gen(function* () {
			yield* Effect.log("edge request")
			return new Response("ok")
		}).pipe(Effect.withSpan("edge.handle"))

		const response = await Effect.runPromise(program.pipe(Effect.provide(telemetry.layer)))
		ctx.waitUntil(telemetry.flush(env))
		return response
	},
}
```

Call `ctx.waitUntil(telemetry.flush(env))` on every request so telemetry survives the isolate exit. `flush` takes `env`. A missing `waitUntil` is the most common reason Worker traces never arrive. When routes go through `HttpRouter.toWebHandler`, provide `telemetry.layer` to the layer you pass it (`Layer.provideMerge(telemetry.layer)`), not to a separate per-request runtime.

### Browser

```ts
import { Maple } from "@maple-dev/effect-sdk/client"

const TracerLive = Maple.layer({
	serviceName: "web-client",
	endpoint: "https://ingest.maple.dev", // EU: https://ingest.eu.maple.dev
	ingestKey: "MAPLE_TEST",
})
```

The browser entry point has no env-var fallback. Pass all config explicitly. An explicit `endpoint` wins over `region`, so EU organizations change the endpoint itself (or drop `endpoint` and set `region: "eu"`). It records session replays by default; opt out with `replay: { enabled: false }`.

## Custom spans

Use `Effect.withSpan` to trace operations and `Effect.annotateCurrentSpan` for attributes. Do not reach for the raw `@opentelemetry/api` tracer when an Effect-native primitive exists.

```ts
const processOrder = (orderId: string) =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan("order.id", orderId)
		const result = yield* chargePayment(orderId)
		return result
	}).pipe(Effect.withSpan("order.process"))
```

Maple's service map draws a service-to-service edge by joining a Client span to the downstream service's child Server span. `peer.service` does not draw edges. Make outgoing calls through Effect's `HttpClient`: it creates the Client span and injects `traceparent` by default. Calls to uninstrumented dependencies appear as external nodes keyed on `server.address`.

`Effect.fail` and uncaught defects end the span with status `Error` and an `exception` event. Do not wrap with `try` / `catch` / `finally`.

In Effect code, use the Effect-native span primitives, not the raw `@opentelemetry/api` tracer.

## Logs

`Effect.log` inside a span carries the trace context. No extra setup is needed:

```ts
const program = Effect.gen(function* () {
	yield* Effect.log("Processing started")
	yield* doWork()
	yield* Effect.log("Processing complete")
}).pipe(Effect.withSpan("process"))
```

Logs emitted inside spans are correlated with the active trace in the Maple dashboard.

## Coexistence

If the project already exports through `@effect/opentelemetry` or `Otlp.layerJson` to another vendor (Honeycomb, Datadog), keep that exporter. Do not `Layer.merge` `Maple.layer()` with another tracer layer. Effect runs one `Tracer` service, so the last layer wins and the other vendor stops receiving spans. To ship to both, add Maple as a second destination inside the existing setup: a second OTLP span processor on the `@effect/opentelemetry` SDK, or a fan-out in the team's OpenTelemetry Collector. Ask the user before replacing the incumbent exporter.
