---
name: maple-go-style
description: "Go OpenTelemetry style for Maple: go.opentelemetry.io/otel SDK with otlptracehttp / otlploghttp / otlpmetrichttp exporters, inline endpoint + ingest key, semconv resource attributes including vcs.repository.url.full."
---

# Maple Go style

Use the official `go.opentelemetry.io/otel` SDK with the HTTP exporters. Initialize once at process start and shut down on signal.

## Install

```bash
go get \
  go.opentelemetry.io/otel \
  go.opentelemetry.io/otel/sdk \
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp \
  go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp \
  go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp \
  go.opentelemetry.io/otel/log \
  go.opentelemetry.io/otel/sdk/log
```

## Bootstrap

Inline the endpoint and ingest key. The key is a project-scoped, write-only token (shaped like a Sentry DSN). No env-var indirection. `WithEndpoint` takes a host without scheme, uses HTTPS, and appends the default `/v1/<signal>` path.

```go
package telemetry

import (
	"context"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/log/global"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

const (
	mapleEndpoint = "ingest.maple.dev" // EU: ingest.eu.maple.dev
	mapleKey      = "MAPLE_TEST" // set by maple-onboard skill on pairing
)

func Init(ctx context.Context) (shutdown func(context.Context) error, err error) {
	headers := map[string]string{"authorization": "Bearer " + mapleKey}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName("orders-api"),
			semconv.DeploymentEnvironment(envOr("DEPLOYMENT_ENV", "development")),
			attribute.String("vcs.repository.url.full", "https://github.com/acme/orders-api"),
			attribute.String("vcs.ref.head.revision", envOr("GITHUB_SHA", envOr("GIT_COMMIT", ""))),
		),
	)
	if err != nil {
		return nil, err
	}

	traceExp, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpoint(mapleEndpoint),
		otlptracehttp.WithHeaders(headers),
	)
	if err != nil {
		return nil, err
	}
	tp := trace.NewTracerProvider(trace.WithBatcher(traceExp), trace.WithResource(res))
	otel.SetTracerProvider(tp)

	logExp, err := otlploghttp.New(ctx,
		otlploghttp.WithEndpoint(mapleEndpoint),
		otlploghttp.WithHeaders(headers),
	)
	if err != nil {
		return nil, err
	}
	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExp)),
		sdklog.WithResource(res),
	)
	global.SetLoggerProvider(lp)

	metricExp, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpoint(mapleEndpoint),
		otlpmetrichttp.WithHeaders(headers),
	)
	if err != nil {
		return nil, err
	}
	mp := metric.NewMeterProvider(
		metric.WithReader(metric.NewPeriodicReader(metricExp)),
		metric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	return func(ctx context.Context) error {
		_ = tp.Shutdown(ctx)
		_ = lp.Shutdown(ctx)
		return mp.Shutdown(ctx)
	}, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

Wire from `main`:

```go
func main() {
	ctx := context.Background()
	shutdown, err := telemetry.Init(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer shutdown(ctx)

	// app start
}
```

## Bounded business spans

Acquire the tracer at package scope. Start spans where auto-instrumentation is blind, set the status on error, and end the span via `defer` (imports: `go.opentelemetry.io/otel/attribute`, `go.opentelemetry.io/otel/codes`).

```go
var tracer = otel.Tracer("orders.api")

func SubmitOrder(ctx context.Context, orderID string) (err error) {
	ctx, span := tracer.Start(ctx, "order.submit")
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
		span.End()
	}()

	span.SetAttributes(attribute.String("order.id", orderID))
	return chargeOrder(ctx, orderID)
}
```

## Auto-instrumentation

Go has no framework-level auto-discovery. Add instrumentation packages only for libraries the app imports: `otelhttp`, `otelgrpc`, `otelmux` from `go.opentelemetry.io/contrib/instrumentation/...`, and community packages such as `github.com/XSAM/otelsql`, `github.com/exaring/otelpgx`, and Fiber's `otelfiber` (in `github.com/gofiber/contrib`). Wrap outgoing HTTP clients with `otelhttp.NewTransport` so trace context propagates; Maple's service map draws edges from a Client span to the callee's child Server span.

## Coexistence

If the project already exports to Honeycomb, Datadog, or Tempo, add Maple's exporter alongside with one `trace.WithBatcher(exp)` option per backend. Do not strip the existing exporter unless the user asks.
