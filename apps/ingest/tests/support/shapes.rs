//! OTLP requests shaped like real telemetry, shared by `tests/row_heap.rs` and
//! `benches/row_encode_bench.rs` so both measure the same batches.

use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::metrics::v1::{
    metric, number_data_point, Gauge, Histogram, HistogramDataPoint, Metric, NumberDataPoint,
    ResourceMetrics, ScopeMetrics, Sum,
};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{span, ResourceSpans, ScopeSpans, Span, Status};

pub(crate) fn string_attr(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }),
        ..Default::default()
    }
}

pub(crate) fn int_attr(key: &str, value: i64) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue {
            value: Some(any_value::Value::IntValue(value)),
        }),
        ..Default::default()
    }
}

/// What a Kubernetes workload's SDK and collector put on a resource.
pub(crate) fn k8s_resource(pod: usize) -> Resource {
    Resource {
        attributes: vec![
            string_attr("service.name", "checkout-api"),
            string_attr("service.namespace", "storefront"),
            string_attr("service.version", "2026.11.3"),
            string_attr(
                "service.instance.id",
                &format!("checkout-api-7c9d8b6f5-x{pod:04}"),
            ),
            string_attr("deployment.environment.name", "production"),
            string_attr("k8s.cluster.name", "prod-eu-central-1"),
            string_attr("k8s.namespace.name", "storefront"),
            string_attr("k8s.deployment.name", "checkout-api"),
            string_attr("k8s.pod.name", &format!("checkout-api-7c9d8b6f5-x{pod:04}")),
            string_attr(
                "k8s.node.name",
                "ip-10-12-44-201.eu-central-1.compute.internal",
            ),
            string_attr("cloud.provider", "aws"),
            string_attr("cloud.region", "eu-central-1"),
            string_attr("host.name", "ip-10-12-44-201"),
            string_attr("telemetry.sdk.name", "opentelemetry"),
            string_attr("telemetry.sdk.language", "nodejs"),
            string_attr("telemetry.sdk.version", "2.2.0"),
            int_attr("process.pid", 1),
        ],
        ..Default::default()
    }
}

/// A JVM service whose agent reports its whole command line on the resource.
pub(crate) fn jvm_resource() -> Resource {
    let classpath = (0..90).fold(String::new(), |mut classpath, jar| {
        classpath.push_str(&format!(
            "/opt/app/lib/dependency-artifact-{jar:03}-1.4.{jar}.jar:"
        ));
        classpath
    });
    let mut resource = k8s_resource(0);
    resource.attributes.extend([
        string_attr("process.runtime.name", "OpenJDK Runtime Environment"),
        string_attr("process.runtime.version", "21.0.5+11-LTS"),
        string_attr("process.executable.path", "/usr/lib/jvm/java-21/bin/java"),
        string_attr(
            "process.command_line",
            &format!("/usr/lib/jvm/java-21/bin/java -Xmx2g -cp {classpath} com.example.Main"),
        ),
    ]);
    resource
}

fn scope(name: &str) -> InstrumentationScope {
    InstrumentationScope {
        name: name.to_owned(),
        version: "0.58.1".to_owned(),
        ..Default::default()
    }
}

fn id_bytes(seed: usize, len: usize) -> Vec<u8> {
    (0..len)
        .map(|at| u8::try_from((seed * 31 + at * 7) % 251).unwrap_or(0) + 1)
        .collect()
}

fn http_span(index: usize) -> Span {
    Span {
        trace_id: id_bytes(index / 8, 16),
        span_id: id_bytes(index, 8),
        parent_span_id: id_bytes(index / 8, 8),
        name: format!("GET /api/carts/:id/items/{}", index % 40),
        kind: span::SpanKind::Server as i32,
        start_time_unix_nano: 1_763_200_000_000_000_000 + index as u64 * 1_000,
        end_time_unix_nano: 1_763_200_000_042_000_000 + index as u64 * 1_000,
        attributes: vec![
            string_attr("http.request.method", "GET"),
            string_attr("http.route", "/api/carts/:id/items"),
            string_attr("url.path", &format!("/api/carts/{index}/items")),
            string_attr("url.scheme", "https"),
            string_attr("server.address", "checkout.internal.example.com"),
            int_attr("server.port", 443),
            int_attr("http.response.status_code", 200),
            string_attr("network.protocol.version", "1.1"),
            string_attr(
                "user_agent.original",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
            ),
            string_attr("client.address", "10.12.7.33"),
            string_attr("tenant.id", &format!("tenant-{}", index % 97)),
            string_attr("db.system.name", "postgresql"),
            string_attr("db.query.summary", "SELECT cart_items"),
            int_attr("db.response.returned_rows", 12),
            string_attr("maple.cache", "miss"),
        ],
        events: if index.is_multiple_of(10) {
            vec![span::Event {
                time_unix_nano: 1_763_200_000_010_000_000,
                name: "exception".to_owned(),
                attributes: vec![
                    string_attr("exception.type", "CartLockTimeout"),
                    string_attr("exception.message", "lock wait exceeded 250ms for cart row"),
                    string_attr(
                        "exception.stacktrace",
                        "CartLockTimeout: lock wait exceeded\n    at lock (cart.ts:88:13)\n    at handler (items.ts:41:9)",
                    ),
                ],
                ..Default::default()
            }]
        } else {
            Vec::new()
        },
        status: Some(Status {
            code: i32::from(index.is_multiple_of(10)) * 2,
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// `spans` HTTP server spans from one pod, one in ten with an exception event.
pub(crate) fn traces(spans: usize) -> ExportTraceServiceRequest {
    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(k8s_resource(0)),
            scope_spans: vec![ScopeSpans {
                scope: Some(scope("@opentelemetry/instrumentation-http")),
                spans: (0..spans).map(http_span).collect(),
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

/// `records` application log lines from one pod, each tied to a trace.
pub(crate) fn logs(records: usize) -> ExportLogsServiceRequest {
    let log_records = (0..records)
        .map(|index| LogRecord {
            time_unix_nano: 1_763_200_000_000_000_000 + index as u64 * 1_000,
            observed_time_unix_nano: 1_763_200_000_000_500_000 + index as u64 * 1_000,
            severity_number: 9,
            severity_text: "INFO".to_owned(),
            body: Some(AnyValue {
                value: Some(any_value::Value::StringValue(format!(
                    "cart {index} priced in 12ms for tenant-{} with 4 line items and 1 coupon",
                    index % 97
                ))),
            }),
            attributes: vec![
                string_attr("log.logger", "checkout.pricing"),
                string_attr("code.function.name", "priceCart"),
                string_attr("tenant.id", &format!("tenant-{}", index % 97)),
                int_attr("cart.items", 4),
            ],
            trace_id: id_bytes(index / 4, 16),
            span_id: id_bytes(index, 8),
            ..Default::default()
        })
        .collect();
    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(k8s_resource(0)),
            scope_logs: vec![ScopeLogs {
                scope: Some(scope("pino")),
                log_records,
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

fn number_points(points: usize, series: usize) -> Vec<NumberDataPoint> {
    (0..points)
        .map(|index| NumberDataPoint {
            attributes: vec![
                string_attr("state", ["used", "free", "cached", "buffered"][index % 4]),
                string_attr("device", &format!("nvme{}n1", (series + index) % 6)),
            ],
            start_time_unix_nano: 1_763_190_000_000_000_000,
            time_unix_nano: 1_763_200_000_000_000_000,
            #[expect(
                clippy::cast_precision_loss,
                reason = "fixture values, any float will do"
            )]
            value: Some(number_data_point::Value::AsDouble(index as f64 * 0.37)),
            ..Default::default()
        })
        .collect()
}

fn histogram_points(points: usize) -> Vec<HistogramDataPoint> {
    (0..points)
        .map(|index| HistogramDataPoint {
            attributes: vec![
                string_attr("http.request.method", "GET"),
                string_attr(
                    "http.route",
                    &format!("/api/carts/:id/items/{}", index % 40),
                ),
                int_attr("http.response.status_code", 200),
            ],
            start_time_unix_nano: 1_763_190_000_000_000_000,
            time_unix_nano: 1_763_200_000_000_000_000,
            count: 1_840,
            sum: Some(77.25),
            bucket_counts: vec![12, 40, 310, 820, 400, 180, 50, 20, 5, 2, 1, 0, 0, 0, 0],
            explicit_bounds: vec![
                0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0,
            ],
            min: Some(0.002),
            max: Some(1.9),
            ..Default::default()
        })
        .collect()
}

fn metric(name: &str, description: &str, unit: &str, data: metric::Data) -> Metric {
    Metric {
        name: name.to_owned(),
        description: description.to_owned(),
        unit: unit.to_owned(),
        data: Some(data),
        ..Default::default()
    }
}

/// About `points` data points from `resource`: gauges and sums in series of
/// twenty-four, and a tenth of the points as request duration histograms.
pub(crate) fn metrics_from(resource: Resource, points: usize) -> ExportMetricsServiceRequest {
    let per_metric = 24;
    let number_metrics = (points - points / 10).div_ceil(per_metric * 2).max(1);
    let mut metrics = Vec::with_capacity(number_metrics * 2 + 1);
    for series in 0..number_metrics {
        metrics.push(metric(
            &format!("system.filesystem.usage.{series}"),
            "Filesystem bytes used, by state and device.",
            "By",
            metric::Data::Gauge(Gauge {
                data_points: number_points(per_metric, series),
            }),
        ));
        metrics.push(metric(
            &format!("system.disk.io.{series}"),
            "Disk bytes transferred, by direction and device.",
            "By",
            metric::Data::Sum(Sum {
                data_points: number_points(per_metric, series),
                aggregation_temporality: 2,
                is_monotonic: true,
            }),
        ));
    }
    metrics.push(metric(
        "http.server.request.duration",
        "Duration of HTTP server requests.",
        "s",
        metric::Data::Histogram(Histogram {
            data_points: histogram_points((points / 10).max(1)),
            aggregation_temporality: 2,
        }),
    ));
    ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            resource: Some(resource),
            scope_metrics: vec![ScopeMetrics {
                scope: Some(scope("otelcol/hostmetricsreceiver")),
                metrics,
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

pub(crate) fn metrics(points: usize) -> ExportMetricsServiceRequest {
    metrics_from(k8s_resource(0), points)
}
