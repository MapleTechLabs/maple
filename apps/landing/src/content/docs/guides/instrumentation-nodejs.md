---
title: "Node.js instrumentation"
description: "Instrument a Node.js application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 5
navLabel: "Node.js"
sdk: "node"
---

This guide sets up the OpenTelemetry Node.js SDK so your application sends traces, logs and metrics to Maple, with automatic instrumentation for HTTP servers, frameworks and database clients.

To have a coding agent do this setup, use the [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) skill, and [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) to check an existing setup.

## Prerequisites

- Node.js 22.22.3+, 24.11.1+ or 26+ (the versions whose `module.registerHooks` can run the ES module hook)
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`) for server applications.

## Install

```bash
npm install @opentelemetry/api \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/instrumentation \
  import-in-the-middle \
  @opentelemetry/resources \
  @opentelemetry/sdk-logs \
  @opentelemetry/sdk-metrics \
  @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/exporter-logs-otlp-proto \
  @opentelemetry/exporter-metrics-otlp-proto
```

## Configure

Create `tracing.mjs` next to your entry point. It starts the SDK before any of your application code loads.

```javascript
// tracing.mjs
import { register } from "import-in-the-middle/register-hooks.mjs"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"

// Lets the instrumentations patch ES modules. CommonJS apps can drop this line.
register()

const MAPLE_ENDPOINT = "https://ingest.maple.dev" // EU: https://ingest.eu.maple.dev
const MAPLE_KEY = "YOUR_INGEST_KEY"

const headers = { authorization: `Bearer ${MAPLE_KEY}` }

const sdk = new NodeSDK({
	resource: resourceFromAttributes({
		"service.name": "my-node-app",
		"deployment.environment.name": process.env.NODE_ENV || "development",
		"vcs.repository.url.full": "https://github.com/acme/my-node-app",
		"vcs.ref.head.revision": process.env.GITHUB_SHA ?? process.env.GIT_COMMIT,
	}),
	traceExporter: new OTLPTraceExporter({ url: `${MAPLE_ENDPOINT}/v1/traces`, headers }),
	logRecordProcessors: [
		new BatchLogRecordProcessor({
			exporter: new OTLPLogExporter({ url: `${MAPLE_ENDPOINT}/v1/logs`, headers }),
		}),
	],
	metricReaders: [
		new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({ url: `${MAPLE_ENDPOINT}/v1/metrics`, headers }),
		}),
	],
	instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()

process.on("SIGTERM", () => {
	sdk.shutdown().finally(() => process.exit(0))
})
```

`@opentelemetry/sdk-logs` 0.220.0 and later take `{ exporter }`. Older releases take the exporter as the first argument, `new BatchLogRecordProcessor(exporter)`. Passing it positionally to a current release raises no error, but no log record is exported.

On Node.js versions older than those in [Prerequisites](#prerequisites), replace the `register()` call with `module.register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)` from `node:module`. Node.js 26 marks `module.register` as deprecated.

The example puts the endpoint and key in source. An ingest key can only write telemetry to your organization. It cannot read data or call the Maple API. Keeping it in source means the SDK always starts with a complete configuration, so a deploy that is missing an environment variable cannot silently turn telemetry off. To keep the key out of source, use [environment variables](#environment-variables) instead.

Load the file before your application:

```bash
node --import ./tracing.mjs app.js
```

For a TypeScript entry point run through [tsx](https://tsx.is), load tsx first:

```bash
node --import tsx --import ./tracing.mjs app.ts
```

## Environment variables

The SDK can take its whole configuration from the standard OpenTelemetry variables. With them set, you do not need `tracing.mjs`: the `register` entry point of the auto-instrumentations package starts the SDK and reads the variables.

```bash
export OTEL_SERVICE_NAME="my-node-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_TRACES_EXPORTER="otlp"
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-node-app"

node --require @opentelemetry/auto-instrumentations-node/register app.js
```

For an ES module app, also load a `hooks.mjs` with `--import ./hooks.mjs` so the instrumentations can patch ES modules:

```javascript
// hooks.mjs
import { register } from "import-in-the-middle/register-hooks.mjs"

register()
```

`OTEL_EXPORTER_OTLP_ENDPOINT` takes the base URL. The exporters append `/v1/traces`, `/v1/logs` and `/v1/metrics` themselves.

## Auto-instrumentation

`getNodeAutoInstrumentations()` enables the OpenTelemetry instrumentations for common libraries, including `http`, Express, Fastify, `pg`, `mysql2`, `ioredis` and many more. Each incoming request becomes a server span, and each outgoing HTTP call or database query becomes a child span.

To turn off instrumentations you do not want:

```javascript
instrumentations: [
	getNodeAutoInstrumentations({
		"@opentelemetry/instrumentation-fs": { enabled: false },
		"@opentelemetry/instrumentation-dns": { enabled: false },
	}),
],
```

## Custom spans

Wrap your own operations in spans:

```typescript
import { trace, SpanStatusCode } from "@opentelemetry/api"

const tracer = trace.getTracer("my-app")

async function processOrder(orderId: string) {
	return tracer.startActiveSpan("process-order", async (span) => {
		try {
			span.setAttribute("order.id", orderId)
			span.setAttribute("payment.method", "card")
			return await chargePayment(orderId)
		} catch (error) {
			span.recordException(error as Error)
			span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
			throw error
		} finally {
			span.end()
		}
	})
}
```

Service map edges come from instrumented client spans that propagate `traceparent` to an instrumented callee, not from attributes such as `peer.service`. See [Service map](/docs/explore/service-map).

## Attributes Maple uses

Most attributes are optional. These unlock specific features.

### Commits and GitHub

Set `vcs.ref.head.revision` (the full 40-character commit SHA) and `vcs.repository.url.full` on the resource. They drive deploy markers, the Releases page and, with the [GitHub integration](/docs/integrations/github), commit hover cards on traces. The resource in [Configure](#configure) already sets both. Read the SHA from your CI or host at build time, such as `GITHUB_SHA` or `VERCEL_GIT_COMMIT_SHA`, not from `git` at runtime:

```bash
export OTEL_RESOURCE_ATTRIBUTES="vcs.repository.url.full=https://github.com/acme/api,vcs.ref.head.revision=$GITHUB_SHA"
```

### Databases

Database instrumentation sets these attributes for you. For a driver without instrumentation, set them on a `Client` span:

```typescript
import { SpanKind } from "@opentelemetry/api"

const user = await tracer.startActiveSpan(
	"SELECT users",
	{
		kind: SpanKind.CLIENT,
		attributes: {
			"db.system.name": "postgresql",
			"db.namespace": "app",
			"db.query.text": "SELECT * FROM users WHERE id = $1",
		},
	},
	async (span) => {
		try {
			return await client.query("SELECT * FROM users WHERE id = $1", [id])
		} finally {
			span.end()
		}
	},
)
```

`db.system.name` and `db.namespace` draw the database node on the [service map](/docs/explore/service-map). `db.query.text` groups statements into query shapes, so record it with placeholders, not bound values. See [Database queries](/docs/concepts/otel-conventions#database-queries) for the full list.

## Log correlation

Log records emitted through the OpenTelemetry log SDK during an active span carry its trace and span IDs, so Maple links each log line to its trace.

The auto-instrumentations include `pino`, `winston` and `bunyan` instrumentations that add the active trace context to each log record. Pino and bunyan records are also sent through the log exporter configured above. Winston needs the `@opentelemetry/winston-transport` package for that.

## Other Node.js frameworks

- Next.js has its own guide: [Next.js instrumentation](/docs/guides/instrumentation-nextjs).
- For Effect applications, use the [Effect SDK](/docs/sdks/effect).

## Verify

1. Start your application and send it a few requests.
2. In Maple, open **Explore → Traces**. The SDK sends spans in batches every 5 seconds by default, and metrics every 60 seconds.
3. Each request should show up as one trace with a single root server span, named after the method and route (for example `GET /api/orders`), and child spans for the queries and outgoing calls it made.

Your service also appears on the **Services** page once its first spans arrive.

## Troubleshooting

- **`401` responses.** The key is wrong, was copied from the other region, or the header is malformed. The header must be `Authorization: Bearer YOUR_INGEST_KEY`. In `OTEL_EXPORTER_OTLP_HEADERS` it is written `Authorization=Bearer YOUR_INGEST_KEY`. See [Ingest API status codes](/docs/reference/ingest#status-codes).
- **Wrong protocol or path.** Maple accepts OTLP over HTTP. Use the `-proto` (or `-http`) exporters, not `-grpc`. Endpoints set in code need the full signal path (`/v1/traces`); `OTEL_EXPORTER_OTLP_ENDPOINT` takes only the base URL.
- **Network.** From the machine running the app, run `curl -i https://ingest.maple.dev/v1/traces -X POST`. Any HTTP status code means the host can reach Maple. A timeout or DNS error means a firewall or proxy is blocking outbound HTTPS.
- **Nothing exported.** `tracing.mjs` must load before the modules it instruments, so use `--import` rather than importing it from your app. A process that exits right away can lose its last batch; call `sdk.shutdown()` before exit, as the `SIGTERM` handler above does. Set `OTEL_LOG_LEVEL=debug` to print export errors to the console.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Track errors](/docs/errors/overview)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)
