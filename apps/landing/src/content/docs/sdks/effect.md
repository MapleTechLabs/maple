---
title: "Effect SDK"
description: "OpenTelemetry traces, logs, and metrics for Effect applications across Node.js, Bun, Deno, browsers, and Cloudflare Workers."
group: "Instrumentation"
order: 1
navLabel: "Effect"
sdk: "effect"
---

`@maple-dev/effect-sdk` is Maple's SDK for Effect applications. It provides an Effect Layer that sets up OpenTelemetry traces, logs and metrics, fills in resource attributes from the runtime, and sends everything to Maple's ingest for your region. In most setups an ingest key from **Settings → Ingestion** is the only configuration it needs.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Node.js</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Bun</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Deno</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Browsers</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Cloudflare Workers</span>
</div>

## Install

**Effect 4** (`effect` 4.0.0-rc.113 or later)

```bash
npm install @maple-dev/effect-sdk effect
```

**Effect 3**

```bash
npm install @maple-dev/effect-sdk@effect-v3 effect @effect/platform @effect/opentelemetry
```

> The Effect 3 build is published under the `effect-v3` npm tag and is older than the Effect 4 release. The options on these pages describe the Effect 4 release.

## Pick your platform

The SDK ships three entry points, each with its own page:

- [**Server**](/docs/sdks/effect-server): Node.js, Bun, Deno. Background export fiber, configuration from environment variables, graceful shutdown.
- [**Browser**](/docs/sdks/effect-client): single-page apps. Configuration passed in code, browser metadata added to resource attributes, session replay.
- [**Cloudflare Workers**](/docs/sdks/effect-cloudflare): short-lived isolates. In-isolate buffering, `flush()` in `ctx.waitUntil`, configuration read from the Worker `env` on first flush.

## Custom spans

Use `Effect.withSpan` to trace operations. Add attributes with `Effect.annotateCurrentSpan`:

```typescript
import { Effect } from "effect"

const processOrder = (orderId: string) =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan("order.id", orderId)
		yield* Effect.annotateCurrentSpan("payment.method", "card")
		const result = yield* chargePayment(orderId)
		return result
	}).pipe(Effect.withSpan("process-order"))
```

Service map edges come from instrumented client spans that propagate `traceparent` to an instrumented callee, not from attributes such as `peer.service`. See [Service map](/docs/explore/service-map).

## Log correlation

`Effect.log` includes the trace context when called inside a span, with no extra setup:

```typescript
const program = Effect.gen(function* () {
	yield* Effect.log("Processing started")
	yield* doWork()
	yield* Effect.log("Processing complete")
}).pipe(Effect.withSpan("process"))
```

Logs emitted inside spans are correlated with the active trace in the Maple dashboard.

## Configuration reference

Options for `Maple.layer()` on the server and browser entry points, and for `make()` on the Cloudflare entry point. The Cloudflare-only options are on the [Cloudflare page](/docs/sdks/effect-cloudflare#cloudflare-specific-config).

| Option                  | Type                      | Entry points       | Description                                                                                                                                                                                              |
| ----------------------- | ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serviceName`           | `string`                  | all                | Service name on traces, logs and metrics. Required in the browser. On the server and Cloudflare it falls back to `OTEL_SERVICE_NAME`, then `"unknown"`                                                    |
| `region`                | `"us" \| "eu"`            | all                | Region of your Maple organization. Defaults to `"us"`. Server and Cloudflare fall back to `MAPLE_REGION`. Ignored when an endpoint is set in config or env                                               |
| `endpoint`              | `string`                  | all                | Ingest base URL, for a proxy, collector or [Maple Local](/docs/local-mode). Overrides `region`. Server and Cloudflare fall back to `MAPLE_ENDPOINT`, then `OTEL_EXPORTER_OTLP_ENDPOINT`, then the region's ingest |
| `ingestKey`             | `string`                  | all                | Ingest key, sent as `Authorization: Bearer`. Server and Cloudflare fall back to `MAPLE_INGEST_KEY`. Maple's hosted ingest rejects requests without one                                                  |
| `serviceVersion`        | `string`                  | all                | Service version. Server and Cloudflare fall back to the commit SHA from the environment                                                                                                                  |
| `serviceNamespace`      | `string`                  | all                | Logical group, emitted as the `service.namespace` resource attribute                                                                                                                                     |
| `environment`           | `string`                  | all                | Deployment environment. Server and Cloudflare fall back to `MAPLE_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_NAME`, `DEPLOYMENT_ENV`, then `"development"`                                                         |
| `repositoryUrl`         | `string`                  | server, Cloudflare | Repository URL, emitted as `vcs.repository.url.full`. Falls back to `MAPLE_REPOSITORY_URL`, then GitHub Actions or Vercel git metadata                                                                    |
| `attributes`            | `Record<string, unknown>` | all                | Extra resource attributes. They take precedence over `OTEL_RESOURCE_ATTRIBUTES` entries with the same key                                                                                                |
| `privacy`               | `PrivacyOptions`          | browser            | Consent gating, visitor-id storage and email capture. See [Privacy](/docs/sdks/effect-client#privacy)                                                                                                    |
| `replay`                | `ClientReplayConfig`      | browser            | Session replay settings. See [Session Replay & Sessions](/docs/sdks/effect-client#session-replay-and-sessions)                                                                                              |
| `emitSessionMeta`       | `boolean`                 | browser            | Post session metadata rows for sessions without a recording. Default `true`                                                                                                                              |
| `maxBatchSize`          | `number`                  | server, browser    | Max telemetry items per export batch                                                                                                                                                                     |
| `loggerExportInterval`  | `Duration.Input`          | server, browser    | Export interval for logs                                                                                                                                                                                 |
| `metricsExportInterval` | `Duration.Input`          | server, browser    | Export interval for metrics                                                                                                                                                                              |
| `tracerExportInterval`  | `Duration.Input`          | server, browser    | Export interval for traces                                                                                                                                                                               |
| `shutdownTimeout`       | `Duration.Input`          | server, browser    | Graceful shutdown timeout                                                                                                                                                                                |

> In Effect 3, duration fields use the `Duration.DurationInput` type instead of `Duration.Input`.

The region endpoints are `https://ingest.maple.dev` (US) and `https://ingest.eu.maple.dev` (EU). An ingest key only works in the region it was created in. See [Regions](/docs/reference/regions).
