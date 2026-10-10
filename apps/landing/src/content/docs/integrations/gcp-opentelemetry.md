---
title: "Google Cloud with OpenTelemetry"
description: "Which telemetry to send from your workloads over OpenTelemetry and which to collect through the Google Cloud connection, for GKE, Cloud Run and Compute Engine."
group: "Integrations"
order: 8
navLabel: "Google Cloud + OpenTelemetry"
---

Your workloads send traces, logs and metrics straight to Maple over OpenTelemetry. The [Google Cloud connection](/docs/integrations/gcp) forwards Cloud Logging entries and reads Cloud Monitoring metrics for everything your code never sees. Set up both, and keep container logs on the OpenTelemetry side.

| Signal    | Over OpenTelemetry                       | Google Cloud connection                                                                                                             |
| --------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Traces    | Every span your services create          | None                                                                                                                                |
| Logs      | Application logs, linked to their traces | Cloud Run and load balancer request logs, audit logs, managed-service logs such as Cloud SQL and Pub/Sub, GKE node and cluster logs |
| Metrics   | Application and runtime metrics          | Platform metrics from Cloud Monitoring, named `gcp.*`                                                                               |
| Resources | None                                     | The resource list: projects, services, clusters, instances and databases                                                            |

## Recommended setup

### GKE

1. Instrument each service with an OpenTelemetry SDK. Export to Maple, or to the [Maple Kubernetes collector](/docs/infrastructure/kubernetes) in the cluster.
2. [Connect Google Cloud](/docs/integrations/gcp#connect) and keep the log filter on **Recommended**.

The connection then adds node and cluster logs, audit logs and the `gcp.kubernetes.*` metrics.

### Cloud Run

1. Instrument the service with an OpenTelemetry SDK that exports to Maple, with the settings under [Instrument a Cloud Run service](#instrument-a-cloud-run-service).
2. [Connect Google Cloud](/docs/integrations/gcp#connect).
3. If the service exports logs over OpenTelemetry, [leave out its container output](#change-the-filter) too: the recommended filter forwards what a Cloud Run container writes to stdout and stderr.

The connection adds Cloud Run's request logs and the `gcp.run.*` metrics. Cloud Run sends a `traceparent` header with every request. An SDK that continues it gives the server span the trace ID of Google's request log for that request, so the request log, your spans and your log lines join on one trace.

### Compute Engine

1. Instrument the application with an OpenTelemetry SDK that exports to Maple.
2. Run the OpenTelemetry Collector on the VM for [host metrics](/docs/infrastructure/hosts).
3. [Connect Google Cloud](/docs/integrations/gcp#connect).

The connection adds audit logs and the `gcp.compute.*` metrics.

## GKE container logs

The recommended filter leaves out `resource.type="k8s_container"`: what the containers of a GKE cluster write to stdout and stderr.

| Reason        | Detail                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicates    | A workload that sends its logs over OpenTelemetry, or a collector that reads pod logs, already delivers each line to Maple. Forwarding it from Google Cloud stores it twice. |
| No trace link | The OpenTelemetry copy carries the trace and span ID of the request that wrote it. The copy from Google Cloud has neither.                                                   |
| Volume        | Container output grows with traffic. Every forwarded line counts toward your Maple plan and toward the Pub/Sub usage Google bills to your account.                           |

Include GKE container logs when the workloads don't send their logs over OpenTelemetry and no collector reads them. Cloud Logging is then the only place those lines exist.

## Change the filter

On the connection's row, click **Configure** and choose a filter under **Log filter**. Click **Continue to the script**, then copy the script and run it in Cloud Shell again.

| Log filter                     | The sink forwards                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Recommended**                | Platform logs. Leaves out GKE container logs and the [other exclusions](/docs/integrations/gcp#logs). |
| **Include GKE container logs** | The same, plus GKE container logs. Maple asks you to confirm before you continue.                     |
| **Keep current filter**        | What it forwards now. Offered, and preselected, once a run has set log forwarding up.                 |

For any other filter, paste the script into an editor, edit `LOG_FILTER` near its top, set `LOG_FILTER_MODE` to `set` and run it. To also leave out Cloud Run container output, for services that send their logs over OpenTelemetry, add this at the end of `LOG_FILTER`, inside the quotes:

```text
AND NOT log_id("run.googleapis.com/stdout") AND NOT log_id("run.googleapis.com/stderr")
```

Cloud Run's request logs are in `run.googleapis.com/requests` and still pass. The filter uses the [Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language).

## Instrument a Cloud Run service

These settings decide whether every trace arrives and joins Google's request log. They apply in any language. The example is Node.js, and the [Node.js guide](/docs/guides/instrumentation-nodejs) covers the SDK basics.

| Setting      | On Cloud Run                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service name | Set `service.name` to the Cloud Run service name, `K_SERVICE`. Google's request logs arrive in Maple under that name. With another one, your spans and logs land in a different service than the request logs.                                                                                                                             |
| Sampling     | Sample every trace: `AlwaysOnSampler`, or `OTEL_TRACES_SAMPLER=always_on`. Cloud Run sets the sampled flag of `traceparent` on about one request per ten seconds per instance. The SDK's default sampler follows that flag and drops the rest, while the log records of those requests still arrive.                                       |
| Flushing     | Flush the span and log processors when the server span ends. Call `sdk.shutdown()` on `SIGTERM` and keep `node` as PID 1. Cloud Run throttles the container's CPU once the response is sent: with the default batch timers, telemetry arrives 5 to 6 seconds after the request on a warm instance and about 30 seconds after a cold start. |
| Logs         | Emit application logs over OpenTelemetry, not stdout. Each record carries the trace and span ID of its request, and nothing is stored twice.                                                                                                                                                                                               |

For Node.js 22 with `@opentelemetry/sdk-node`:

```js
// tracing.mjs
import { register } from "node:module"
import { SpanKind } from "@opentelemetry/api"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { envDetector, processDetector, resourceFromAttributes } from "@opentelemetry/resources"
import { gcpDetector } from "@opentelemetry/resource-detector-gcp"
import { AlwaysOnSampler, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"

// Lets the instrumentations patch ES modules.
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)

// The exporters read OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS.
const spans = new BatchSpanProcessor(new OTLPTraceExporter())
const logRecords = new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })
const metricExporter = new OTLPMetricExporter()

// Export as each request finishes, before Cloud Run throttles the CPU.
const flushOnRequestEnd = {
	onStart() {},
	onEnd(span) {
		if (span.kind !== SpanKind.SERVER) return
		void spans.forceFlush()
		void logRecords.forceFlush()
	},
	forceFlush: () => Promise.resolve(),
	shutdown: () => Promise.resolve(),
}

const sdk = new NodeSDK({
	// The name Google's request logs carry.
	resource: resourceFromAttributes({ "service.name": process.env.K_SERVICE }),
	// gcpDetector adds cloud.platform, cloud.region and the faas.* attributes.
	resourceDetectors: [envDetector, processDetector, gcpDetector],
	sampler: new AlwaysOnSampler(),
	spanProcessors: [spans, flushOnRequestEnd],
	logRecordProcessors: [logRecords],
	metricReaders: [new PeriodicExportingMetricReader({ exporter: metricExporter })],
	instrumentations: [getNodeAutoInstrumentations()],
})
sdk.start()

// Cloud Run sends SIGTERM before it stops an instance.
process.on("SIGTERM", () => {
	sdk.shutdown().finally(() => process.exit(0))
})
```

Start the container with `node` as PID 1, so that it receives `SIGTERM`:

```dockerfile
CMD ["node", "--import", "./tracing.mjs", "server.mjs"]
```

Set these on the service:

- `OTEL_EXPORTER_OTLP_ENDPOINT`: `https://ingest.maple.dev`, or `https://ingest.eu.maple.dev` for an EU organization.
- `OTEL_EXPORTER_OTLP_HEADERS`: `Authorization=Bearer YOUR_INGEST_KEY`.

Emit a log record inside a request and it carries the active trace and span ID:

```js
import { logs, SeverityNumber } from "@opentelemetry/api-logs"

const logger = logs.getLogger("checkout")

logger.emit({
	severityText: "INFO",
	severityNumber: SeverityNumber.INFO,
	body: "checkout completed",
	attributes: { "order.id": orderId },
})
```

A service that has to log to stdout keeps the link by writing JSON lines with `logging.googleapis.com/trace` (`projects/PROJECT_ID/traces/TRACE_ID`) and `logging.googleapis.com/spanId`. Send each line one way only: over OpenTelemetry or through stdout.

Limits of this setup:

- Your service's top span is the child of a span inside Google's infrastructure that Maple does not receive, so the trace has no root span.
- Flushing per request makes one export per request. Check the overhead before you use it on a service with a high request rate.

## Instrumentation guides

- Languages: [Node.js](/docs/guides/instrumentation-nodejs), [Next.js](/docs/guides/instrumentation-nextjs), [Python](/docs/guides/instrumentation-python), [Go](/docs/guides/instrumentation-go), [Rust](/docs/guides/instrumentation-rust), [Java](/docs/guides/instrumentation-java), [Kotlin](/docs/guides/instrumentation-kotlin), [C# / .NET](/docs/guides/instrumentation-csharp) and [Laravel](/docs/guides/instrumentation-laravel).
- [Kubernetes infrastructure](/docs/infrastructure/kubernetes): the collector that receives OTLP from in-cluster services.
- [Hosts](/docs/infrastructure/hosts): host metrics from a VM.
- [Google Cloud](/docs/integrations/gcp): connect, verify and troubleshoot the connection.
