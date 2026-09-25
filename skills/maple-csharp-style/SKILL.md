---
name: maple-csharp-style
description: ".NET / C# OpenTelemetry style for Maple: OpenTelemetry.Extensions.Hosting + OTLP HTTP exporter, ActivitySource for spans, ILogger bridging via WithLogging, inline endpoint + ingest key."
---

# Maple .NET / C# style

Use the official `OpenTelemetry` packages and wire them through the .NET hosting model. One `AddOpenTelemetry()` call on `IServiceCollection` configures traces, metrics, and `ILogger` export with a shared resource (`WithLogging` needs `OpenTelemetry.Extensions.Hosting` 1.9 or later).

## Install

```bash
dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Instrumentation.Http
```

## Bootstrap (ASP.NET Core)

Inline the endpoint and ingest key. The key is a project-scoped, write-only token (shaped like a Sentry DSN). No env-var indirection. With `HttpProtobuf`, an `Endpoint` set in code is used as-is, so include the `/v1/<signal>` path.

```csharp
using OpenTelemetry;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

const string MapleEndpoint = "https://ingest.maple.dev"; // EU: https://ingest.eu.maple.dev
const string MapleKey = "MAPLE_TEST"; // set by maple-onboard skill on pairing

var builder = WebApplication.CreateBuilder(args);

void ConfigureOtlp(OtlpExporterOptions options, string path)
{
    options.Endpoint = new Uri($"{MapleEndpoint}/v1/{path}");
    options.Protocol = OtlpExportProtocol.HttpProtobuf;
    options.Headers = $"authorization=Bearer {MapleKey}";
}

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r
        .AddService("orders-api")
        .AddAttributes(new Dictionary<string, object>
        {
            ["deployment.environment.name"] = builder.Environment.EnvironmentName,
            ["vcs.repository.url.full"] = "https://github.com/acme/orders-api",
            ["vcs.ref.head.revision"] = Environment.GetEnvironmentVariable("GITHUB_SHA") ?? "",
        }))
    .WithTracing(tracing => tracing
        .AddSource("orders.api") // every custom ActivitySource name, or its spans are dropped
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter(o => ConfigureOtlp(o, "traces")))
    .WithMetrics(metrics => metrics
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter(o => ConfigureOtlp(o, "metrics")))
    .WithLogging(
        logging => logging.AddOtlpExporter(o => ConfigureOtlp(o, "logs")),
        options =>
        {
            options.IncludeFormattedMessage = true;
            options.IncludeScopes = true;
        });

var app = builder.Build();
```

## Bounded business spans

Use a static `ActivitySource` per module and register its name with `.AddSource(...)`. Unregistered sources produce no spans: `StartActivity` returns `null`. ASP.NET Core and HttpClient instrumentation cover request spans. Use `ActivitySource.StartActivity` for business operations.

```csharp
public static class Tracing
{
    public static readonly ActivitySource Source = new("orders.api");
}

public sealed class OrderService
{
    public async Task SubmitAsync(string orderId, string tenantId)
    {
        using var activity = Tracing.Source.StartActivity("order.submit");
        activity?.SetTag("tenant.id", tenantId);
        activity?.SetTag("order.id", orderId);
        try
        {
            await ChargeAsync(orderId);
        }
        catch (Exception ex)
        {
            activity?.RecordException(ex);
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            throw;
        }
    }
}
```

`ActivitySource` and `ActivityStatusCode` live in `System.Diagnostics`. `RecordException(Exception)` is an extension method in `OpenTelemetry.Trace`, so add `using OpenTelemetry.Trace;`.

## Logs

Once `WithLogging` is wired, `ILogger<T>` records carry the active `Activity`'s `TraceId` / `SpanId`. Do not replace the user's existing logger or providers; OTLP export runs alongside them.

## Coexistence

If the project already exports to Application Insights, Datadog, or Honeycomb, keep those. `WithTracing(...)` accepts multiple exporters: chain `.AddOtlpExporter(...)` for Maple next to the existing one.
