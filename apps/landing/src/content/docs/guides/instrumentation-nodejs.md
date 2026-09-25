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

- Node.js 18.19+ or 20.6+ (the versions that support `node --import`)
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`) for server applications.

## Install

```bash
npm install @opentelemetry/api \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/instrumentation \
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
import { register } from "node:module"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"

// Lets the instrumentations patch ES modules. CommonJS apps can drop this line.
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)

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
		new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${MAPLE_ENDPOINT}/v1/logs`, headers })),
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

For an ES module app, also pass `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` so the instrumentations can patch ES modules.

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
