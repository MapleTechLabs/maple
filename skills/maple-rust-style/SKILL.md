---
name: maple-rust-style
description: "Rust OpenTelemetry style for Maple: opentelemetry + opentelemetry_sdk + opentelemetry-otlp HTTP exporter, tracing-opentelemetry bridge for the tracing crate, inline endpoint + ingest key, semconv resource attributes."
---

# Maple Rust style

Use the official `opentelemetry` + `opentelemetry_sdk` crates with `opentelemetry-otlp` (HTTP exporter, not gRPC). Bridge the `tracing` crate: `tracing-opentelemetry` turns `tracing` spans into OTel spans, and `opentelemetry-appender-tracing` turns `info!` / `error!` events into OTLP log records.

## Cargo.toml

```toml
[dependencies]
opentelemetry = "0.32"
opentelemetry_sdk = { version = "0.32", features = ["trace", "logs", "metrics"] }
opentelemetry-otlp = { version = "0.32", features = ["http-proto", "reqwest-blocking-client", "reqwest-rustls", "trace", "logs", "metrics"] }
opentelemetry-appender-tracing = "0.32"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
tracing-opentelemetry = "0.33"
```

Keep the `opentelemetry*` crates on one minor version, and pair `tracing-opentelemetry` with the release built for it (0.33 for 0.32). The builder-default batch processors export from their own thread, so use the blocking reqwest client. The async `reqwest-client` panics there with "there is no reactor running". `reqwest-rustls` is required for HTTPS: `opentelemetry-otlp` builds reqwest without default TLS.

## Bootstrap

Inline the endpoint and ingest key. The key is a project-scoped, write-only token (shaped like a Sentry DSN).

```rust
use opentelemetry::{global, trace::TracerProvider as _, KeyValue};
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{
    ExporterBuildError, LogExporter, MetricExporter, Protocol, SpanExporter, WithExportConfig,
    WithHttpConfig,
};
use opentelemetry_sdk::{
    logs::SdkLoggerProvider, metrics::SdkMeterProvider, trace::SdkTracerProvider, Resource,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

const MAPLE_ENDPOINT: &str = "https://ingest.maple.dev"; // EU: https://ingest.eu.maple.dev
const MAPLE_KEY: &str = "MAPLE_TEST"; // set by maple-onboard skill on pairing

pub fn init() -> Result<(SdkTracerProvider, SdkLoggerProvider, SdkMeterProvider), ExporterBuildError> {
    let auth = format!("Bearer {MAPLE_KEY}");
    let mut headers = std::collections::HashMap::new();
    headers.insert("authorization".to_string(), auth);

    let resource = Resource::builder()
        .with_service_name("orders-api")
        .with_attributes([
            KeyValue::new("deployment.environment.name", std::env::var("DEPLOYMENT_ENV").unwrap_or_else(|_| "development".into())),
            KeyValue::new("vcs.repository.url.full", "https://github.com/acme/orders-api"),
            KeyValue::new("vcs.ref.head.revision", std::env::var("GITHUB_SHA").unwrap_or_default()),
        ])
        .build();

    let trace_exporter = SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{MAPLE_ENDPOINT}/v1/traces"))
        .with_headers(headers.clone())
        .with_protocol(Protocol::HttpBinary)
        .build()?;
    let tracer_provider = SdkTracerProvider::builder()
        .with_batch_exporter(trace_exporter)
        .with_resource(resource.clone())
        .build();
    global::set_tracer_provider(tracer_provider.clone());

    let log_exporter = LogExporter::builder()
        .with_http()
        .with_endpoint(format!("{MAPLE_ENDPOINT}/v1/logs"))
        .with_headers(headers.clone())
        .with_protocol(Protocol::HttpBinary)
        .build()?;
    let logger_provider = SdkLoggerProvider::builder()
        .with_batch_exporter(log_exporter)
        .with_resource(resource.clone())
        .build();

    let metric_exporter = MetricExporter::builder()
        .with_http()
        .with_endpoint(format!("{MAPLE_ENDPOINT}/v1/metrics"))
        .with_headers(headers)
        .with_protocol(Protocol::HttpBinary)
        .build()?;
    let meter_provider = SdkMeterProvider::builder()
        .with_periodic_exporter(metric_exporter)
        .with_resource(resource)
        .build();
    global::set_meter_provider(meter_provider.clone());

    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer_provider.tracer("orders.api"));
    let otel_log_layer = OpenTelemetryTracingBridge::new(&logger_provider);

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .with(tracing_subscriber::fmt::layer())
        .with(otel_layer)
        .with(otel_log_layer)
        .init();

    Ok((tracer_provider, logger_provider, meter_provider))
}
```

Call from `main` and shut down on exit:

```rust
#[tokio::main]
async fn main() {
    let (tracer_provider, logger_provider, meter_provider) =
        telemetry::init().expect("telemetry init");

    // app run …

    let _ = tracer_provider.shutdown();
    let _ = logger_provider.shutdown();
    let _ = meter_provider.shutdown();
}
```

## Bounded business spans via `tracing`

Bridging `tracing` keeps existing instrumentation unchanged. Use `#[tracing::instrument]` on bounded async operations:

```rust
#[tracing::instrument(name = "order.submit", skip_all, err, fields(order.id = %order_id))]
async fn submit_order(order_id: &str) -> Result<(), Error> {
    charge_order(order_id).await?;
    Ok(())
}
```

Add `err` to `#[instrument]`. An `Err` return then emits an event with an `error` field, which `tracing-opentelemetry` records as an `exception` event and span status `Error` (both on by default).

## Coexistence

If the project already uses `tracing` with a Honeycomb, Datadog, or Jaeger layer, leave it in place and add Maple's layers alongside. Do not strip the existing exporter unless the user asks.
