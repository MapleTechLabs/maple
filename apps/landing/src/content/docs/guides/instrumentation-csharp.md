---
title: "C# / .NET instrumentation"
description: "Instrument a .NET application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 12
navLabel: "C# / .NET"
sdk: "csharp"
---

This guide sets up the OpenTelemetry .NET SDK in an ASP.NET Core or generic-host application so it sends traces, logs and metrics to Maple, with instrumentation for ASP.NET Core and `HttpClient`.

To have a coding agent do this setup, use the [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) skill, and [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) to check an existing setup.

## Prerequisites

- .NET 8+ (the packages also target .NET Framework 4.6.2+)
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`) for server applications.

## Install

```bash
dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Instrumentation.Http
```

## Configure

Wire OpenTelemetry into the host builder in `Program.cs`. Each signal gets its own OTLP exporter:

```csharp
using OpenTelemetry;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

const string MapleEndpoint = "https://ingest.maple.dev"; // EU: https://ingest.eu.maple.dev
const string MapleHeaders = "Authorization=Bearer YOUR_INGEST_KEY";

void ConfigureMaple(OtlpExporterOptions opts, string path)
{
    opts.Endpoint = new Uri($"{MapleEndpoint}{path}");
    opts.Protocol = OtlpExportProtocol.HttpProtobuf;
    opts.Headers = MapleHeaders;
}

builder.Services.AddOpenTelemetry()
    .ConfigureResource(resource => resource
        .AddService(serviceName: "my-dotnet-app", serviceVersion: "1.0.0")
        .AddAttributes(new Dictionary<string, object>
        {
            ["deployment.environment.name"] = builder.Environment.EnvironmentName,
            ["vcs.repository.url.full"] = "https://github.com/acme/my-dotnet-app",
        }))
    .WithTracing(tracing => tracing
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter(opts => ConfigureMaple(opts, "/v1/traces")))
    .WithMetrics(metrics => metrics
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter(opts => ConfigureMaple(opts, "/v1/metrics")))
    .WithLogging(logging => logging
        .AddOtlpExporter(opts => ConfigureMaple(opts, "/v1/logs")));

var app = builder.Build();
app.MapGet("/", () => "Hello!");
app.Run();
```

When you set `Endpoint` in code, it must include the signal path (`/v1/traces`, `/v1/metrics`, `/v1/logs`). The exporter's default protocol is gRPC, so set `HttpProtobuf` on each one.

The example puts the endpoint and key in source. An ingest key can only write telemetry to your organization. It cannot read data or call the Maple API. Keeping it in source means the SDK always starts with a complete configuration, so a deploy that is missing an environment variable cannot silently turn telemetry off. To keep the key out of source, use [environment variables](#environment-variables) instead.

For a console app or worker without a host, build the providers directly and dispose them on exit:

```csharp
using var tracerProvider = Sdk.CreateTracerProviderBuilder()
    .ConfigureResource(r => r.AddService("my-dotnet-worker"))
    .AddSource("my-dotnet-worker")
    .AddHttpClientInstrumentation()
    .AddOtlpExporter(opts => ConfigureMaple(opts, "/v1/traces"))
    .Build();

using var meterProvider = Sdk.CreateMeterProviderBuilder()
    .ConfigureResource(r => r.AddService("my-dotnet-worker"))
    .AddMeter("my-dotnet-worker")
    .AddOtlpExporter(opts => ConfigureMaple(opts, "/v1/metrics"))
    .Build();
```

## Environment variables

`UseOtlpExporter()` sets up one OTLP exporter for every signal you enabled and reads its settings from the standard environment variables:

```bash
export OTEL_SERVICE_NAME="my-dotnet-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-dotnet-app"
```

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation())
    .WithMetrics(metrics => metrics.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation())
    .WithLogging()
    .UseOtlpExporter();
```

With `http/protobuf`, the exporter appends `/v1/traces`, `/v1/metrics` and `/v1/logs` to the base endpoint. Traces, metrics and logs are all exported, because each one is enabled above.

## Auto-instrumentation

.NET instrumentation comes from one NuGet package per library, registered on the tracing or metrics builder with `.AddXxxInstrumentation()`:

| Library               | Package                                             |
| --------------------- | --------------------------------------------------- |
| ASP.NET Core          | `OpenTelemetry.Instrumentation.AspNetCore`          |
| HttpClient            | `OpenTelemetry.Instrumentation.Http`                |
| Entity Framework Core | `OpenTelemetry.Instrumentation.EntityFrameworkCore` |
| SqlClient             | `OpenTelemetry.Instrumentation.SqlClient`           |
| StackExchange.Redis   | `OpenTelemetry.Instrumentation.StackExchangeRedis`  |
| gRPC client           | `OpenTelemetry.Instrumentation.GrpcNetClient`       |
| .NET runtime metrics  | `OpenTelemetry.Instrumentation.Runtime`             |

ASP.NET Core turns each incoming request into a server span and records request duration metrics. `HttpClient` calls become client spans that carry the trace context to the service you call.

## Custom spans

In .NET, spans are `System.Diagnostics.Activity` objects. Create an `ActivitySource` and start activities from it:

```csharp
using System.Diagnostics;

public class OrderService
{
    private static readonly ActivitySource ActivitySource = new("MyApp.Orders");

    public async Task ProcessOrder(string orderId)
    {
        using var activity = ActivitySource.StartActivity("process-order");
        activity?.SetTag("order.id", orderId);
        activity?.SetTag("payment.method", "card");

        try
        {
            await ChargePayment(orderId);
        }
        catch (Exception ex)
        {
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            activity?.AddException(ex);
            throw;
        }
    }
}
```

Register the source name so its activities are exported:

```csharp
.WithTracing(tracing => tracing
    .AddSource("MyApp.Orders")
    // ...
)
```

Service map edges come from instrumented client spans that propagate `traceparent` to an instrumented callee, not from attributes such as `peer.service`. See [Service map](/docs/explore/service-map).

## Log correlation

With `WithLogging()` configured, `ILogger<T>` records are exported as OpenTelemetry log records. Records written during an active activity carry its trace and span IDs, so Maple links each log line to its trace:

```csharp
public class OrderService(ILogger<OrderService> logger)
{
    public async Task ProcessOrder(string orderId)
    {
        logger.LogInformation("Processing order {OrderId}", orderId);
    }
}
```

## Verify

1. Run your application (`dotnet run`) and send it a few requests.
2. In Maple, open **Explore → Traces**. The SDK sends spans in batches every 5 seconds by default, and metrics every 60 seconds.
3. Each request should show up as one trace with a single root server span, named after the method and route (for example `GET /api/orders`), and child spans for the queries and outgoing calls it made.

Your service also appears on the **Services** page once its first spans arrive.

## Troubleshooting

- **`401` responses.** The key is wrong, was copied from the other region, or the header is malformed. `OtlpExporterOptions.Headers` and `OTEL_EXPORTER_OTLP_HEADERS` both take `Authorization=Bearer YOUR_INGEST_KEY`. See [Ingest API status codes](/docs/reference/ingest#status-codes).
- **Wrong protocol or path.** Maple accepts OTLP over HTTP, and the .NET exporter defaults to gRPC. Set `OtlpExportProtocol.HttpProtobuf` in code or `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`. An endpoint set in code needs the full signal path; the environment variable takes only the base URL.
- **Network.** From the machine running the app, run `curl -i https://ingest.maple.dev/v1/traces -X POST`. Any HTTP status code means the host can reach Maple. A timeout or DNS error means a firewall or proxy is blocking outbound HTTPS.
- **Nothing exported.** Custom spans only export when their `ActivitySource` name is registered with `AddSource`, and custom metrics when their `Meter` name is registered with `AddMeter`. In console apps, dispose the providers before exit so the last batch is sent.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Track errors](/docs/errors/overview)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)
