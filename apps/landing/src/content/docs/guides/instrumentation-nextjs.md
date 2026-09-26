---
title: "Next.js instrumentation"
description: "Instrument a Next.js application with @vercel/otel and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 6
navLabel: "Next.js"
sdk: "nextjs"
---

This guide sets up OpenTelemetry in a Next.js application with `@vercel/otel`, so the spans Next.js emits for requests, rendering, route handlers and middleware reach Maple, along with your logs and metrics. It works with the App Router and the Pages Router.

To have a coding agent do this setup, use the [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) skill, and [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) to check an existing setup.

## Prerequisites

- Next.js 13.4 or later. On 13.4 and 14, the instrumentation hook needs a config flag (see below). From Next.js 15 it is on by default.
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`): `instrumentation.ts` runs on the server.

## Install

```bash
npm install @vercel/otel \
  @opentelemetry/api \
  @opentelemetry/api-logs \
  @opentelemetry/instrumentation \
  @opentelemetry/resources \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/sdk-logs \
  @opentelemetry/sdk-metrics \
  @opentelemetry/exporter-logs-otlp-proto \
  @opentelemetry/exporter-metrics-otlp-proto
```

`@vercel/otel` declares the other `@opentelemetry/*` packages as peer dependencies, so they are installed alongside it. It includes its own OTLP trace exporter. The log and metric exporters come from the standard OpenTelemetry packages.

## Configure

Create `instrumentation.ts` in the project root, next to `next.config.ts`. If your project keeps its code in `src/`, put the file at `src/instrumentation.ts` instead. Next.js calls `register()` once when each server runtime starts.

```typescript
// instrumentation.ts
import { registerOTel, OTLPHttpProtoTraceExporter } from "@vercel/otel"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"

const MAPLE_ENDPOINT = "https://ingest.maple.dev" // EU: https://ingest.eu.maple.dev
const MAPLE_KEY = "YOUR_INGEST_KEY"

const headers = { authorization: `Bearer ${MAPLE_KEY}` }

export function register() {
	registerOTel({
		serviceName: "my-next-app",
		attributes: {
			"deployment.environment.name": process.env.VERCEL_ENV ?? "development",
			"vcs.repository.url.full": "https://github.com/acme/my-next-app",
			"vcs.ref.head.revision": process.env.VERCEL_GIT_COMMIT_SHA,
		},
		traceExporter: new OTLPHttpProtoTraceExporter({
			url: `${MAPLE_ENDPOINT}/v1/traces`,
			headers,
		}),
		logRecordProcessors: [
			new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${MAPLE_ENDPOINT}/v1/logs`, headers })),
		],
		metricReaders: [
			new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({ url: `${MAPLE_ENDPOINT}/v1/metrics`, headers }),
			}),
		],
	})
}
```

`traceExporter` takes an exporter instance. `OTLPHttpProtoTraceExporter` is exported by `@vercel/otel` and sends OTLP over HTTP with protobuf encoding. It also runs in the Edge runtime.

The example puts the endpoint and key in source. An ingest key can only write telemetry to your organization. It cannot read data or call the Maple API. Keeping it in source means the SDK always starts with a complete configuration, so a deploy that is missing an environment variable cannot silently turn telemetry off. To keep the key out of source, use [environment variables](#environment-variables) instead.

### Next.js 13.4 and 14

Enable the instrumentation hook in `next.config.ts`. Skip this on Next.js 15 and later.

```typescript
// next.config.ts
export default {
	experimental: { instrumentationHook: true },
}
```

## Environment variables

When you leave out `traceExporter`, `@vercel/otel` configures an OTLP trace exporter from the standard environment variables. Set them in your hosting provider's project settings:

```bash
OTEL_SERVICE_NAME="my-next-app"
OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-next-app"
```

`instrumentation.ts` then only needs `registerOTel({ serviceName: "my-next-app" })`. The log and metric exporters from the Configure step read `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` too, so you can construct them without a `url` or `headers`.

## Auto-instrumentation

Next.js emits spans for its own work, and `@vercel/otel` exports them:

- **Requests:** a root server span for every request to a page or route handler, named after the method and route.
- **Rendering:** spans for App Router rendering, Pages Router `getServerSideProps`, and route handler execution.
- **`fetch`:** outgoing `fetch()` calls from server code get client spans, and the trace context is propagated to the service you call.

Set `NEXT_OTEL_VERBOSE=1` to get more spans from Next.js internals. Next.js does not produce metrics of its own, so the metric reader exports the metrics you record with the `@opentelemetry/api` meter.

## Custom spans

Wrap business logic in custom spans to make it visible in the trace:

```typescript
import { trace, SpanStatusCode } from "@opentelemetry/api"

const tracer = trace.getTracer("my-next-app")

export async function processOrder(orderId: string) {
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

Log records emitted through the OpenTelemetry log SDK during an active server span carry its trace and span IDs, so Maple links each log line to its trace. To send logs from pino or winston, bridge the logger to the OpenTelemetry log SDK that `registerOTel` configured above.

## Edge runtime

`instrumentation.ts` runs in the Edge runtime as well as in Node.js. The trace exporter works in both. The metric reader exports on a 60-second timer, so metrics are only reliable from the Node.js runtime.

## Verify

1. Run `next dev` or deploy, then open a page or call a route handler a few times.
2. In Maple, open **Explore → Traces**. Spans are sent in batches every 5 seconds by default.
3. Each request should show up as one trace with a single root server span named after the method and route (for example `GET /dashboard`), with rendering and `fetch` spans nested under it.

Your service also appears on the **Services** page once its first spans arrive.

## Troubleshooting

- **`401` responses.** The key is wrong, was copied from the other region, or the header is malformed. The header must be `Authorization: Bearer YOUR_INGEST_KEY`. In `OTEL_EXPORTER_OTLP_HEADERS` it is written `Authorization=Bearer YOUR_INGEST_KEY`. See [Ingest API status codes](/docs/reference/ingest#status-codes).
- **Wrong protocol or path.** Maple accepts OTLP over HTTP. Endpoints set in code need the full signal path (`/v1/traces`); `OTEL_EXPORTER_OTLP_ENDPOINT` takes only the base URL.
- **Network.** From the machine running the app, run `curl -i https://ingest.maple.dev/v1/traces -X POST`. Any HTTP status code means the host can reach Maple. A timeout or DNS error means a firewall or proxy is blocking outbound HTTPS.
- **Nothing exported.** Check that `instrumentation.ts` is in the project root, or in `src/` for a `src` layout, and not inside `app/` or `pages/`. On Next.js 13.4 and 14, check that `experimental.instrumentationHook` is set.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Track errors](/docs/errors/overview)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)
