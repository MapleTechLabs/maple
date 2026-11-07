import type { Lang } from "@maple/views/lib/highlight"
import { String as Str } from "effect"

export type FrameworkId =
	| "nodejs"
	| "nextjs"
	| "browser"
	| "python"
	| "go"
	| "java"
	| "dotnet"
	| "laravel"
	| "ruby"
	| "rust"
	| "deno"
	| "effect"
	| "otel"

/** A block of the setup: its file or shell, and what it holds. `{{INGEST_URL}}` and `{{API_KEY}}` are filled in. */
export type SnippetBlock = Readonly<{ label: string; lang: Lang; code: string }>

export interface SdkSnippet {
	language: FrameworkId
	label: string
	description: string
	/** The key the snippet carries: the public one for code that ships to browsers, else the private one. */
	key: "private" | "public"
	/** A shell command, or npm packages shown per package manager. */
	install: string | { packages: ReadonlyArray<string> }
	/** Where the endpoint and key go: the shell or `.env` the app starts from. Null when `code` holds them. */
	env: SnippetBlock | null
	/** What starts sending: a run command or the few lines of code. */
	code: SnippetBlock
}

// The same setups as the docs quickstart: the key lives in the environment, never in a source file,
// and runtimes with a zero-code agent use it, so every request is traced, not one test span.

/**
 * Set where the SDK's default exporter is gRPC but the setup installs or expects the HTTP one
 * (Python's distro, .NET's `UseOtlpExporter`). OTLP/HTTP is the path every Maple endpoint serves.
 */
export const HTTP_PROTOCOL_LINE = `export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"`

const otlpEnv = (serviceName: string, protocol: "default" | "http" = "default"): SnippetBlock => ({
	label: "Environment",
	lang: "bash",
	code: `export OTEL_EXPORTER_OTLP_ENDPOINT="{{INGEST_URL}}"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer {{API_KEY}}"
export OTEL_SERVICE_NAME="${serviceName}"${protocol === "http" ? `\n${HTTP_PROTOCOL_LINE}` : ""}`,
})

export const sdkSnippets: ReadonlyArray<SdkSnippet> = [
	{
		language: "nodejs",
		label: "Node.js",
		description: "Express, Fastify, Nest",
		key: "private",
		install: { packages: ["@opentelemetry/api", "@opentelemetry/auto-instrumentations-node"] },
		env: otlpEnv("my-service"),
		code: {
			label: "Run",
			lang: "bash",
			code: `# Start your app through the register hook. No code changes.
# ES modules: see the Node.js guide.
node --require @opentelemetry/auto-instrumentations-node/register app.js`,
		},
	},
	{
		language: "nextjs",
		label: "Next.js",
		description: "App Router",
		key: "private",
		install: { packages: ["@vercel/otel", "@opentelemetry/api"] },
		env: otlpEnv("my-next-app"),
		code: {
			label: "instrumentation.ts",
			lang: "ts",
			code: `// instrumentation.ts (project root, or src/ if your code lives there)
import { registerOTel } from "@vercel/otel";

// Reads the endpoint and key from the environment.
export function register() {
  registerOTel({ serviceName: "my-next-app" });
}`,
		},
	},
	{
		language: "browser",
		label: "Browser",
		description: "React, Vue, any web app",
		key: "public",
		install: { packages: ["@maple-dev/browser"] },
		env: null,
		code: {
			label: "main.ts",
			lang: "ts",
			code: `// The public key is safe to ship in your bundle: it can only send data.
import { MapleBrowser } from "@maple-dev/browser";

MapleBrowser.init({
  ingestKey: "{{API_KEY}}",
  endpoint: "{{INGEST_URL}}",
  serviceName: "my-web-app",
});`,
		},
	},
	{
		language: "python",
		label: "Python",
		description: "Django, FastAPI, Flask",
		key: "private",
		install: `pip install opentelemetry-distro opentelemetry-exporter-otlp-proto-http
opentelemetry-bootstrap -a install`,
		env: otlpEnv("my-service", "http"),
		code: {
			label: "Run",
			lang: "bash",
			code: `# Start your app through the wrapper. No code changes.
opentelemetry-instrument python app.py
# or: opentelemetry-instrument uvicorn main:app`,
		},
	},
	{
		language: "go",
		label: "Go",
		description: "net/http services",
		key: "private",
		install: `go get go.opentelemetry.io/otel \\
  go.opentelemetry.io/otel/sdk \\
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp \\
  go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp`,
		env: otlpEnv("my-service"),
		code: {
			label: "main.go",
			lang: "go",
			code: `package main

import (
	"context"
	"log"
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func main() {
	ctx := context.Background()

	// Reads the endpoint and key from the environment.
	if exporter, err := otlptracehttp.New(ctx); err != nil {
		log.Printf("telemetry disabled: %v", err)
	} else {
		tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter))
		defer tp.Shutdown(ctx)
		otel.SetTracerProvider(tp)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /hello", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("hello"))
	})
	// Every request through this handler is traced.
	log.Fatal(http.ListenAndServe(":8080", otelhttp.NewHandler(mux, "server")))
}`,
		},
	},
	{
		language: "java",
		label: "Java",
		description: "Spring, Kotlin, any JVM app",
		key: "private",
		install: `curl -L -o opentelemetry-javaagent.jar \\
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar`,
		env: otlpEnv("my-service"),
		code: {
			label: "Run",
			lang: "bash",
			code: `# Attach the agent when you start the app. No code changes.
java -javaagent:opentelemetry-javaagent.jar -jar app.jar`,
		},
	},
	{
		language: "dotnet",
		label: ".NET",
		description: "ASP.NET Core",
		key: "private",
		install: `dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add package OpenTelemetry.Instrumentation.AspNetCore`,
		env: otlpEnv("my-service", "http"),
		code: {
			label: "Program.cs",
			lang: "csharp",
			code: `using OpenTelemetry;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

// Reads the endpoint, key and service name from the environment.
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing.AddAspNetCoreInstrumentation())
    .UseOtlpExporter();

var app = builder.Build();
app.MapGet("/", () => "Hello!");
app.Run();`,
		},
	},
	{
		language: "laravel",
		label: "Laravel",
		description: "PHP",
		key: "private",
		install: "composer require keepsuit/laravel-opentelemetry",
		env: {
			label: ".env",
			lang: "bash",
			code: `OTEL_SERVICE_NAME=my-service
OTEL_EXPORTER_OTLP_ENDPOINT={{INGEST_URL}}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer {{API_KEY}}"`,
		},
		code: {
			label: "Run",
			lang: "bash",
			code: `# Laravel reads .env, so there is nothing else to add. Start the app and send it a request.
php artisan serve`,
		},
	},
	{
		language: "ruby",
		label: "Ruby",
		description: "Rails, Sinatra",
		key: "private",
		install: "bundle add opentelemetry-sdk opentelemetry-exporter-otlp opentelemetry-instrumentation-all",
		env: otlpEnv("my-service"),
		code: {
			label: "config/initializers/opentelemetry.rb",
			lang: "ruby",
			code: `require "opentelemetry/sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry/instrumentation/all"

# Reads the endpoint, key and service name from the environment,
# and traces Rails, Rack, ActiveRecord, Net::HTTP and Sidekiq.
OpenTelemetry::SDK.configure(&:use_all)`,
		},
	},
	{
		language: "rust",
		label: "Rust",
		description: "Axum, Tokio",
		key: "private",
		// The opentelemetry crates share one minor version, and tracing-opentelemetry 0.32 is built for 0.31.
		install: `cargo add opentelemetry@0.31 opentelemetry_sdk@0.31 opentelemetry-otlp@0.31 tracing-opentelemetry@0.32
cargo add tracing tracing-subscriber`,
		env: otlpEnv("my-service"),
		code: {
			label: "src/main.rs",
			lang: "rust",
			code: `use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Reads the endpoint, key and service name from the environment.
    let exporter = opentelemetry_otlp::SpanExporter::builder().with_http().build()?;
    let provider = SdkTracerProvider::builder().with_batch_exporter(exporter).build();
    tracing_subscriber::registry()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("app")))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Your app: every #[tracing::instrument] function becomes a span.

    provider.shutdown()?;
    Ok(())
}`,
		},
	},
	{
		language: "deno",
		label: "Deno",
		description: "Built-in OpenTelemetry",
		key: "private",
		install: "# Nothing to install: Deno 2.2+ has OpenTelemetry built in.",
		env: otlpEnv("my-service"),
		code: {
			label: "Run",
			lang: "bash",
			code: `# Deno.serve and fetch are traced, console.log becomes logs.
OTEL_DENO=true deno run --allow-net --allow-env main.ts`,
		},
	},
	{
		language: "effect",
		label: "Effect",
		description: "Maple's own SDK (Effect 3: the @effect-v3 tag)",
		key: "private",
		install: { packages: ["@maple-dev/effect-sdk", "effect"] },
		env: {
			label: "Environment",
			lang: "bash",
			code: `export MAPLE_ENDPOINT="{{INGEST_URL}}"
export MAPLE_INGEST_KEY="{{API_KEY}}"`,
		},
		code: {
			label: "telemetry.ts",
			lang: "ts",
			code: `import { Maple } from "@maple-dev/effect-sdk"
import { Effect } from "effect"

// Reads MAPLE_ENDPOINT and MAPLE_INGEST_KEY, plus the commit and environment.
const TracerLive = Maple.layer({ serviceName: "my-effect-app" })

const program = Effect.gen(function* () {
  yield* Effect.log("Hello from Effect!")
}).pipe(Effect.withSpan("hello-maple"))

Effect.runPromise(program.pipe(Effect.provide(TracerLive)))`,
		},
	},
	{
		language: "otel",
		label: "Other",
		description: "Any OpenTelemetry SDK",
		key: "private",
		install: `# Add your language's OpenTelemetry SDK: https://opentelemetry.io/docs/languages/`,
		env: otlpEnv("my-service"),
		code: {
			label: "Run",
			lang: "bash",
			code: `# Every OpenTelemetry SDK reads the variables above.
# Start your app from the same shell.`,
		},
	},
]

/** The snippet's text with the endpoint and key filled in. */
export const fillSnippet = (template: string, ingestUrl: string, apiKey: string): string =>
	Str.replaceAll("{{API_KEY}}", apiKey)(Str.replaceAll("{{INGEST_URL}}", ingestUrl)(template))
