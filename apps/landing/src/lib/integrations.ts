interface IntegrationStep {
	title: string
	code: string
	language: string
}

interface IntegrationSignal {
	title: string
	description: string
}

export interface Integration {
	name: string
	slug: string
	language: string
	description: string
	steps: IntegrationStep[]
	signals: IntegrationSignal[]
}

export const integrations: Record<string, Integration> = {
	nextjs: {
		name: "Next.js",
		slug: "nextjs",
		language: "typescript",
		description:
			"Add OpenTelemetry tracing to your Next.js application with Vercel's built-in instrumentation hook. Capture server components, API routes, and middleware spans automatically.",
		steps: [
			{
				title: "Install dependencies",
				code: `npm install @vercel/otel @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http`,
				language: "bash",
			},
			{
				title: "Configure instrumentation",
				code: `// instrumentation.ts (project root)
import { registerOTel } from "@vercel/otel";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";

const MAPLE_ENDPOINT = "https://ingest.maple.dev";
const headers = { authorization: "Bearer your-api-key" };

export function register() {
  registerOTel({
    serviceName: "my-next-app",
    attributes: { "deployment.environment.name": "production" },
    traceExporter: { url: \`\${MAPLE_ENDPOINT}/v1/traces\`, headers },
    logRecordProcessor: new SimpleLogRecordProcessor(
      new OTLPLogExporter({ url: \`\${MAPLE_ENDPOINT}/v1/logs\`, headers })
    ),
  });
}`,
				language: "typescript",
			},
		],
		signals: [
			{
				title: "HTTP routes",
				description:
					"Automatic spans for every page and route handler request with method, status, and duration.",
			},
			{
				title: "API routes",
				description: "Full tracing of API route handlers including request/response metadata.",
			},
			{
				title: "Server Components",
				description: "Spans for React Server Component rendering and data fetching.",
			},
			{
				title: "Middleware",
				description: "Traces for Next.js middleware execution including redirects and rewrites.",
			},
			{
				title: "Log correlation",
				description:
					"Log records exported over OTLP carry the trace and span id of the request that wrote them.",
			},
			{
				title: "External API calls",
				description:
					"Outgoing fetch requests traced with context propagation. Add database client instrumentations through the instrumentations option.",
			},
		],
	},
	python: {
		name: "Python",
		slug: "python",
		language: "python",
		description:
			"Instrument a Python application with OpenTelemetry auto-instrumentation. Flask, FastAPI, Django, SQLAlchemy, requests and dozens of other libraries are traced without code changes.",
		steps: [
			{
				title: "Install the distro and bootstrap instrumentations",
				code: `pip install opentelemetry-distro opentelemetry-exporter-otlp

# Installs an instrumentation package for every supported library in your environment
opentelemetry-bootstrap -a install`,
				language: "bash",
			},
			{
				title: "Run under opentelemetry-instrument",
				code: `export OTEL_SERVICE_NAME="my-python-app"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your-api-key"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"

opentelemetry-instrument python app.py`,
				language: "bash",
			},
		],
		signals: [
			{
				title: "Flask/FastAPI routes",
				description:
					"Automatic spans for every HTTP request with route, method, and status code attributes.",
			},
			{
				title: "SQLAlchemy queries",
				description:
					"Database query spans with statement text, connection details, and execution duration.",
			},
			{
				title: "HTTP requests",
				description:
					"Outgoing requests via urllib3 and the requests library traced with context propagation.",
			},
			{
				title: "Redis calls",
				description: "Redis command spans with operation type, key patterns, and response time.",
			},
			{
				title: "Celery tasks",
				description:
					"Distributed task spans that link producers and consumers across worker processes.",
			},
			{
				title: "gRPC calls",
				description: "Client and server gRPC spans with service, method, and status code attributes.",
			},
		],
	},
	nodejs: {
		name: "Node.js",
		slug: "nodejs",
		language: "typescript",
		description:
			"Add distributed tracing to any Node.js application with the OpenTelemetry SDK. Auto-instrumentation captures Express, Fastify, database queries, and HTTP calls with no code changes.",
		steps: [
			{
				title: "Install dependencies",
				code: `npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-logs-otlp-http`,
				language: "bash",
			},
			{
				title: "Configure tracing",
				code: `// tracing.ts (run with: node --import ./tracing.ts app.ts)
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: "https://ingest.maple.dev/v1/traces",
    headers: { Authorization: "Bearer your-api-key" },
  }),
  logRecordProcessors: [
    new SimpleLogRecordProcessor(
      new OTLPLogExporter({
        url: "https://ingest.maple.dev/v1/logs",
        headers: { Authorization: "Bearer your-api-key" },
      })
    ),
  ],
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();`,
				language: "typescript",
			},
		],
		signals: [
			{
				title: "Express/Fastify routes",
				description:
					"Automatic spans for every HTTP request with route pattern, method, and response status.",
			},
			{
				title: "PostgreSQL/MySQL queries",
				description:
					"Database spans with query text, connection info, and execution duration via pg and mysql2.",
			},
			{
				title: "HTTP client calls",
				description:
					"Outgoing HTTP requests traced with context propagation across service boundaries.",
			},
			{
				title: "Redis operations",
				description: "Redis command spans with operation type, key patterns, and latency tracking.",
			},
			{
				title: "gRPC services",
				description:
					"Full client and server gRPC tracing with service name, method, and status attributes.",
			},
			{
				title: "Logs with trace context",
				description:
					"Log records exported over OTLP carry the trace and span id of the request that wrote them.",
			},
		],
	},
} satisfies Record<string, Integration>
