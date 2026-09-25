---
title: "Rust Instrumentation"
description: "Instrument a Rust application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 9
navLabel: "Rust"
sdk: "rust"
---

This guide sets up the OpenTelemetry Rust SDK so your application sends traces, logs and metrics to Maple. Spans and log events come from the `tracing` crate, bridged to OpenTelemetry.

To have a coding agent do this setup, use the [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) skill, and [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) to check an existing setup.

## Prerequisites

- Rust 1.75+
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`) for server applications.

## Install

Add these dependencies to `Cargo.toml`. The `opentelemetry*` crates must share one minor version, and `tracing-opentelemetry` must be the release built for it (0.32 pairs with 0.31). This guide pins 0.31, and the `reqwest-tracing` feature further down names the same version.

```toml
[dependencies]
opentelemetry = "0.31"
opentelemetry_sdk = "0.31"
opentelemetry-otlp = "0.31"
opentelemetry-appender-tracing = "0.31"
tracing-opentelemetry = "0.32"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
tokio = { version = "1", features = ["full"] }
```

The default features of `opentelemetry-otlp` export OTLP over HTTP with protobuf encoding, using a blocking HTTP client on the SDK's own background threads.

## Configure

```rust
// src/telemetry.rs
use opentelemetry::{global, trace::TracerProvider as _, KeyValue};
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{LogExporter, MetricExporter, SpanExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{
    logs::SdkLoggerProvider, metrics::SdkMeterProvider, propagation::TraceContextPropagator,
    trace::SdkTracerProvider, Resource,
};
use std::collections::HashMap;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

const MAPLE_ENDPOINT: &str = "https://ingest.maple.dev"; // EU: https://ingest.eu.maple.dev
const MAPLE_KEY: &str = "YOUR_INGEST_KEY";

pub struct Telemetry {
    tracer_provider: SdkTracerProvider,
    meter_provider: SdkMeterProvider,
    logger_provider: SdkLoggerProvider,
}

impl Telemetry {
    pub fn shutdown(&self) {
        let _ = self.tracer_provider.shutdown();
        let _ = self.meter_provider.shutdown();
        let _ = self.logger_provider.shutdown();
    }
}

pub fn init() -> Result<Telemetry, Box<dyn std::error::Error>> {
    let headers = HashMap::from([("Authorization".to_string(), format!("Bearer {MAPLE_KEY}"))]);

    let resource = Resource::builder()
        .with_service_name("my-rust-app")
        .with_attribute(KeyValue::new(
            "deployment.environment.name",
            std::env::var("DEPLOYMENT_ENV").unwrap_or_else(|_| "development".into()),
        ))
        .with_attribute(KeyValue::new(
            "vcs.repository.url.full",
            "https://github.com/acme/my-rust-app",
        ))
        .build();

    let tracer_provider = SdkTracerProvider::builder()
        .with_batch_exporter(
            SpanExporter::builder()
                .with_http()
                .with_endpoint(format!("{MAPLE_ENDPOINT}/v1/traces"))
                .with_headers(headers.clone())
                .build()?,
        )
        .with_resource(resource.clone())
        .build();
    global::set_tracer_provider(tracer_provider.clone());
    // Lets HTTP integrations read and write `traceparent` headers.
    global::set_text_map_propagator(TraceContextPropagator::new());

    let meter_provider = SdkMeterProvider::builder()
        .with_periodic_exporter(
            MetricExporter::builder()
                .with_http()
                .with_endpoint(format!("{MAPLE_ENDPOINT}/v1/metrics"))
                .with_headers(headers.clone())
                .build()?,
        )
        .with_resource(resource.clone())
        .build();
    global::set_meter_provider(meter_provider.clone());

    let logger_provider = SdkLoggerProvider::builder()
        .with_batch_exporter(
            LogExporter::builder()
                .with_http()
                .with_endpoint(format!("{MAPLE_ENDPOINT}/v1/logs"))
                .with_headers(headers)
                .build()?,
        )
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

    Ok(Telemetry { tracer_provider, meter_provider, logger_provider })
}
```

Call `init` from `main`, and shut down before exit so the last batches are sent:

```rust
mod telemetry;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let telemetry = telemetry::init()?;

    // Your application code here

    telemetry.shutdown();
    Ok(())
}
```

The example puts the endpoint and key in source. An ingest key can only write telemetry to your organization. It cannot read data or call the Maple API. Keeping it in source means the SDK always starts with a complete configuration, so a deploy that is missing an environment variable cannot silently turn telemetry off. To keep the key out of source, use [environment variables](#environment-variables) instead.

## Environment variables

When you build an exporter without `with_endpoint` and `with_headers`, it reads the standard OpenTelemetry variables, and `Resource::builder()` reads `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`:

```bash
export OTEL_SERVICE_NAME="my-rust-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-rust-app"
```

With `OTEL_EXPORTER_OTLP_ENDPOINT` set to the base URL, each exporter appends its own signal path.

## Auto-instrumentation

Rust has no automatic library instrumentation. You add a `tracing` integration for each crate you use, and the bridge above turns its spans into OpenTelemetry spans.

### Axum and Tower

```toml
[dependencies]
axum = "0.8"
tower-http = { version = "0.6", features = ["trace"] }
```

```rust
use axum::{routing::get, Router};
use tower_http::trace::TraceLayer;

let app = Router::new()
    .route("/api/orders", get(handle_orders))
    .layer(TraceLayer::new_for_http());
```

`TraceLayer` opens a `tracing` span for every request. It does not read incoming `traceparent` headers or set OpenTelemetry HTTP attributes. For that, use a crate built for it, such as `axum-tracing-opentelemetry`.

### reqwest

```toml
[dependencies]
reqwest = "0.13"
reqwest-middleware = "0.5"
reqwest-tracing = { version = "0.7", features = ["opentelemetry_0_31"] }
```

```rust
use reqwest_middleware::ClientBuilder;
use reqwest_tracing::TracingMiddleware;

let client = ClientBuilder::new(reqwest::Client::new())
    .with(TracingMiddleware::default())
    .build();
```

`reqwest-tracing` injects the trace context into outgoing requests. Its `opentelemetry_0_31` feature must match your `opentelemetry` version; change both together when you upgrade.

## Custom spans

The `#[instrument]` attribute opens a span for each call:

```rust
use tracing::instrument;

#[instrument(skip(payment_client), fields(order.id = %order_id, peer.service = "payment-api"))]
async fn process_order(payment_client: &PaymentClient, order_id: String) -> Result<(), PaymentError> {
    payment_client.charge(&order_id).await?;
    Ok(())
}
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map).

For a span around a block:

```rust
use tracing::{info_span, Instrument};

async fn process_order(order_id: String) {
    let span = info_span!("process-order", order.id = %order_id);
    async move {
        charge_payment(&order_id).await;
    }
    .instrument(span)
    .await;
}
```

## Log correlation

`tracing` events go to the `OpenTelemetryTracingBridge` layer as OpenTelemetry log records. Events emitted inside a span carry its trace and span IDs:

```rust
use tracing::{error, info};

#[tracing::instrument]
async fn process_order(order_id: String) {
    info!(order.id = %order_id, "processing order");

    if let Err(e) = charge_payment(&order_id).await {
        error!(error = %e, "payment failed");
    }
}
```

## Verify

1. Start your application and send it a few requests.
2. In Maple, open **Explore → Traces**. The SDK sends spans in batches every 5 seconds by default, and metrics every 60 seconds.
3. Each request should show up as one trace with a single root span for the request, and child spans for the functions you instrumented.

Your service also appears on the **Services** page once its first spans arrive.

## Troubleshooting

- **`401` responses.** The key is wrong, was copied from the other region, or the header is malformed. The header must be `Authorization: Bearer YOUR_INGEST_KEY`. In `OTEL_EXPORTER_OTLP_HEADERS` it is written `Authorization=Bearer YOUR_INGEST_KEY`. See [Ingest API status codes](/docs/reference/ingest#status-codes).
- **Wrong protocol or path.** Maple accepts OTLP over HTTP. Build exporters with `.with_http()`, not `.with_tonic()`. `with_endpoint` takes the full URL including `/v1/traces`; `OTEL_EXPORTER_OTLP_ENDPOINT` takes only the base URL.
- **Network.** From the machine running the app, run `curl -i https://ingest.maple.dev/v1/traces -X POST`. Any HTTP status code means the host can reach Maple. A timeout or DNS error means a firewall or proxy is blocking outbound HTTPS.
- **Nothing exported.** Shut the providers down before the process exits so buffered data is sent. If the build fails with trait errors between `tracing-opentelemetry` and `opentelemetry`, the versions do not match.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Track errors](/docs/errors/overview)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)
