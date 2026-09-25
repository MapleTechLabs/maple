---
title: "Effect SDK on Cloudflare Workers"
description: "Set up the Effect SDK on Cloudflare Workers with explicit flush() in ctx.waitUntil and in-isolate buffering."
group: "Instrumentation"
order: 4
navLabel: "Cloudflare Workers"
sdk: "effect"
---

The `/cloudflare` entry point of `@maple-dev/effect-sdk` is built for Cloudflare Workers. A Worker has no long-running process: the isolate handles a request, returns a response, and the runtime may suspend it at any moment. A background export fiber does not run reliably between invocations, so this entry point buffers telemetry inside the isolate and sends it when you call `flush(env)`, which you schedule with `ctx.waitUntil`.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Cloudflare Workers</span>
</div>

> Already installed the SDK? If not, see the [install instructions](/docs/sdks/effect#install).

## Why Workers Are Different

- **No background fiber.** Spans, logs and metrics accumulate in memory inside the isolate and are only sent when you call `flush()`.
- **Configuration on first flush.** You can call `make()` at module scope without `env`. The SDK reads the endpoint, ingest key and resource attributes from `env` on the first `flush(env)` call.
- **Manual lifecycle.** `ctx.waitUntil(telemetry.flush(env))` keeps the isolate alive long enough to send the batch after the response is returned.

## Quick Start

```typescript
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { HttpRouter } from "effect/unstable/http"
import { Layer } from "effect"
import { Routes } from "./routes"

const telemetry = MapleCloudflareSDK.make({ serviceName: "my-worker" })

const handler = HttpRouter.toWebHandler(Routes.pipe(Layer.provideMerge(telemetry.layer)))

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext) {
		const res = await handler(req)
		ctx.waitUntil(telemetry.flush(env))
		return res
	},
}
```

`telemetry.layer` must be merged into the same Effect runtime that runs your routes, because the tracer has to be in scope when spans are created. A separate per-request runtime does not work.

Runtimes that own a per-request scope can use `telemetry.requestLayer` instead of calling `flush` themselves. It is the same layer plus a flush when the scope closes, and it reads `env` from the `WorkerEnvironment` service exported by this entry point.

## No-op mode

When no ingest key is set (neither `ingestKey` nor `MAPLE_INGEST_KEY`), the SDK runs in no-op mode. Each `flush()` still empties the buffers so they do not grow for the life of the isolate, but nothing is sent. The first flush logs one `console.info` line starting with `[MapleCloudflareSDK] no ingest key configured`. The same code can therefore run in preview environments that have no key.

## Failure handling

A flush fails when the request throws (for example a network error) or the ingest answers with any non-2xx status, including `401` and `429`. The failed batch goes back into the buffer ahead of newer telemetry, and that signal enters a 60-second cooldown. During the cooldown, flushes for that signal skip the request and log a warning. Traces, logs and metrics each have their own cooldown. Errors are logged to `console.error` and never reach your handler.

## Cloudflare-specific config

`make()` accepts the [common options](/docs/sdks/effect#configuration-reference) marked for Cloudflare (`serviceName`, `region`, `endpoint`, `ingestKey`, `serviceVersion`, `serviceNamespace`, `environment`, `repositoryUrl`, `attributes`), plus these:

| Option                        | Type                    | Default       | Description                                                                                        |
| ----------------------------- | ----------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `excludeLogSpans`             | `boolean`               | `false`       | Skip Effect log spans in OTLP log attributes                                                       |
| `dropSpanNames`               | `ReadonlyArray<string>` | none          | Drop spans whose name starts with any prefix in this list                                          |
| `anticipatedErrorIdentifiers` | `ReadonlyArray<string>` | none          | `_tag` / `Error.name` values of expected 4xx failures. Spans export as `Ok`, with no `exception` event |
| `tracesPath`                  | `string`                | `/v1/traces`  | OTLP traces path appended to `endpoint`                                                            |
| `logsPath`                    | `string`                | `/v1/logs`    | OTLP logs path appended to `endpoint`                                                              |
| `metricsPath`                 | `string`                | `/v1/metrics` | OTLP metrics path appended to `endpoint`                                                           |

`anticipatedErrorIdentifiers` keeps expected rejections (a 404, a 401) visible as traces without counting them as errors. A span still exports as `Error` if its cause contains any defect.

An error that crossed an HTTP boundary is a decoded body rather than the class that raised it, so a failure shaped `{ error: { _tag } }` (the envelope convention many APIs use) is matched on the body's `_tag`. Client-side spans classify the same as the server-side ones they mirror, with no separate identifiers to configure.

`dropSpanNames` suppresses protocol-level chatter. For example, `["McpServer/Notifications."]` drops MCP notification spans without dropping handler spans.

## Endpoint resolution

The endpoint is the first of:

1. `config.endpoint`
2. `env.MAPLE_ENDPOINT`
3. `env.OTEL_EXPORTER_OTLP_ENDPOINT`
4. The ingest for `config.region`, then for `env.MAPLE_REGION`: `https://ingest.maple.dev` for `us`, `https://ingest.eu.maple.dev` for `eu`
5. `https://ingest.maple.dev`

Any explicit endpoint beats any region. On hosted Maple, a `MAPLE_INGEST_KEY` secret is usually all you need, plus `MAPLE_REGION=eu` for an EU organization. Other variables read from `env`: `OTEL_SERVICE_NAME`, `MAPLE_ENVIRONMENT`, `MAPLE_REPOSITORY_URL`, `OTEL_RESOURCE_ATTRIBUTES`, and the commit SHA variables listed on the [server page](/docs/sdks/effect-server#environment-variables).

## Verify

1. Set the key as a secret with `wrangler secret put MAPLE_INGEST_KEY` (an ingest key from **Settings → Ingestion**), then deploy with `wrangler deploy`.
2. Send a few requests to the Worker.
3. In Maple, open **Explore → Traces**. Each request should show up as one trace, rooted at the server span for the request.

## Troubleshooting

Run `wrangler tail` and look for lines starting with `[MapleCloudflareSDK]`:

- **`no ingest key configured`.** The Worker has no `MAPLE_INGEST_KEY` in `env`. Set it with `wrangler secret put MAPLE_INGEST_KEY`.
- **`flush failed; cooldown 60s`** with `OTLP 401`. The key is wrong, or it belongs to the other region. An EU key needs `MAPLE_REGION=eu`.
- **`flush skipped (cooldown ...)`.** An earlier flush failed. Look further back in the log for the failure.
- **No lines and no data.** `ctx.waitUntil(telemetry.flush(env))` is not being called, so the isolate stops before the request is sent. Or `telemetry.layer` is provided to a different runtime than your routes.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Cloudflare integration](/docs/integrations/cloudflare)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)
