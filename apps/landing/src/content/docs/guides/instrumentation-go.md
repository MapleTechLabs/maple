---
title: "Go Instrumentation"
description: "Instrument a Go application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 8
navLabel: "Go"
sdk: "go"
---

This guide sets up the OpenTelemetry Go SDK so your application sends traces, logs and metrics to Maple, and adds instrumentation for `net/http`, gRPC and `database/sql`.

To have a coding agent do this setup, use the [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) skill, and [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) to check an existing setup.

## Prerequisites

- Go 1.23+
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`) for server applications.

## Install

```bash
go get go.opentelemetry.io/otel \
  go.opentelemetry.io/otel/sdk \
  go.opentelemetry.io/otel/sdk/metric \
  go.opentelemetry.io/otel/sdk/log \
  go.opentelemetry.io/otel/log \
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp \
  go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp \
  go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp
```

## Configure

Set up the three providers at startup and shut them down on exit:

```go
package main

import (
	"context"
	"errors"
	"log"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

const mapleEndpoint = "https://ingest.maple.dev" // EU: https://ingest.eu.maple.dev
const mapleKey = "YOUR_INGEST_KEY"

func initTelemetry(ctx context.Context) (func(context.Context) error, error) {
	headers := map[string]string{"Authorization": "Bearer " + mapleKey}

	res, err := resource.New(ctx, resource.WithAttributes(
		attribute.String("service.name", "my-go-app"),
		attribute.String("deployment.environment.name", os.Getenv("DEPLOYMENT_ENV")),
		attribute.String("vcs.repository.url.full", "https://github.com/acme/my-go-app"),
	))
	if err != nil {
		return nil, err
	}

	traceExporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL(mapleEndpoint+"/v1/traces"),
		otlptracehttp.WithHeaders(headers),
	)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(traceExporter), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))

	metricExporter, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpointURL(mapleEndpoint+"/v1/metrics"),
		otlpmetrichttp.WithHeaders(headers),
	)
	if err != nil {
		return nil, err
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExporter)),
		sdkmetric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	logExporter, err := otlploghttp.New(ctx,
		otlploghttp.WithEndpointURL(mapleEndpoint+"/v1/logs"),
		otlploghttp.WithHeaders(headers),
	)
	if err != nil {
		return nil, err
	}
	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter)),
		sdklog.WithResource(res),
	)
	global.SetLoggerProvider(lp)

	shutdown := func(ctx context.Context) error {
		return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx), lp.Shutdown(ctx))
	}
	return shutdown, nil
}

func main() {
	ctx := context.Background()

	shutdown, err := initTelemetry(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer shutdown(ctx)

	// Your application code here
}
```

The example puts the endpoint and key in source. An ingest key can only write telemetry to your organization. It cannot read data or call the Maple API. Keeping it in source means the SDK always starts with a complete configuration, so a deploy that is missing an environment variable cannot silently turn telemetry off. To keep the key out of source, use [environment variables](#environment-variables) instead.

## Environment variables

The Go exporters read the standard OpenTelemetry variables when you create them without endpoint or header options:

```bash
export OTEL_SERVICE_NAME="my-go-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-go-app"
```

In `initTelemetry`, call `otlptracehttp.New(ctx)`, `otlpmetrichttp.New(ctx)` and `otlploghttp.New(ctx)` with no options, and build the resource with `resource.New(ctx, resource.WithFromEnv())` so it reads `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`. The `*http` exporters always use OTLP over HTTP; setting the protocol variable keeps the configuration explicit for any other tool that reads it.

## Auto-instrumentation

Go has no automatic library discovery. You add an instrumentation package for each library you use.

### HTTP server

```bash
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
```

```go
import "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

mux := http.NewServeMux()
mux.HandleFunc("GET /api/orders", handleOrders)

// Every request becomes a server span
handler := otelhttp.NewHandler(mux, "server")
http.ListenAndServe(":8080", handler)
```

### HTTP client

Wrap the transport so outgoing requests get client spans and carry the trace context:

```go
client := &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)}
req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.example.com/data", nil)
resp, err := client.Do(req)
```

### gRPC

```bash
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc
```

```go
import "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"

// Server
server := grpc.NewServer(grpc.StatsHandler(otelgrpc.NewServerHandler()))

// Client
conn, err := grpc.NewClient(addr, grpc.WithStatsHandler(otelgrpc.NewClientHandler()))
```

### Database

```bash
go get github.com/XSAM/otelsql
```

```go
import "github.com/XSAM/otelsql"

db, err := otelsql.Open("postgres", dsn)
```

Pass the request `ctx` to `db.QueryContext` and friends so query spans nest under the request span.

## Custom spans

```go
import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

var tracer = otel.Tracer("my-app")

func processOrder(ctx context.Context, orderID string) error {
	ctx, span := tracer.Start(ctx, "process-order")
	defer span.End()

	span.SetAttributes(
		attribute.String("order.id", orderID),
		// Set peer.service when calling another service
		attribute.String("peer.service", "payment-api"),
	)

	if err := chargePayment(ctx, orderID); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}
	return nil
}
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map). Always pass `ctx` down the call chain so child spans link to their parent.

## Log correlation

The `otelslog` bridge sends `log/slog` records to the logger provider configured above. Records logged with a context that holds an active span carry its trace and span IDs:

```bash
go get go.opentelemetry.io/contrib/bridges/otelslog
```

```go
import "go.opentelemetry.io/contrib/bridges/otelslog"

logger := otelslog.NewLogger("my-app")
logger.InfoContext(ctx, "Order processed", "order_id", orderID)
```

Use the `...Context` methods. Without the context, the bridge cannot find the active span.

## Verify

1. Start your application and send it a few requests.
2. In Maple, open **Explore → Traces**. The SDK sends spans in batches every 5 seconds by default, and metrics every 60 seconds.
3. Each request should show up as one trace with a single root server span, and child spans for the queries and outgoing calls it made. `otelhttp` names the server span with the operation name you pass to `NewHandler`, and records the route in `http.route`.

Your service also appears on the **Services** page once its first spans arrive.

## Troubleshooting

- **`401` responses.** The key is wrong, was copied from the other region, or the header is malformed. The header must be `Authorization: Bearer YOUR_INGEST_KEY`. In `OTEL_EXPORTER_OTLP_HEADERS` it is written `Authorization=Bearer YOUR_INGEST_KEY`. See [Ingest API status codes](/docs/reference/ingest#status-codes).
- **Wrong protocol or path.** Maple accepts OTLP over HTTP. Use the `otlp*http` exporters, not `otlp*grpc`. `WithEndpointURL` takes the full URL including `/v1/traces`; `OTEL_EXPORTER_OTLP_ENDPOINT` takes only the base URL.
- **Network.** From the machine running the app, run `curl -i https://ingest.maple.dev/v1/traces -X POST`. Any HTTP status code means the host can reach Maple. A timeout or DNS error means a firewall or proxy is blocking outbound HTTPS.
- **Nothing exported.** Call the shutdown function before `main` returns so the batchers flush. Code that calls `os.Exit` or `log.Fatal` skips deferred calls. Register an error handler with `otel.SetErrorHandler` to print export failures.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Track errors](/docs/errors/overview)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)
