export type FrameworkId = "nextjs" | "nodejs" | "python" | "go" | "effect" | "otel"

export interface SdkSnippet {
	language: FrameworkId
	label: string
	description: string
	iconKey: FrameworkId
	install: string | { packages: string[] }
	instrument: string
}

export const sdkSnippets: SdkSnippet[] = [
	{
		language: "nextjs",
		label: "Next.js",
		description: "React framework",
		iconKey: "nextjs",
		install: {
			packages: ["@vercel/otel", "@opentelemetry/sdk-logs", "@opentelemetry/exporter-logs-otlp-http"],
		},
		instrument: `// instrumentation.ts (project root)
import { registerOTel } from "@vercel/otel";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";

export function register() {
  // Your private key (maple_sk_…) from Settings → Ingestion, set in .env and your deployment's secrets.
  const ingestKey = process.env.MAPLE_INGEST_KEY;
  if (!ingestKey) {
    console.warn("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled");
    return;
  }
  const headers = { Authorization: \`Bearer \${ingestKey}\` };

  registerOTel({
    serviceName: "my-next-app",
    attributes: { environment: "production" },
    traceExporter: { url: "{{INGEST_URL}}/v1/traces", headers },
    logRecordProcessor: new SimpleLogRecordProcessor(
      new OTLPLogExporter({ url: "{{INGEST_URL}}/v1/logs", headers })
    ),
  });
}`,
	},
	{
		language: "nodejs",
		label: "Node.js",
		description: "JavaScript runtime",
		iconKey: "nodejs",
		install: {
			packages: [
				"@opentelemetry/sdk-node",
				"@opentelemetry/auto-instrumentations-node",
				"@opentelemetry/exporter-trace-otlp-http",
				"@opentelemetry/exporter-logs-otlp-http",
			],
		},
		instrument: `// tracing.ts — run with: node --import ./tracing.ts app.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";

// Your private key (maple_sk_…) from Settings → Ingestion, set in .env and your deployment's secrets.
const ingestKey = process.env.MAPLE_INGEST_KEY;

if (!ingestKey) {
  console.warn("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled");
} else {
  const headers = { Authorization: \`Bearer \${ingestKey}\` };
  new NodeSDK({
    // Without this your service shows up as "unknown_service:node".
    serviceName: "my-service",
    traceExporter: new OTLPTraceExporter({ url: "{{INGEST_URL}}/v1/traces", headers }),
    logRecordProcessors: [
      new SimpleLogRecordProcessor(new OTLPLogExporter({ url: "{{INGEST_URL}}/v1/logs", headers })),
    ],
    instrumentations: [getNodeAutoInstrumentations()],
  }).start();
}`,
	},
	{
		language: "python",
		label: "Python",
		description: "General purpose",
		iconKey: "python",
		install: `pip install opentelemetry-sdk \\
  opentelemetry-exporter-otlp-proto-http \\
  opentelemetry-instrumentation`,
		instrument: `# tracing.py
import logging
import os

from opentelemetry import trace
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

# Without a service name your service shows up as "unknown_service".
provider = TracerProvider(resource=Resource.create({SERVICE_NAME: "my-service"}))

# Your private key (maple_sk_…) from Settings → Ingestion, set in .env and your deployment's secrets.
ingest_key = os.environ.get("MAPLE_INGEST_KEY")
if ingest_key:
    exporter = OTLPSpanExporter(
        endpoint="{{INGEST_URL}}/v1/traces",
        headers={"Authorization": f"Bearer {ingest_key}"},
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))
else:
    logging.warning("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")
trace.set_tracer_provider(provider)

# Create a tracer and send a test span
tracer = trace.get_tracer("quickstart")
with tracer.start_as_current_span("hello-maple"):
    print("Trace sent!")`,
	},
	{
		language: "go",
		label: "Go",
		description: "Systems language",
		iconKey: "go",
		install: `go get go.opentelemetry.io/otel \\
  go.opentelemetry.io/otel/sdk \\
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp`,
		instrument: `package main

import (
	"context"
	"log"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

func main() {
	ctx := context.Background()

	// Without a service name your service shows up as "unknown_service".
	res := resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceName("my-service"))
	opts := []trace.TracerProviderOption{trace.WithResource(res)}

	// Your private key (maple_sk_…) from Settings → Ingestion, set in .env and your deployment's secrets.
	if ingestKey := os.Getenv("MAPLE_INGEST_KEY"); ingestKey == "" {
		log.Println("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")
	} else if exporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL("{{INGEST_URL}}/v1/traces"),
		otlptracehttp.WithHeaders(map[string]string{"Authorization": "Bearer " + ingestKey}),
	); err != nil {
		log.Println("Maple telemetry export is disabled:", err)
	} else {
		opts = append(opts, trace.WithBatcher(exporter))
	}

	tp := trace.NewTracerProvider(opts...)
	defer tp.Shutdown(ctx)
	otel.SetTracerProvider(tp)

	// Send a test span
	tracer := otel.Tracer("quickstart")
	_, span := tracer.Start(ctx, "hello-maple")
	span.End()
	tp.ForceFlush(ctx)

	log.Println("Trace sent!")
}`,
	},
	{
		language: "effect",
		label: "Effect",
		description: "TypeScript toolkit (Effect 3: use @effect-v3 tag)",
		iconKey: "effect",
		install: { packages: ["@maple-dev/effect-sdk", "effect"] },
		instrument: `// telemetry.ts
import { Maple } from "@maple-dev/effect-sdk"
import { Effect } from "effect"

// Auto-detects MAPLE_ENDPOINT, MAPLE_INGEST_KEY (your private key, maple_sk_…),
// commit SHA, and deployment environment from env vars
const TracerLive = Maple.layer({
  serviceName: "my-effect-app",
})

// Use in your program
const program = Effect.gen(function* () {
  yield* Effect.log("Hello from Effect!")
}).pipe(Effect.withSpan("hello-maple"))

Effect.runPromise(
  program.pipe(Effect.provide(TracerLive))
)`,
	},
	{
		language: "otel",
		label: "Custom / OpenTelemetry",
		description: "Any language or runtime — just point your OTLP exporter at Maple",
		iconKey: "otel",
		install: `# Use your language's OpenTelemetry SDK
# See https://opentelemetry.io/docs/languages/ for installation`,
		instrument: `# Configure via environment variables. MAPLE_INGEST_KEY holds your private key
# (maple_sk_…) from Settings → Ingestion, set in .env and your deployment's secrets.
export OTEL_SERVICE_NAME="my-service"
if [ -n "$MAPLE_INGEST_KEY" ]; then
  export OTEL_EXPORTER_OTLP_ENDPOINT="{{INGEST_URL}}"
  export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $MAPLE_INGEST_KEY"
else
  echo "MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled" >&2
  export OTEL_SDK_DISABLED=true
fi

# Then run your application with your language's OTel SDK enabled`,
	},
]
