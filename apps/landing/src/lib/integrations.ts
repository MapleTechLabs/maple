// The /integrations/<runtime> pages. Every setup step is a condensed copy of the docs guide at
// `docsHref`: change the guide and the page together, so the two never disagree.
//
// No `.astro` imports, so the hub, the `.md` twins and the tests can read this.
import * as m from "../paraglide/messages.js"

interface IntegrationStep {
	title: string
	code: string
	language: string
}

interface IntegrationSignal {
	title: string
	description: string
}

type Locale = "en" | "ja" | "ko"

export interface Integration {
	name: string
	slug: string
	language: string
	/** Meta description. */
	description: string
	/** `<title>`. Next.js reads its localized copy from messages instead. */
	title: string
	heading: string
	lede: string
	gridTitle: string
	traceHeading: string
	/** The full docs guide this page condenses. */
	docsHref: string
	/**
	 * Locales with a translated body. A page served under /ja or /ko without one canonicalises to
	 * English, so the copy is not indexed as a duplicate.
	 */
	locales: readonly Locale[]
	/** One line for the cross links on the other integration pages. */
	summary: string | (() => string)
	/** Slugs of the integration pages linked at the foot, hand-picked per page. */
	related: readonly string[]
	steps: IntegrationStep[]
	signals: IntegrationSignal[]
	/** What differs on this runtime: how instrumentation is wired, and where setups go wrong. */
	specifics?: { title: string; items: IntegrationSignal[] }
}

export const integrations: Record<string, Integration> = {
	nextjs: {
		name: "Next.js",
		slug: "nextjs",
		language: "typescript",
		description:
			"Add OpenTelemetry tracing to your Next.js application with Vercel's built-in instrumentation hook. Capture server components, API routes, and middleware spans automatically.",
		title: "Next.js Observability with OpenTelemetry | Maple",
		heading: "Next.js observability with OpenTelemetry",
		lede: "Next.js has an instrumentation hook built in. Register OpenTelemetry there, and server components, API routes and middleware produce spans with no further code.",
		gridTitle: "Automatic instrumentation for Next.js",
		traceHeading: "See your Next.js traces",
		docsHref: "/docs/guides/instrumentation-nextjs",
		locales: ["en", "ja", "ko"],
		summary: m.intg_other_nextjs_desc,
		related: ["nodejs", "vercel-ai-sdk", "python"],
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
    logRecordProcessors: [
      new SimpleLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: \`\${MAPLE_ENDPOINT}/v1/logs\`, headers }),
      }),
    ],
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
				description: "Spans for API route handlers, with request and response metadata.",
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
			"Instrument a Python application with OpenTelemetry auto-instrumentation and send traces to Maple. Flask, FastAPI, Django, SQLAlchemy, requests and dozens of other libraries are covered without code changes.",
		title: "Python Observability with OpenTelemetry | Maple",
		heading: "Python observability with OpenTelemetry",
		lede: "Install the OpenTelemetry distro, bootstrap the instrumentations for the libraries you already use, and run your app under opentelemetry-instrument. Flask, FastAPI, Django, SQLAlchemy, requests and dozens of other libraries are traced without code changes.",
		gridTitle: "Automatic instrumentation for Python",
		traceHeading: "See your Python traces",
		docsHref: "/docs/guides/instrumentation-python",
		locales: ["en"],
		summary: m.intg_other_python_desc,
		related: ["nodejs", "go", "langchain"],
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
		title: "Node.js Observability with OpenTelemetry | Maple",
		heading: "Node.js observability with OpenTelemetry",
		lede: "Add distributed tracing to any Node.js application with the OpenTelemetry SDK. Auto-instrumentation captures Express, Fastify, database queries, and HTTP calls with no code changes.",
		gridTitle: "Automatic instrumentation for Node.js",
		traceHeading: "See your Node.js traces",
		docsHref: "/docs/guides/instrumentation-nodejs",
		locales: ["en"],
		summary: m.intg_other_nodejs_desc,
		related: ["nextjs", "python", "go"],
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
    new SimpleLogRecordProcessor({
      exporter: new OTLPLogExporter({
        url: "https://ingest.maple.dev/v1/logs",
        headers: { Authorization: "Bearer your-api-key" },
      }),
    }),
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
				description: "Client and server gRPC spans with service name, method, and status attributes.",
			},
			{
				title: "Logs with trace context",
				description:
					"Log records exported over OTLP carry the trace and span id of the request that wrote them.",
			},
		],
	},
	go: {
		name: "Go",
		slug: "go",
		language: "go",
		description:
			"Set up OpenTelemetry tracing and logging in a Go service and send it to Maple over OTLP. Covers the SDK setup, otelhttp and slog, and names the packages for gRPC and database/sql.",
		title: "Go Tracing with OpenTelemetry | Maple",
		heading: "OpenTelemetry tracing for Go services",
		lede: "Go has no in-process auto-instrumentation. You register the OpenTelemetry SDK once at startup, then wrap each library you use: your HTTP mux, your gRPC server, your database handle. The context you already pass around carries the trace.",
		gridTitle: "What a Go service sends to Maple",
		traceHeading: "Example: a Go request, with otelgrpc and otelsql added",
		docsHref: "/docs/guides/instrumentation-go",
		locales: ["en"],
		summary: "Wrap net/http, gRPC and database/sql with the OpenTelemetry contrib packages",
		related: ["rust", "java", "nodejs"],
		steps: [
			{
				title: "Install the SDK, exporters and instrumentation packages",
				code: `go get go.opentelemetry.io/otel \\
  go.opentelemetry.io/otel/sdk \\
  go.opentelemetry.io/otel/sdk/log \\
  go.opentelemetry.io/otel/log \\
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp \\
  go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp \\
  go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp \\
  go.opentelemetry.io/contrib/bridges/otelslog`,
				language: "bash",
			},
			{
				title: "Register the providers at startup",
				code: `// telemetry.go: the exporters read OTEL_EXPORTER_OTLP_* from the environment
package main

import (
	"context"
	"errors"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func initTelemetry(ctx context.Context) (func(context.Context) error, error) {
	res, err := resource.New(ctx, resource.WithFromEnv())
	if err != nil {
		return nil, err
	}

	traceExporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(traceExporter), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))

	logExporter, err := otlploghttp.New(ctx)
	if err != nil {
		return nil, errors.Join(err, tp.Shutdown(ctx))
	}
	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter)),
		sdklog.WithResource(res),
	)
	global.SetLoggerProvider(lp)

	return func(ctx context.Context) error {
		return errors.Join(tp.Shutdown(ctx), lp.Shutdown(ctx))
	}, nil
}`,
				language: "go",
			},
			{
				title: "Wrap your handler, and flush when the process is stopped",
				code: `// main.go
package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// A setup error only disables telemetry; it never stops the app.
	shutdown, err := initTelemetry(ctx)
	if err != nil {
		log.Printf("telemetry disabled: %v", err)
	} else {
		// slog records go to Maple; log with InfoContext so they carry the trace
		slog.SetDefault(otelslog.NewLogger("my-go-app"))
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/orders/{id}", handleOrders)

	// Every request becomes a server span
	srv := &http.Server{Addr: ":8080", Handler: otelhttp.NewHandler(mux, "server")}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	if shutdown != nil {
		shutdown(ctx) // sends the last batch
	}
}`,
				language: "go",
			},
			{
				title: "Point the exporters at Maple",
				code: `export OTEL_SERVICE_NAME="my-go-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"

go run .`,
				language: "bash",
			},
		],
		signals: [
			{
				title: "HTTP server spans",
				description:
					"otelhttp turns each request into one root server span. Current versions name it after the method and the ServeMux pattern, such as GET /api/orders/{id}.",
			},
			{
				title: "Outgoing HTTP calls",
				description:
					"Wrap the client transport with otelhttp.NewTransport. Each call gets a client span and sends traceparent. When the callee is instrumented too, that call is an edge on the service map.",
			},
			{
				title: "gRPC",
				description:
					"otelgrpc stats handlers trace both sides of a call. Client and server spans join into one trace across services.",
			},
			{
				title: "database/sql queries",
				description:
					"Open the database with github.com/XSAM/otelsql, or use otelpgx for pgx. Each query records its statement and database system, and the database appears as its own node on the service map.",
			},
			{
				title: "slog records with trace ids",
				description:
					"The otelslog bridge exports log/slog records. A record logged with the request context carries that request's trace and span id.",
			},
			{
				title: "Errors on spans",
				description:
					"span.RecordError and span.SetStatus(codes.Error, ...) mark the operation that failed, and the trace shows where in the request it happened.",
			},
		],
		specifics: {
			title: "What is different in Go",
			items: [
				{
					title: "One package per library",
					description:
						"Go cannot patch libraries at runtime. Nothing is traced until you wrap it with its contrib package, so list the libraries a request touches and wrap each one.",
				},
				{
					title: "ctx is the trace",
					description:
						"Spans link through context.Context. Call QueryContext, NewRequestWithContext and logger.InfoContext, or the child span starts a new trace.",
				},
				{
					title: "Flush before exit",
					description:
						"The span batcher sends every 5 seconds. A deploy stops the process with SIGTERM, and os.Exit and log.Fatal skip deferred calls. The main above waits for the signal and flushes before it exits.",
				},
			],
		},
	},
	java: {
		name: "Java",
		slug: "java",
		language: "java",
		description:
			"Attach the OpenTelemetry Java agent to a Spring Boot or any JVM app and send traces, logs and JVM metrics to Maple. No code changes for Spring, JDBC, Kafka and more.",
		title: "Java and Spring Boot Tracing with OpenTelemetry | Maple",
		heading: "OpenTelemetry for Java and Spring Boot",
		lede: "The OpenTelemetry Java agent is a jar you attach at startup. It instruments Spring, servlet containers, JDBC, Kafka and the HTTP clients in the JVM, and exports traces, logs and metrics to Maple without a code change.",
		gridTitle: "What the Java agent sends to Maple",
		traceHeading: "Example: a Spring Boot request and the Kafka consumer it feeds",
		docsHref: "/docs/guides/instrumentation-java",
		locales: ["en"],
		summary: "Attach the Java agent: Spring, JDBC and Kafka traced without code changes",
		related: ["dotnet", "go", "python"],
		steps: [
			{
				title: "Download the agent",
				code: `curl -L -o opentelemetry-javaagent.jar \\
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar`,
				language: "bash",
			},
			{
				title: "Start the JVM with the agent attached",
				code: `# The key goes in the environment, not on the command line, where ps would show it
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"

java \\
  -javaagent:opentelemetry-javaagent.jar \\
  -Dotel.service.name=my-java-app \\
  -Dotel.exporter.otlp.endpoint=https://ingest.maple.dev \\
  -Dotel.exporter.otlp.protocol=http/protobuf \\
  -Dotel.resource.attributes="deployment.environment.name=production" \\
  -jar app.jar`,
				language: "bash",
			},
			{
				title: "Or set it from the environment in a container",
				code: `export JAVA_TOOL_OPTIONS="-javaagent:/opt/opentelemetry-javaagent.jar"
export OTEL_SERVICE_NAME="my-java-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"`,
				language: "bash",
			},
		],
		signals: [
			{
				title: "Spring MVC and WebFlux requests",
				description:
					"Each request is one root server span named after its method and route, such as GET /api/orders.",
			},
			{
				title: "JDBC, R2DBC and Hibernate",
				description:
					"Query spans carry the statement and the database system. The database shows as a node on the service map.",
			},
			{
				title: "Kafka and JMS",
				description:
					"The agent traces message producers and consumers alongside your HTTP and database spans.",
			},
			{
				title: "Outgoing HTTP and gRPC",
				description:
					"Client spans propagate traceparent. An instrumented callee joins the same trace and draws an edge on the service map.",
			},
			{
				title: "Logback, Log4j2 and JUL",
				description:
					"Log records are exported with the active trace and span id, so each line links to the request that wrote it.",
			},
			{
				title: "JVM metrics",
				description:
					"The agent reports memory, garbage collection and thread counts, exported every 60 seconds.",
			},
		],
		specifics: {
			title: "What is different on the JVM",
			items: [
				{
					title: "The agent does the wiring",
					description:
						"Agent 2.x exports traces, logs and metrics over OTLP by default. There is no SDK code to write, and opentelemetry-api is the only dependency custom spans need.",
				},
				{
					title: "GraalVM native images",
					description:
						"A native image cannot load a Java agent. Use the OpenTelemetry Spring Boot starter there; it reads the same otel.* properties.",
				},
				{
					title: "Base URL, no port",
					description:
						"The agent appends /v1/traces itself. Never add :4317 or :4318. If nothing arrives, look for the agent's line in the startup log; without it, the -javaagent flag never reached the JVM.",
				},
			],
		},
	},
	dotnet: {
		name: ".NET",
		slug: "dotnet",
		language: "csharp",
		description:
			"Add OpenTelemetry to an ASP.NET Core or .NET worker app and send traces, ILogger logs and metrics to Maple over OTLP. Covers HttpClient, EF Core and ActivitySource.",
		title: ".NET and ASP.NET Core Tracing with OpenTelemetry | Maple",
		heading: "OpenTelemetry for .NET and ASP.NET Core",
		lede: "In .NET, tracing is built into the runtime: a span is a System.Diagnostics.Activity. The OpenTelemetry SDK listens to those activities and to ILogger, and one exporter sends all three signals to Maple.",
		gridTitle: "What a .NET app sends to Maple",
		traceHeading: "Example: an ASP.NET Core request calling another service",
		docsHref: "/docs/guides/instrumentation-csharp",
		locales: ["en"],
		summary: "ASP.NET Core, HttpClient and ILogger through the OpenTelemetry .NET SDK",
		related: ["java", "go", "nodejs"],
		steps: [
			{
				title: "Add the packages",
				code: `dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Instrumentation.Http`,
				language: "bash",
			},
			{
				title: "Register OpenTelemetry on the host",
				code: `// Program.cs
using OpenTelemetry;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation())
    .WithMetrics(metrics => metrics.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation())
    .WithLogging()
    .UseOtlpExporter();

var app = builder.Build();
app.MapGet("/", () => "Hello!");
app.Run();`,
				language: "csharp",
			},
			{
				title: "Point the exporter at Maple",
				code: `export OTEL_SERVICE_NAME="my-dotnet-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"

dotnet run`,
				language: "bash",
			},
		],
		signals: [
			{
				title: "ASP.NET Core requests",
				description:
					"Each request is one root server span named after its method and route, plus request duration metrics.",
			},
			{
				title: "HttpClient calls",
				description:
					"Client spans carry traceparent to the service you call. When that service is instrumented, the call is an edge on the service map.",
			},
			{
				title: "EF Core and SqlClient",
				description:
					"Add OpenTelemetry.Instrumentation.EntityFrameworkCore or SqlClient. Query spans carry the statement and the database system.",
			},
			{
				title: "ILogger records",
				description:
					"WithLogging() exports ILogger<T> records. A record written inside an activity carries its trace and span id.",
			},
			{
				title: "Redis and gRPC clients",
				description:
					"StackExchange.Redis and GrpcNetClient each have an instrumentation package, registered the same way.",
			},
			{
				title: "Runtime metrics",
				description:
					"OpenTelemetry.Instrumentation.Runtime adds .NET runtime metrics, exported every 60 seconds.",
			},
		],
		specifics: {
			title: "What is different in .NET",
			items: [
				{
					title: "Activities are spans",
					description:
						"Custom spans come from an ActivitySource. They are only exported when the source name is registered with AddSource; an unregistered source records nothing.",
				},
				{
					title: "gRPC is the exporter default",
					description:
						"Set OTEL_EXPORTER_OTLP_PROTOCOL to http/protobuf, as above, or the exporter speaks gRPC. With HttpProtobuf, an endpoint set in code needs the full /v1/traces path.",
				},
				{
					title: "Console apps and workers",
					description:
						"Without a host, build the providers with Sdk.CreateTracerProviderBuilder() and dispose them before exit, so the last batch is sent.",
				},
			],
		},
	},
	ruby: {
		name: "Ruby",
		slug: "ruby",
		language: "ruby",
		description:
			"Trace a Rails app and its Sidekiq jobs with the OpenTelemetry Ruby SDK and send the spans to Maple over OTLP. One initializer covers Action Pack, Active Record and Net::HTTP.",
		title: "Ruby on Rails Tracing with OpenTelemetry | Maple",
		heading: "OpenTelemetry tracing for Ruby on Rails",
		lede: "Three gems and one initializer. opentelemetry-instrumentation-all turns on tracing for Rails, Active Record, Sidekiq, Net::HTTP and the other libraries your app loads, and the SDK exports the spans to Maple.",
		gridTitle: "What a Rails app sends to Maple",
		traceHeading: "Example: a Rails request that enqueues a Sidekiq job",
		docsHref: "/docs/guides/instrumentation-ruby",
		locales: ["en"],
		summary: "One initializer traces Rails, Active Record, Sidekiq and Net::HTTP",
		related: ["laravel", "python", "nodejs"],
		steps: [
			{
				title: "Add the gems, then run bundle install",
				code: `# Gemfile
gem "opentelemetry-sdk"
gem "opentelemetry-exporter-otlp"
gem "opentelemetry-instrumentation-all"`,
				language: "ruby",
			},
			{
				title: "Create an initializer",
				code: `# config/initializers/opentelemetry.rb
require "opentelemetry/sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry/instrumentation/all"

# Runs in every Rails process: Puma, the console, runners and Sidekiq
OpenTelemetry::SDK.configure do |c|
  c.use_all
end`,
				language: "ruby",
			},
			{
				title: "Point the exporter at Maple, with a service name per process",
				code: `export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"

OTEL_SERVICE_NAME=store-web bin/rails server
OTEL_SERVICE_NAME=store-worker bundle exec sidekiq`,
				language: "bash",
			},
		],
		signals: [
			{
				title: "Rails requests",
				description:
					"Each request is one root server span named after its method and route, such as GET /orders/:id on Rails 7.1 and later.",
			},
			{
				title: "Active Record and SQL",
				description:
					"pg, mysql2 and trilogy queries become child spans. pg and mysql2 obfuscate literal values in the query text by default.",
			},
			{
				title: "Sidekiq jobs",
				description:
					"Each enqueue is a producer span and each run a consumer span. The worker process runs the same initializer, so it needs no setup of its own.",
			},
			{
				title: "Outgoing HTTP",
				description:
					"Net::HTTP and Faraday calls carry traceparent. An instrumented callee joins the trace and draws an edge on the service map.",
			},
			{
				title: "Redis and Action View",
				description:
					"Redis commands and template rendering show as spans inside the request that ran them.",
			},
			{
				title: "Your own spans",
				description:
					"Wrap your own code in in_span. An exception raised inside the block is recorded on the span, marks it as an error and is re-raised.",
			},
		],
		specifics: {
			title: "What is different in Ruby",
			items: [
				{
					title: "Traces only, for now",
					description:
						"The Ruby trace SDK is stable. Its metrics and logs SDKs are still experimental, so this setup sends traces and nothing else.",
				},
				{
					title: "HTTP, never gRPC",
					description:
						"opentelemetry-exporter-otlp speaks OTLP over HTTP only. If OTEL_EXPORTER_OTLP_PROTOCOL is grpc, often inherited from a shared environment, the SDK logs a warning and exports nothing.",
				},
				{
					title: "One trace per job, if you want it",
					description:
						'By default a job starts its own trace, linked to the request that enqueued it. Pass { "OpenTelemetry::Instrumentation::Sidekiq" => { propagation_style: :child } } to use_all to put both in one trace. Keep the default for jobs that enqueue many others.',
				},
				{
					title: "Puma cluster mode needs nothing",
					description:
						"The batch span processor restarts its export thread after a fork, so preload_app! and other forking servers need no on_worker_boot hook.",
				},
				{
					title: "See spans before you send them",
					description:
						"OTEL_TRACES_EXPORTER=console prints spans to stdout. OTEL_LOG_LEVEL=debug prints the SDK's export errors.",
				},
				{
					title: "A missing gem fails quietly",
					description:
						"If the log says to add opentelemetry-exporter-otlp to your Gemfile, the exporter is not in the bundle and no span leaves the process.",
				},
			],
		},
	},
	laravel: {
		name: "Laravel",
		slug: "laravel",
		language: "php",
		description:
			"Send traces, logs and metrics from a Laravel app to Maple with OpenTelemetry. One Composer package covers requests, Eloquent, queues, Redis and the Http client.",
		title: "Laravel Tracing with OpenTelemetry | Maple",
		heading: "OpenTelemetry for Laravel",
		lede: "The keepsuit/laravel-opentelemetry package hooks OpenTelemetry into Laravel's HTTP kernel, database, queue, cache and logging. Install it, set a few variables in .env, and requests, queries and jobs reach Maple as traces.",
		gridTitle: "What a Laravel app sends to Maple",
		traceHeading: "Example: a Laravel request with a query and an Http call",
		docsHref: "/docs/guides/instrumentation-laravel",
		locales: ["en"],
		summary: "One Composer package traces requests, Eloquent, queues and the Http client",
		related: ["ruby", "nodejs", "python"],
		steps: [
			{
				title: "Install the package and publish its config",
				code: `composer require keepsuit/laravel-opentelemetry

php artisan vendor:publish \\
  --provider="Keepsuit\\LaravelOpenTelemetry\\LaravelOpenTelemetryServiceProvider" \\
  --tag="opentelemetry-config"`,
				language: "bash",
			},
			{
				title: "Point the exporters at Maple",
				code: `# .env
OTEL_SERVICE_NAME=my-laravel-app

OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp

OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"

OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"`,
				language: "bash",
			},
			{
				title: "Send logs to the otlp channel",
				code: `// config/logging.php
'channels' => [
    'stack' => [
        'driver' => 'stack',
        'channels' => ['single', 'otlp'],
    ],
],`,
				language: "php",
			},
		],
		signals: [
			{
				title: "HTTP requests",
				description:
					"A server span per request, named after its method and route, and the http.server.request.duration metric.",
			},
			{
				title: "Eloquent and the query builder",
				description:
					"A span per statement with the standard db.* attributes, which draw the database node on the service map.",
			},
			{
				title: "Queue jobs",
				description:
					"Producer and consumer spans, with the trace context carried across the queue to the worker.",
			},
			{
				title: "Http facade calls",
				description:
					"A client span per outgoing request, with traceparent sent to the service you call.",
			},
			{
				title: "Redis, cache and views",
				description:
					"Redis commands as spans, cache hits and misses as span events, and a span per view or Livewire render.",
			},
			{
				title: "Logs on the otlp channel",
				description:
					"Log records go to Maple with the active trace id attached, so each line links to its request.",
			},
		],
		specifics: {
			title: "What is different in Laravel",
			items: [
				{
					title: "Protobuf needs an extension",
					description:
						"http/protobuf falls back to the slow pure-PHP protobuf library. Install the protobuf C extension for production, or set the protocol to http/json, which Maple also accepts.",
				},
				{
					title: "Cached config hides changes",
					description:
						"After editing .env, run php artisan config:clear. A cached config keeps exporting with the old values, or not at all.",
				},
				{
					title: "Switch off what you do not need",
					description:
						"Each instrumentation has its own OTEL_INSTRUMENTATION_* variable, such as OTEL_INSTRUMENTATION_QUERY=false. Keep queries on: they feed the service map.",
				},
			],
		},
	},
	rust: {
		name: "Rust",
		slug: "rust",
		language: "rust",
		description:
			"Bridge the Rust tracing crate to OpenTelemetry and send spans and log events to Maple over OTLP. Covers Axum, reqwest and the crate versions that must match.",
		title: "Rust Tracing with OpenTelemetry | Maple",
		heading: "OpenTelemetry for Rust with the tracing crate",
		lede: "Rust services already log and time work with the tracing crate. tracing-opentelemetry turns those spans into OpenTelemetry spans, a second layer turns events into log records, and both export to Maple over OTLP.",
		gridTitle: "What a Rust service sends to Maple",
		traceHeading: "Example: an Axum request with #[instrument] and reqwest spans",
		docsHref: "/docs/guides/instrumentation-rust",
		locales: ["en"],
		summary: "Bridge tracing spans and events to OpenTelemetry, with Axum and reqwest",
		related: ["go", "java", "nodejs"],
		steps: [
			{
				title: "Add the crates",
				code: `# Cargo.toml: the opentelemetry* crates share one minor version
[dependencies]
opentelemetry = "0.31"
opentelemetry_sdk = "0.31"
opentelemetry-otlp = { version = "0.31", features = ["reqwest-rustls"] }
opentelemetry-appender-tracing = "0.31"
tracing-opentelemetry = "0.32"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
tokio = { version = "1", features = ["full"] }
axum = "0.8"
tower-http = { version = "0.6", features = ["trace"] }`,
				language: "toml",
			},
			{
				title: "Install the bridge layers",
				code: `// src/telemetry.rs: the exporters read OTEL_EXPORTER_OTLP_* from the environment
use opentelemetry::{global, trace::TracerProvider as _};
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{LogExporter, SpanExporter};
use opentelemetry_sdk::{
    logs::SdkLoggerProvider, propagation::TraceContextPropagator, trace::SdkTracerProvider, Resource,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

pub fn init() -> Result<(SdkTracerProvider, SdkLoggerProvider), Box<dyn std::error::Error>> {
    let resource = Resource::builder().build();

    let tracer_provider = SdkTracerProvider::builder()
        .with_batch_exporter(SpanExporter::builder().with_http().build()?)
        .with_resource(resource.clone())
        .build();
    global::set_tracer_provider(tracer_provider.clone());
    global::set_text_map_propagator(TraceContextPropagator::new());

    let logger_provider = SdkLoggerProvider::builder()
        .with_batch_exporter(LogExporter::builder().with_http().build()?)
        .with_resource(resource)
        .build();

    // Keep the exporter's own HTTP client logs out of the OpenTelemetry log pipeline.
    let otel_log_filter = EnvFilter::new("info")
        .add_directive("hyper=off".parse()?)
        .add_directive("h2=off".parse()?)
        .add_directive("reqwest=off".parse()?);

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_opentelemetry::layer().with_tracer(tracer_provider.tracer("my-rust-app")))
        .with(OpenTelemetryTracingBridge::new(&logger_provider).with_filter(otel_log_filter))
        .init();

    Ok((tracer_provider, logger_provider))
}`,
				language: "rust",
			},
			{
				title: "Trace requests and flush on exit",
				code: `// src/main.rs
mod telemetry;

use axum::{routing::get, Router};
use tower_http::trace::TraceLayer;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (tracer_provider, logger_provider) = telemetry::init()?;

    let app = Router::new()
        .route("/api/orders", get(handle_orders))
        // Request spans default to DEBUG, below the INFO filter, so raise them
        .layer(TraceLayer::new_for_http().make_span_with(
            tower_http::trace::DefaultMakeSpan::new().level(tracing::Level::INFO),
        ));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;

    // Reached on Ctrl-C, SIGTERM or a server error: send the last batch first
    let _ = tracer_provider.shutdown();
    let _ = logger_provider.shutdown();
    Ok(served?)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sigterm) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sigterm.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}`,
				language: "rust",
			},
			{
				title: "Point the exporters at Maple",
				code: `export OTEL_SERVICE_NAME="my-rust-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"

cargo run --release`,
				language: "bash",
			},
		],
		signals: [
			{
				title: "#[instrument] spans",
				description:
					"Every function you mark with #[instrument] becomes a span, with the fields you list as attributes.",
			},
			{
				title: "Request spans from Tower",
				description:
					"TraceLayer opens a span per Axum request, so the functions it calls nest under it in one trace.",
			},
			{
				title: "tracing events as logs",
				description:
					"info! and error! inside a span become OpenTelemetry log records that carry that span's trace and span id.",
			},
			{
				title: "reqwest calls",
				description:
					"reqwest-tracing adds a client span and injects traceparent, so an instrumented callee joins the same trace.",
			},
			{
				title: "Database spans",
				description:
					'Give a span otel.kind = "client" and the db.* fields, and Maple draws the database on the service map.',
			},
			{
				title: "Metrics",
				description:
					"The full guide adds a meter provider. Metrics export every 60 seconds over the same endpoint.",
			},
		],
		specifics: {
			title: "What is different in Rust",
			items: [
				{
					title: "Versions move together",
					description:
						"The opentelemetry crates share one minor version, and tracing-opentelemetry must be the release built for it: 0.32 pairs with 0.31. A mismatch shows up as trait errors at compile time.",
				},
				{
					title: "TLS is a feature flag",
					description:
						"The default opentelemetry-otlp HTTP client has no TLS. Without the reqwest-rustls feature it cannot reach an https endpoint.",
				},
				{
					title: "TraceLayer does not propagate",
					description:
						"tower-http's TraceLayer ignores incoming traceparent headers. To join a caller's trace, use a crate built for it, such as axum-tracing-opentelemetry.",
				},
			],
		},
	},
	"vercel-ai-sdk": {
		name: "Vercel AI SDK",
		slug: "vercel-ai-sdk",
		language: "typescript",
		description:
			"Trace Vercel AI SDK agents with OpenTelemetry. Send generateText, streamText and ToolLoopAgent spans to Maple and read each chat as one agent session.",
		title: "Vercel AI SDK Tracing with OpenTelemetry | Maple",
		heading: "Trace Vercel AI SDK agents with OpenTelemetry",
		lede: "The AI SDK emits OpenTelemetry spans for every generateText, streamText and ToolLoopAgent call. Register its telemetry once, pass your chat id on each call, and Maple groups the spans into one agent session per conversation.",
		gridTitle: "What Maple shows for an AI SDK agent",
		traceHeading: "Example: an AI SDK agent turn with a tool call",
		docsHref: "/docs/agent-tracing/vercel-ai-sdk",
		locales: ["en"],
		summary: "One agent session per chat from generateText, streamText and ToolLoopAgent spans",
		related: ["openai-agents", "langchain", "nextjs"],
		steps: [
			{
				title: "Install the packages",
				code: `npm install ai@^7.0.106 @ai-sdk/otel @opentelemetry/sdk-node`,
				language: "bash",
			},
			{
				title: "Point the exporter at Maple",
				code: `export OTEL_SERVICE_NAME="support-agent"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"`,
				language: "bash",
			},
			{
				title: "Register the AI SDK integration",
				code: `// instrumentation.ts: import it first in your entry point
import { OpenTelemetry } from "@ai-sdk/otel"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { registerTelemetry } from "ai"

// Reads OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_*
export const sdk = new NodeSDK()
sdk.start()

registerTelemetry(
	new OpenTelemetry({
		usage: true,
		runtimeContext: true,
	}),
)`,
				language: "typescript",
			},
			{
				title: "Pass the conversation id on every call",
				code: `import { streamText } from "ai"

const result = streamText({
	model,
	messages,
	runtimeContext: { conversationId: chatId },
	telemetry: { functionId: "support_agent", includeRuntimeContext: { conversationId: true } },
})`,
				language: "typescript",
			},
		],
		signals: [
			{
				title: "One session per conversation",
				description:
					"Calls that share a conversation id form one agent session, with one turn per call.",
			},
			{
				title: "Transcript",
				description:
					"Each turn shows the prompts, the replies and the tool calls in the order they ran.",
			},
			{
				title: "Agent names",
				description:
					"functionId becomes the agent name, so two agents in one app stay apart. Sub-agents called from a tool keep their own functionId.",
			},
			{
				title: "Token usage",
				description:
					"usage: true records input and output tokens per model call. Cost shows as unpriced, because the AI SDK does not report it.",
			},
			{
				title: "Tool failures",
				description:
					"A tool that throws from execute is marked as failed on its span. A tool that returns an error value looks successful.",
			},
			{
				title: "Prompts you choose to hide",
				description:
					"Set recordInputs: false and recordOutputs: false on a call to keep its prompts and replies out of Maple.",
			},
		],
		specifics: {
			title: "What is different in AI SDK 7",
			items: [
				{
					title: "Nothing is traced by default",
					description:
						"In AI SDK 7, experimental_telemetry alone does nothing. Call registerTelemetry() once at startup; a second call emits every span twice.",
				},
				{
					title: "ToolLoopAgent takes the id differently",
					description:
						"It has no per-call runtimeContext. Declare conversationId in callOptionsSchema and map it to runtime context in prepareCall.",
				},
				{
					title: "Streams and serverless",
					description:
						"A stream's spans end when it is read to the end. Return the stream as the response, and call forceFlush() in a finally block in serverless handlers.",
				},
			],
		},
	},
	langchain: {
		name: "LangChain",
		slug: "langchain",
		language: "python",
		description:
			"Trace LangChain and LangGraph agents with OpenTelemetry and OpenInference. Send model calls, tool calls and graph steps to Maple, one agent session per thread_id.",
		title: "LangChain and LangGraph Tracing with OpenTelemetry | Maple",
		heading: "Trace LangChain and LangGraph agents with OpenTelemetry",
		lede: "OpenInference's LangChain instrumentation turns LangChain and LangGraph runs into OpenTelemetry spans. Export them to Maple, pass the conversation's thread_id on every call, and each chat becomes one agent session. Python is shown here; the full guide covers TypeScript too.",
		gridTitle: "What Maple shows for a LangGraph agent",
		traceHeading: "Example: a LangGraph turn with a tool node",
		docsHref: "/docs/agent-tracing/langchain",
		locales: ["en"],
		summary: "LangChain and LangGraph runs through OpenInference, grouped by thread_id",
		related: ["openai-agents", "vercel-ai-sdk", "python"],
		steps: [
			{
				title: "Install the instrumentor",
				code: `pip install "langchain>=1.4" "langgraph>=1.2" "langchain-openai>=1.6" \\
  "openinference-instrumentation-langchain>=0.1.76" "openinference-instrumentation>=0.1.66" \\
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"`,
				language: "bash",
			},
			{
				title: "Point the exporter at Maple",
				code: `export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"`,
				language: "bash",
			},
			{
				title: "Initialize tracing before the first invoke()",
				code: `# tracing.py
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.langchain import LangChainInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

# Marks agent and tool-node spans, which Maple draws as agent lanes and steps.
# The name= you gave create_agent(), and graph nodes that act as agents
AGENT_NAMES = {"assistant"}
# Your tool node
STEP_NAMES = {"tools"}


class AgentSpans(SpanProcessor):
    def on_start(self, span, parent_context=None):
        if span.instrumentation_scope.name != "openinference.instrumentation.langchain":
            return
        if span.name in AGENT_NAMES:
            span.set_attribute("gen_ai.operation.name", "invoke_agent")
            span.set_attribute("gen_ai.agent.name", span.name)
        elif span.name in STEP_NAMES:
            span.set_attribute("gen_ai.operation.name", "invoke_workflow")


provider = TracerProvider()
provider.add_span_processor(AgentSpans())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

LangChainInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)`,
				language: "python",
			},
			{
				title: "Pass thread_id on every call",
				code: `import tracing  # first, before the first invoke()

result = agent.invoke(
    {"messages": [{"role": "user", "content": text}]},
    {"configurable": {"thread_id": conversation_id}},
)`,
				language: "python",
			},
		],
		signals: [
			{
				title: "One session per thread",
				description:
					"Every invoke() with the same thread_id is a turn in one agent session. LangGraph Server threads group without extra code.",
			},
			{
				title: "Agent lanes",
				description:
					"Each agent named in AGENT_NAMES, sub-agents included, gets its own lane in the session.",
			},
			{
				title: "Model calls with tokens",
				description:
					"Each chat model call is a span with the model, the messages and the input and output token counts.",
			},
			{
				title: "Tool calls",
				description: "Tool spans are named after your tools and carry the arguments and the result.",
			},
			{
				title: "Graph steps",
				description:
					"Nodes such as your tool node show as workflow steps, so a turn reads in the order the graph ran.",
			},
			{
				title: "Readable transcript",
				description:
					"With enable_genai_semconv, each turn shows the messages that went in and the reply that came out, so a session reads like the chat did.",
			},
		],
		specifics: {
			title: "What is different in LangChain",
			items: [
				{
					title: "Plain chains ignore configurable",
					description:
						"A chain with no graph, such as prompt | model, drops the configurable thread_id. Pass it as metadata instead, or every message becomes its own session.",
				},
				{
					title: "Streamed tokens need stream_usage",
					description:
						"With a custom base_url, vLLM or a gateway, set stream_usage=True on ChatOpenAI. Without it, streamed replies carry no token counts.",
				},
				{
					title: "One instrumentor only",
					description:
						"If every model call appears twice, remove LANGSMITH_OTEL_ENABLED and any provider instrumentor such as openinference-instrumentation-openai.",
				},
			],
		},
	},
	"openai-agents": {
		name: "OpenAI Agents SDK",
		slug: "openai-agents",
		language: "typescript",
		description:
			"Send OpenAI Agents SDK runs to Maple with OpenTelemetry instead of OpenAI's trace upload. One agent session per conversation, with tool calls and tokens.",
		title: "OpenAI Agents SDK Tracing with OpenTelemetry | Maple",
		heading: "Trace OpenAI Agents SDK runs with OpenTelemetry",
		lede: "The OpenAI Agents SDK traces every run, but by default it uploads those traces to OpenAI. OpenInference's bridge replaces that processor, so the same spans go to Maple over OTLP and each conversation becomes one agent session.",
		gridTitle: "What Maple shows for an Agents SDK app",
		traceHeading: "Example: a triage agent handing off to a billing agent",
		docsHref: "/docs/agent-tracing/openai-agents",
		locales: ["en"],
		summary: "Agents SDK runs over OTLP instead of the OpenAI upload, one session per chat",
		related: ["vercel-ai-sdk", "langchain", "nodejs"],
		steps: [
			{
				title: "Install the bridge",
				code: `npm install @openai/agents \\
  @arizeai/openinference-instrumentation-openai-agents \\
  @arizeai/openinference-core @opentelemetry/api @opentelemetry/sdk-node`,
				language: "bash",
			},
			{
				title: "Point the exporter at Maple",
				code: `export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"`,
				language: "bash",
			},
			{
				title: "Register the bridge",
				code: `// instrumentation.ts: import it first in your entry point
import * as agents from "@openai/agents"
import { OpenAIAgentsInstrumentation } from "@arizeai/openinference-instrumentation-openai-agents"
import { NodeSDK } from "@opentelemetry/sdk-node"

// Reads OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_*
export const sdk = new NodeSDK()
sdk.start()

// Replaces the SDK's default processor, which uploads traces to OpenAI
new OpenAIAgentsInstrumentation().manuallyInstrument(agents)`,
				language: "typescript",
			},
			{
				title: "Run each call inside the conversation's context",
				code: `import { setAttributes } from "@arizeai/openinference-core"
import { run } from "@openai/agents"
import { context } from "@opentelemetry/api"

export async function handleMessage(conversationId: string, text: string) {
	const ctx = setAttributes(context.active(), { "gen_ai.conversation.id": conversationId })
	const result = await context.with(ctx, () => run(agent, text))
	return result.finalOutput
}`,
				language: "typescript",
			},
		],
		signals: [
			{
				title: "One session per conversation",
				description:
					"The bridge copies gen_ai.conversation.id onto every span of a run. Runs that share it form one session, one turn per run.",
			},
			{
				title: "Tool calls",
				description:
					"Each tool the agent calls is a span with its name, arguments and result, inside the turn that called it.",
			},
			{
				title: "Tokens on every model call",
				description:
					"Each model call carries its input and output token counts. Cost shows as unpriced.",
			},
			{
				title: "Framework label",
				description:
					"Sessions show the framework as OpenAI Agents SDK, so they stay apart from other agents in the same organization.",
			},
			{
				title: "Next to your services",
				description:
					"The spans go through the same OpenTelemetry SDK as your HTTP and database spans, so one trace can hold both.",
			},
			{
				title: "Python too",
				description:
					"The full guide has the Python setup for openai-agents, with using_session in place of context.with.",
			},
		],
		specifics: {
			title: "What is different in the Agents SDK",
			items: [
				{
					title: "Do not disable tracing",
					description:
						"setTracingDisabled(true) and OPENAI_AGENTS_DISABLE_TRACING stop every span, Maple's included. The bridge already stops the upload to OpenAI.",
				},
				{
					title: "Tests turn tracing off",
					description:
						"With NODE_ENV=test the SDK disables tracing on its own. Call setTracingDisabled(false) in tests that check spans.",
				},
				{
					title: "One OpenAI instrumentation",
					description:
						"If every model call appears twice, another instrumentation of the OpenAI client is also active. Keep one.",
				},
			],
		},
	},
	"cloudflare-workers": {
		name: "Cloudflare Workers",
		slug: "cloudflare-workers",
		language: "jsonc",
		description:
			"Export traces and logs from any Cloudflare Worker to Maple with Workers Observability OTLP destinations. No SDK to install and no code to change.",
		title: "Cloudflare Workers Tracing with OpenTelemetry | Maple",
		heading: "Trace Cloudflare Workers with no SDK",
		lede: "Workers Observability can export a Worker's traces and logs over OTLP. Create two destinations in the Cloudflare dashboard, name them in your Wrangler config, and every invocation reaches Maple. The runtime records the spans, so no code changes.",
		gridTitle: "What a Worker sends to Maple",
		traceHeading: "Example: a Worker invocation with KV, fetch and R2 spans",
		docsHref: "/docs/guides/instrumentation-cloudflare-workers",
		locales: ["en"],
		summary: "OTLP destinations in Workers Observability: traces and logs, no SDK",
		related: ["nextjs", "nodejs", "vercel-ai-sdk"],
		steps: [
			{
				title: "Create a traces destination and a logs destination",
				code: `# Cloudflare dashboard: Workers & Pages > Observability > Destinations
Destination name: maple-traces
Destination type: Traces
OTLP endpoint:    https://ingest.maple.dev/v1/traces
Custom headers:   Authorization: Bearer YOUR_INGEST_KEY

Destination name: maple-logs
Destination type: Logs
OTLP endpoint:    https://ingest.maple.dev/v1/logs
Custom headers:   Authorization: Bearer YOUR_INGEST_KEY`,
				language: "text",
			},
			{
				title: "Name them in the Worker's Wrangler config",
				code: `// wrangler.jsonc
{
	"observability": {
		"traces": {
			"enabled": true,
			"destinations": ["maple-traces"],
		},
		"logs": {
			"enabled": true,
			"destinations": ["maple-logs"],
		},
	},
}`,
				language: "jsonc",
			},
			{
				title: "Deploy",
				code: `wrangler deploy`,
				language: "bash",
			},
		],
		signals: [
			{
				title: "Handler spans",
				description:
					"One root span per fetch, scheduled or queue invocation, named after the Worker script.",
			},
			{
				title: "Outbound fetch",
				description: "Each subrequest is a child span with its timing and status code.",
			},
			{
				title: "Bindings",
				description:
					"KV and R2 operations and Durable Object calls, RPC included, nest under the handler span.",
			},
			{
				title: "console output",
				description:
					"console.log, console.error and the invocation log for each request arrive as logs from the same invocation.",
			},
			{
				title: "Cloudflare Worker panel",
				description:
					"Maple reads the Cloudflare attributes on a span and shows the script, version, CPU and wall time, edge location and Ray ID.",
			},
			{
				title: "Metrics from the API",
				description:
					"Destinations export no metrics. Connect the Cloudflare integration for request counts, error rates and CPU time.",
			},
		],
		specifics: {
			title: "What is different on Workers",
			items: [
				{
					title: "Workers Paid only",
					description:
						"OTLP export is not available on Workers Free, and Cloudflare bills exported events past its allowance. head_sampling_rate: 0.1 records one invocation in ten.",
				},
				{
					title: "Traces stop at the Worker",
					description:
						"Cloudflare does not yet propagate trace context to services outside Cloudflare. A backend the Worker calls starts its own trace.",
				},
				{
					title: "0 ms spans are expected",
					description:
						"The runtime only advances the clock on I/O. CPU work between two I/O calls reports no duration.",
				},
			],
		},
	},
	react: {
		name: "React",
		slug: "react",
		language: "typescript",
		description:
			"Trace React Router navigations, loaders and fetch calls in the browser with OpenTelemetry, and join them to your backend traces in Maple. Setup for React Router 7.15+.",
		title: "React Frontend Tracing with OpenTelemetry | Maple",
		heading: "Frontend tracing for React with OpenTelemetry",
		lede: "The @maple-dev/browser SDK records a span for every fetch and sends traceparent to your API. Hook it into React Router and each click becomes one trace: the navigation, its loaders, their requests and the backend spans behind them.",
		gridTitle: "What a React app sends to Maple",
		traceHeading: "Example: one navigation from the click to the database",
		docsHref: "/docs/frontend/react-router",
		locales: ["en"],
		summary: "React Router navigations and loaders as traces that continue into your API",
		related: ["nextjs", "nodejs", "vercel-ai-sdk"],
		steps: [
			{
				title: "Install the browser SDK",
				code: `npm install @maple-dev/browser`,
				language: "bash",
			},
			{
				title: "Initialize it, with loader spans and route errors",
				code: `// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"
import {
	type ClientInstrumentation,
	type ClientOnErrorFunction,
	type InstrumentationHandlerResult,
	isRouteErrorResponse,
} from "react-router"

MapleBrowser.init({
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY, // public key, maple_pk_...
	serviceName: "acme-web",
	environment: import.meta.env.MODE,
	tracing: {
		// APIs on another origin that should receive \`traceparent\`
		propagateTraceHeaderCorsUrls: [/^https:\\/\\/api\\.acme\\.com\\//],
	},
})

// A span for every loader and action, under the open navigation
export const mapleInstrumentation: ClientInstrumentation = {
	route(route) {
		route.instrument({
			loader: (callLoader) => traceHandler(\`loader \${route.id}\`, callLoader),
			action: (callAction) => traceHandler(\`action \${route.id}\`, callAction),
		})
	},
}

async function traceHandler(name: string, call: () => Promise<InstrumentationHandlerResult>) {
	// The first page's loaders start before the page load opens: wait one tick to nest under it
	await Promise.resolve()
	return MapleBrowser.traced(name, async () => {
		const result = await call()
		// A navigation that was superseded aborts its loaders: not a failure
		if (result.status === "error" && result.error.name !== "AbortError") throw result.error
	}).catch(() => {}) // recorded on the span; React Router still handles the error
}

// Errors React Router catches for your ErrorBoundary
export const reportRouteError: ClientOnErrorFunction = (error, { pattern }) => {
	if (isRouteErrorResponse(error)) return // thrown responses: 404s, redirects
	MapleBrowser.captureException(error, { name: "react_router.error", attributes: { "app.route": pattern } })
}`,
				language: "typescript",
			},
			{
				title: "Pass the instrumentation to the router",
				code: `// src/router.tsx
import { createBrowserRouter } from "react-router"
import { fetchProject, ProjectPage, RootLayout } from "./app"
import { mapleInstrumentation } from "./maple"

export const router = createBrowserRouter(
	[
		{
			path: "/",
			Component: RootLayout,
			children: [
				{
					// Loader spans are named after the route id, so give routes with loaders a readable one
					id: "project",
					path: "projects/:projectId",
					loader: ({ params }) => fetchProject(params.projectId!),
					Component: ProjectPage,
				},
			],
		},
	],
	{ instrumentations: [mapleInstrumentation] },
)`,
				language: "typescript",
			},
			{
				title: "Trace navigations from the entry",
				code: `// src/main.tsx
import "./maple" // first, before anything renders
import { instrumentReactRouter } from "@maple-dev/browser/react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router/dom"
import { reportRouteError } from "./maple"
import { router } from "./router"

instrumentReactRouter(router)

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} onError={reportRouteError} />)`,
				language: "typescript",
			},
		],
		signals: [
			{
				title: "Navigations by route pattern",
				description:
					"pageload /projects/:projectId for the first route, navigate /projects/:projectId after it. The concrete path is in url.path.",
			},
			{
				title: "Loader and action spans",
				description:
					"Each loader and action runs in its own span under the navigation. A thrown Error marks it failed; a thrown redirect does not.",
			},
			{
				title: "fetch and XMLHttpRequest",
				description:
					"Every request is a span. Requests to your own APIs carry traceparent, so the backend's spans join the browser's trace.",
			},
			{
				title: "Route errors",
				description:
					"Errors React Router catches for your ErrorBoundary are reported through onError, once each, with the route pattern attached.",
			},
			{
				title: "Uncaught errors",
				description:
					"init() records uncaught errors and unhandled rejections from outside the router.",
			},
			{
				title: "Session replay",
				description:
					"init() also starts session replay, so a slow navigation can be watched from the user's side.",
			},
		],
		specifics: {
			title: "What is different in the browser",
			items: [
				{
					title: "CORS has to allow traceparent",
					description:
						"An API on another origin must list traceparent in Access-Control-Allow-Headers, or the browser blocks the request. List only your own APIs in propagateTraceHeaderCorsUrls.",
				},
				{
					title: "No async context",
					description:
						"Only requests a loader starts before its first await nest under its span. Start independent requests together with Promise.all.",
				},
				{
					title: "Another router?",
					description:
						"This is data mode in React Router 7.15 and later. Framework mode, TanStack Router and hand-rolled routers each have a guide in the frontend docs.",
				},
			],
		},
	},
} satisfies Record<string, Integration>
