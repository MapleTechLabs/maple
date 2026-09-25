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

// ESM apps only: lets auto-instrumentation patch ESM-only packages. Omit for CommonJS.
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)

const MAPLE_ENDPOINT = "https://ingest.maple.dev" // EU: https://ingest.eu.maple.dev
const MAPLE_KEY = "MAPLE_TEST" // public ingest key (maple_pk_…), or MAPLE_TEST until the user has one

const headers = { authorization: `Bearer ${MAPLE_KEY}` }

const sdk = new NodeSDK({
	resource: resourceFromAttributes({
		"service.name": "my-node-app",
		"service.version": "1.4.2", // package.json version, a release tag, or the commit SHA
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
		new BatchLogRecordProcessor({
			exporter: new OTLPLogExporter({ url: `${MAPLE_ENDPOINT}/v1/logs`, headers }),
		}),
	],
	metricReaders: [
		new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: `${MAPLE_ENDPOINT}/v1/metrics`,
				headers,
			}),
		}),
	],
	instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()

// Flush buffered spans, logs, and metrics before exit. If the app already handles
// SIGTERM, call sdk.shutdown() from that handler instead.
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.once(signal, () => {
		sdk
			.shutdown()
			.catch((err) => console.error("telemetry shutdown failed", err))
			.finally(() => process.exit(0))
	})
}
```

Run the app with the bootstrap loaded first:

```bash
node --import ./telemetry.js app.js
```

For TypeScript projects, use the loader the repo already uses (`tsx`, `ts-node/esm`, native Bun). Do not introduce a new loader. For ESM apps, keep the `register(...)` hook call and add `@opentelemetry/instrumentation` to `package.json`.

Match the installed SDK versions; the wrong shape starts cleanly and then drops data:

- Current `@opentelemetry/sdk-logs` takes `new BatchLogRecordProcessor({ exporter })`. Older releases took the exporter as the first argument. With the wrong form, every log export throws inside the SDK and no log leaves the process. Check the installed `.d.ts`.
- `metricReaders` (array) replaced `metricReader`.

If the app fails at startup after adding the ESM hook, a dependency is incompatible with it. `openai@4` is a known case ("you must import 'openai/shims/node'"). Exclude that package from the hook, then instrument it manually or upgrade it:

```ts
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url, {
	data: { exclude: [/\/node_modules\/openai\//] },
})
```

## Bootstrap rules

- HTTP OTLP exporters only, never gRPC. gRPC pulls in native bindings that complicate containers.
- `getNodeAutoInstrumentations()` covers HTTP, `fetch` (undici), Express, Fastify, pg, MySQL, Redis, and more. Frameworks without their own instrumentation (Hono on `@hono/node-server`) are still traced at the HTTP server layer. Disable an instrumentation only when it breaks the app:
	```ts
	getNodeAutoInstrumentations({
		"@opentelemetry/instrumentation-fs": { enabled: false },
	})
	```
- `getNodeAutoInstrumentations()` pulls in about 200 packages. For a small service, listing the specific `@opentelemetry/instrumentation-*` packages it needs is a fine alternative.
- CLIs and one-shot scripts exit before the batch and metric intervals fire: `await sdk.shutdown()` before the process ends.
- For Bun, use the same SDK with `bun --preload ./telemetry.ts app.ts`. Bun ignores Node's module hooks, so some auto-instrumentations do not fire. Add manual spans where auto-instrumentation is blind.

## Route handlers and business operations

Use the native API: `tracer.startActiveSpan` with `try` / `catch` / `finally` for bounded operations, as in `maple-onboarding-style`.

```ts
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api"

const tracer = trace.getTracer("orders.api")
const meter = metrics.getMeter("orders.api")
const submitted = meter.createCounter("orders.submitted")

app.post("/orders", async (req, res) => {
	const tenantId = req.headers["x-tenant-id"] as string
	await tracer.startActiveSpan("order.submit", async (span) => {
		try {
			span.setAttributes({ "tenant.id": tenantId, "order.id": req.body.id })
			await chargeOrder(req.body)
			submitted.add(1, { "tenant.id": tenantId })
			res.json({ ok: true })
		} catch (err) {
			span.recordException(err as Error)
			span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
			throw err
		} finally {
			span.end()
		}
	})
})
```

## Logs

Bridge the existing logger through OTLP. Do not replace it. `getNodeAutoInstrumentations()` already includes the Pino, Winston, and Bunyan instrumentations: they inject `trace_id` / `span_id` into records and forward them to the `logRecordProcessors` configured above. Winston forwarding also needs `@opentelemetry/winston-transport` installed. `console.*` is not bridged. The user's logger keeps its current sinks.

## Coexistence

If the repo has Sentry, Datadog, New Relic, Honeycomb, Logtail, or a Pino transport, leave them in place alongside Maple.
