---
name: maple-nodejs-style
description: "Plain Node.js (Express, Fastify, Hono, Bun) OpenTelemetry style for Maple: NodeSDK + --import bootstrap, native @opentelemetry/api call sites, inline endpoint + ingest key, OTLP HTTP exporters."
---

# Maple Node.js style

Use `@opentelemetry/sdk-node` loaded with `--import` (Bun: `--preload`) so the SDK starts before any framework code runs.

```ts
// telemetry.ts
import { register } from "node:module"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { resourceFromAttributes } from "@opentelemetry/resources"

// ESM apps only: lets auto-instrumentation patch `import`ed modules. Omit for CommonJS.
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)

const MAPLE_ENDPOINT = "https://ingest.maple.dev" // EU: https://ingest.eu.maple.dev
const MAPLE_KEY = "MAPLE_TEST" // set by maple-onboard skill on pairing

const headers = { authorization: `Bearer ${MAPLE_KEY}` }

const sdk = new NodeSDK({
	resource: resourceFromAttributes({
		"service.name": "my-node-app",
		"deployment.environment.name": process.env.NODE_ENV ?? "development",
		"vcs.repository.url.full": "https://github.com/acme/my-node-app",
		"vcs.ref.head.revision":
			process.env.RAILWAY_GIT_COMMIT_SHA ??
			process.env.GITHUB_SHA ??
			process.env.GIT_COMMIT,
	}),
	traceExporter: new OTLPTraceExporter({
		url: `${MAPLE_ENDPOINT}/v1/traces`,
		headers,
	}),
	logRecordProcessors: [
		new BatchLogRecordProcessor(
			new OTLPLogExporter({ url: `${MAPLE_ENDPOINT}/v1/logs`, headers }),
		),
	],
	metricReader: new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter({
			url: `${MAPLE_ENDPOINT}/v1/metrics`,
			headers,
		}),
	}),
	instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()
```

Run the app with the bootstrap loaded first:

```bash
node --import ./telemetry.js app.js
```

For TypeScript projects, use the loader the repo already uses (`tsx`, `ts-node/esm`, native Bun). Do not introduce a new loader. For ESM apps, keep the `register(...)` hook call and add `@opentelemetry/instrumentation` to `package.json`; without it, ESM-imported libraries are not instrumented.

## Bootstrap rules

- HTTP OTLP exporters only, never gRPC. gRPC pulls in native bindings that complicate containers.
- `getNodeAutoInstrumentations()` covers HTTP, `fetch` (undici), Express, Fastify, pg, MySQL, Redis, and more. Frameworks without their own instrumentation (Hono on `@hono/node-server`) are still traced at the HTTP server layer. Disable an instrumentation only when it breaks the app:
	```ts
	getNodeAutoInstrumentations({
		"@opentelemetry/instrumentation-fs": { enabled: false },
	})
	```
- For Bun, use the same SDK with `bun --preload ./telemetry.ts app.ts`. Bun ignores Node's module hooks, so some auto-instrumentations do not fire. Add manual spans where auto-instrumentation is blind.

## Route handlers and business operations

Use the native API. Use `withSpan` from `@maple-dev/otel-helpers` for bounded operations. Its signature is `withSpan(name, fn, { tracer })`; it ends the span and records exceptions and `Error` status on throw.

```ts
import { trace, metrics } from "@opentelemetry/api"
import { withSpan } from "@maple-dev/otel-helpers"

const tracer = trace.getTracer("orders.api")
const meter = metrics.getMeter("orders.api")
const submitted = meter.createCounter("orders.submitted")

app.post("/orders", async (req, res) => {
	await withSpan(
		"order.submit",
		async (span) => {
			span.setAttributes({
				"tenant.id": req.headers["x-tenant-id"] as string,
				"order.id": req.body.id,
			})
			await chargeOrder(req.body)
			submitted.add(1, { "tenant.id": req.headers["x-tenant-id"] as string })
			res.json({ ok: true })
		},
		{ tracer },
	)
})
```

## Logs

Bridge the existing logger through OTLP. Do not replace it. `getNodeAutoInstrumentations()` already includes the Pino, Winston, and Bunyan instrumentations: they inject `trace_id` / `span_id` into records and forward them to the `logRecordProcessors` configured above. Winston forwarding also needs `@opentelemetry/winston-transport` installed. `console.*` is not bridged. The user's logger keeps its current sinks.

## Coexistence

If the repo has Sentry, Datadog, New Relic, Honeycomb, Logtail, or a Pino transport, leave them in place alongside Maple.
