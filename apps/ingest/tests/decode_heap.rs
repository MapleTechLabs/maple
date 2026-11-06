//! `decode_budget`'s estimates against what decoding really allocates, measured
//! with a counting allocator. Its own binary, so the allocator sees only this.

#![expect(
    unsafe_code,
    reason = "a counting GlobalAlloc has to implement the unsafe trait"
)]
#![expect(
    clippy::unwrap_used,
    clippy::panic,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::default_trait_access,
    clippy::too_many_lines,
    clippy::unnecessary_wraps,
    reason = "test fixtures: small known sizes, and one table of cases per signal"
)]

use maple_ingest::decode_budget::{json_cost, protobuf_cost, OtlpSignal};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{
    any_value, AnyValue, ArrayValue, EntityRef, InstrumentationScope, KeyValue, KeyValueList,
};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::metrics::v1::{
    exponential_histogram_data_point::Buckets, metric, number_data_point,
    summary_data_point::ValueAtQuantile, Exemplar, ExponentialHistogram,
    ExponentialHistogramDataPoint, Gauge, Histogram, HistogramDataPoint, Metric, NumberDataPoint,
    ResourceMetrics, ScopeMetrics, Sum, Summary, SummaryDataPoint,
};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{span, ResourceSpans, ScopeSpans, Span, Status};
use prost::Message;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct Counting;

thread_local! {
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.with(|live| {
            let now = live.get() + layout.size();
            live.set(now);
            PEAK.with(|peak| peak.set(peak.get().max(now)));
        });
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.with(|live| live.set(live.get().saturating_sub(layout.size())));
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Peak bytes allocated on this thread while `run` runs, above what was live before.
fn peak_during<T>(run: impl FnOnce() -> T) -> (usize, T) {
    let base = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(base));
    let out = run();
    (PEAK.with(Cell::get) - base, out)
}

fn string_attr(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }),
        ..Default::default()
    }
}

fn attrs(n: usize, seed: usize) -> Vec<KeyValue> {
    (0..n)
        .map(|i| string_attr(&format!("attribute.key.{i}"), &format!("value-{seed}-{i}")))
        .collect()
}

fn resource() -> Option<Resource> {
    Some(Resource {
        attributes: attrs(12, 0),
        ..Default::default()
    })
}

fn traces(spans: usize) -> ExportTraceServiceRequest {
    let spans = (0..spans)
        .map(|i| Span {
            trace_id: vec![7; 16],
            span_id: vec![i as u8; 8],
            parent_span_id: vec![3; 8],
            name: format!("GET /api/items/{}", i % 40),
            kind: 2,
            start_time_unix_nano: 1_700_000_000_000_000_000,
            end_time_unix_nano: 1_700_000_000_100_000_000,
            attributes: attrs(15, i),
            events: if i % 10 == 0 {
                vec![span::Event {
                    name: "exception".to_owned(),
                    attributes: attrs(3, i),
                    ..Default::default()
                }]
            } else {
                Vec::new()
            },
            ..Default::default()
        })
        .collect();
    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: resource(),
            scope_spans: vec![ScopeSpans {
                spans,
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

fn logs(records: usize) -> ExportLogsServiceRequest {
    let log_records = (0..records)
        .map(|i| LogRecord {
            time_unix_nano: 1_700_000_000_000_000_000,
            severity_number: 9,
            severity_text: "INFO".to_owned(),
            body: Some(AnyValue {
                value: Some(any_value::Value::StringValue(format!(
                    "request {i} handled in 12ms for tenant acme with status 200"
                ))),
            }),
            attributes: attrs(8, i),
            trace_id: vec![1; 16],
            span_id: vec![2; 8],
            ..Default::default()
        })
        .collect();
    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: resource(),
            scope_logs: vec![ScopeLogs {
                log_records,
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

fn metrics(points: usize) -> ExportMetricsServiceRequest {
    let gauge_points = (0..points)
        .map(|i| NumberDataPoint {
            attributes: attrs(8, i),
            time_unix_nano: 1_700_000_000_000_000_000,
            value: Some(number_data_point::Value::AsDouble(i as f64)),
            ..Default::default()
        })
        .collect();
    let histogram_points = (0..points / 10)
        .map(|i| HistogramDataPoint {
            attributes: attrs(6, i),
            count: 100,
            bucket_counts: vec![1; 16],
            explicit_bounds: vec![0.5; 15],
            ..Default::default()
        })
        .collect();
    ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            resource: resource(),
            scope_metrics: vec![ScopeMetrics {
                metrics: vec![
                    Metric {
                        name: "system.cpu.utilization".to_owned(),
                        data: Some(metric::Data::Gauge(Gauge {
                            data_points: gauge_points,
                        })),
                        ..Default::default()
                    },
                    Metric {
                        name: "http.server.duration".to_owned(),
                        data: Some(metric::Data::Histogram(Histogram {
                            data_points: histogram_points,
                            aggregation_temporality: 2,
                        })),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

/// `count` copies of a field holding an empty message: two bytes each on the wire.
fn empty_entries(field: u8, count: usize) -> Vec<u8> {
    [field << 3 | 2, 0].repeat(count)
}

/// An `ExportLogsServiceRequest` of one record carrying `count` empty attributes.
fn empty_attributes(count: usize) -> Vec<u8> {
    let record = empty_entries(6, count);
    let scope = nest(2, &record);
    let resource_logs = nest(2, &scope);
    nest(1, &resource_logs)
}

fn nest(field: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![field << 3 | 2];
    let mut len = body.len();
    while len >= 0x80 {
        out.push((len as u8) | 0x80);
        len >>= 7;
    }
    out.push(len as u8);
    out.extend_from_slice(body);
    out
}

/// A histogram metric whose one data point holds `field: [element, element, ...]`.
fn json_histogram(field: &str, element: &str) -> String {
    let elements = vec![element; 200_000].join(",");
    format!(
        "{{\"resourceMetrics\":[{{\"scopeMetrics\":[{{\"metrics\":[{{\"name\":\"h\",\
         \"histogram\":{{\"dataPoints\":[{{\"{field}\":[{elements}]}}]}}}}]}}]}}]}}"
    )
}

struct Measured {
    case: &'static str,
    /// Shaped like real telemetry, so the estimate must not overshoot it much.
    realistic: bool,
    wire: usize,
    actual: usize,
    estimate: u64,
}

fn protobuf_case<T: Message + Default>(
    case: &'static str,
    signal: OtlpSignal,
    wire: &[u8],
) -> Measured {
    let estimate = protobuf_cost(signal, wire, u64::MAX).unwrap();
    let (actual, decoded) = peak_during(|| T::decode(wire));
    decoded.unwrap_or_else(|error| panic!("{case} decodes: {error}"));
    Measured {
        case,
        realistic: !case.contains("empty") && !case.contains("keyed"),
        wire: wire.len(),
        actual,
        estimate,
    }
}

fn json_case<T: serde::de::DeserializeOwned>(
    case: &'static str,
    root: &str,
    wire: &[u8],
) -> Measured {
    let estimate = json_cost(wire, u64::MAX).unwrap();
    let (actual, decoded) = peak_during(|| {
        let mut json: serde_json::Value = serde_json::from_slice(wire)?;
        maple_ingest::otlp_json::normalize(&mut json, root);
        serde_json::from_value::<T>(json)
    });
    decoded.unwrap_or_else(|error| panic!("{case} decodes: {error}"));
    Measured {
        case,
        realistic: !case.contains("empty") && !case.contains("keyed"),
        wire: wire.len(),
        actual,
        estimate,
    }
}

fn cases() -> Vec<Measured> {
    use OtlpSignal::{Logs, Metrics, Traces};
    vec![
        protobuf_case::<ExportTraceServiceRequest>(
            "traces",
            Traces,
            &traces(4_000).encode_to_vec(),
        ),
        protobuf_case::<ExportLogsServiceRequest>("logs", Logs, &logs(4_000).encode_to_vec()),
        protobuf_case::<ExportMetricsServiceRequest>(
            "metrics",
            Metrics,
            &metrics(10_000).encode_to_vec(),
        ),
        protobuf_case::<ExportTraceServiceRequest>(
            "empty resource spans",
            Traces,
            &empty_entries(1, 200_000),
        ),
        protobuf_case::<ExportLogsServiceRequest>(
            "empty attributes",
            Logs,
            &empty_attributes(200_000),
        ),
        protobuf_case::<ExportMetricsServiceRequest>(
            "empty resource metrics",
            Metrics,
            &empty_entries(1, 200_000),
        ),
        json_case::<ExportTraceServiceRequest>(
            "traces json",
            "resourceSpans",
            &serde_json::to_vec(&traces(1_000)).unwrap(),
        ),
        json_case::<ExportLogsServiceRequest>(
            "logs json",
            "resourceLogs",
            &serde_json::to_vec(&logs(1_000)).unwrap(),
        ),
        json_case::<ExportMetricsServiceRequest>(
            "metrics json",
            "resourceMetrics",
            &serde_json::to_vec(&metrics(2_000)).unwrap(),
        ),
        json_case::<ExportMetricsServiceRequest>(
            "keyed bucket counts json",
            "resourceMetrics",
            json_histogram("bucketCounts", "1").as_bytes(),
        ),
        json_case::<ExportMetricsServiceRequest>(
            "keyed explicit bounds json",
            "resourceMetrics",
            json_histogram("explicitBounds", "1").as_bytes(),
        ),
        json_case::<ExportMetricsServiceRequest>(
            "keyed unknown numbers json",
            "resourceMetrics",
            json_histogram("unknownField", "0").as_bytes(),
        ),
        json_case::<ExportMetricsServiceRequest>(
            "keyed unknown arrays json",
            "resourceMetrics",
            json_histogram("unknownField", "[]").as_bytes(),
        ),
        json_case::<ExportMetricsServiceRequest>(
            "keyed unknown strings json",
            "resourceMetrics",
            json_histogram("unknownField", "\"\"").as_bytes(),
        ),
        json_case::<ExportTraceServiceRequest>(
            "empty objects json",
            "resourceSpans",
            format!("{{\"resourceSpans\":[{}{{}}]}}", "{},".repeat(100_000)).as_bytes(),
        ),
        json_case::<ExportLogsServiceRequest>(
            "keyed objects json",
            "resourceLogs",
            format!(
                "{{\"resourceLogs\":[{}{{}}]}}",
                "{\"schemaUrl\":\"\"},".repeat(100_000)
            )
            .as_bytes(),
        ),
    ]
}

/// The estimate covers what decoding really allocates, so a budget on it bounds
/// memory, and stays within 2.5x of it for real telemetry, so batches are not
/// refused for the estimate's slack.
#[test]
fn estimates_bound_the_real_allocation_without_overshooting_it() {
    let measured = cases();
    for Measured {
        case,
        wire,
        actual,
        estimate,
        ..
    } in &measured
    {
        eprintln!(
            "{case:>24}: wire {wire:>9} B, decoded peak {actual:>10} B ({:>5.1}x wire), estimate {estimate:>10} B ({:.2}x peak)",
            *actual as f64 / *wire as f64,
            *estimate as f64 / *actual as f64,
        );
    }
    for Measured {
        case,
        realistic,
        actual,
        estimate,
        ..
    } in measured
    {
        let estimate = usize::try_from(estimate).unwrap();
        assert!(
            estimate >= actual,
            "{case}: estimate {estimate} below the real peak {actual}"
        );
        assert!(
            !realistic || estimate * 2 <= actual * 5,
            "{case}: estimate {estimate} over 2.5x the real peak {actual}"
        );
    }
}

thread_local! {
    /// What every string and bytes field of the fixtures below holds.
    static TEXT_LEN: Cell<usize> = const { Cell::new(0) };
}

fn text() -> String {
    "t".repeat(TEXT_LEN.with(Cell::get))
}

// Every field of every message, spelled out with no `..Default::default()`: a
// field added to opentelemetry-proto stops this compiling until the walker's
// table (`decode_budget::Msg::field`) and these fixtures account for it.

fn key_value() -> KeyValue {
    KeyValue {
        key: text(),
        value: Some(any_value_list()),
        key_strindex: 0,
    }
}

fn any_value_list() -> AnyValue {
    AnyValue {
        value: Some(any_value::Value::ArrayValue(ArrayValue {
            values: vec![AnyValue {
                value: Some(any_value::Value::KvlistValue(KeyValueList {
                    values: Vec::new(),
                })),
            }],
        })),
    }
}

fn full_resource() -> Resource {
    Resource {
        attributes: vec![key_value()],
        dropped_attributes_count: 0,
        entity_refs: vec![EntityRef {
            schema_url: text(),
            r#type: text(),
            id_keys: vec![text()],
            description_keys: vec![text()],
        }],
    }
}

fn full_scope() -> InstrumentationScope {
    InstrumentationScope {
        name: text(),
        version: text(),
        attributes: vec![key_value()],
        dropped_attributes_count: 0,
    }
}

fn full_traces() -> ExportTraceServiceRequest {
    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(full_resource()),
            scope_spans: vec![ScopeSpans {
                scope: Some(full_scope()),
                spans: vec![Span {
                    trace_id: text().into_bytes(),
                    span_id: text().into_bytes(),
                    trace_state: text(),
                    parent_span_id: text().into_bytes(),
                    flags: 0,
                    name: text(),
                    kind: 0,
                    start_time_unix_nano: 0,
                    end_time_unix_nano: 0,
                    attributes: vec![key_value()],
                    dropped_attributes_count: 0,
                    events: vec![span::Event {
                        time_unix_nano: 0,
                        name: text(),
                        attributes: vec![key_value()],
                        dropped_attributes_count: 0,
                    }],
                    dropped_events_count: 0,
                    links: vec![span::Link {
                        trace_id: text().into_bytes(),
                        span_id: text().into_bytes(),
                        trace_state: text(),
                        attributes: vec![key_value()],
                        dropped_attributes_count: 0,
                        flags: 0,
                    }],
                    dropped_links_count: 0,
                    status: Some(Status {
                        message: text(),
                        code: 0,
                    }),
                }],
                schema_url: text(),
            }],
            schema_url: text(),
        }],
    }
}

fn full_logs() -> ExportLogsServiceRequest {
    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(full_resource()),
            scope_logs: vec![ScopeLogs {
                scope: Some(full_scope()),
                log_records: vec![LogRecord {
                    time_unix_nano: 0,
                    observed_time_unix_nano: 0,
                    severity_number: 0,
                    severity_text: text(),
                    body: Some(any_value_list()),
                    attributes: vec![key_value()],
                    dropped_attributes_count: 0,
                    flags: 0,
                    trace_id: text().into_bytes(),
                    span_id: text().into_bytes(),
                    event_name: text(),
                }],
                schema_url: text(),
            }],
            schema_url: text(),
        }],
    }
}

fn exemplar() -> Exemplar {
    Exemplar {
        filtered_attributes: vec![key_value()],
        time_unix_nano: 0,
        span_id: text().into_bytes(),
        trace_id: text().into_bytes(),
        value: None,
    }
}

fn number_point() -> NumberDataPoint {
    NumberDataPoint {
        attributes: vec![key_value()],
        start_time_unix_nano: 0,
        time_unix_nano: 0,
        exemplars: vec![exemplar()],
        flags: 0,
        value: None,
    }
}

fn buckets() -> Option<Buckets> {
    Some(Buckets {
        offset: 0,
        bucket_counts: vec![1],
    })
}

fn metric(data: metric::Data) -> Metric {
    Metric {
        name: text(),
        description: text(),
        unit: text(),
        metadata: vec![key_value()],
        data: Some(data),
    }
}

fn full_metrics() -> ExportMetricsServiceRequest {
    ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            resource: Some(full_resource()),
            scope_metrics: vec![ScopeMetrics {
                scope: Some(full_scope()),
                metrics: vec![
                    metric(metric::Data::Gauge(Gauge {
                        data_points: vec![number_point()],
                    })),
                    metric(metric::Data::Sum(Sum {
                        data_points: vec![number_point()],
                        aggregation_temporality: 0,
                        is_monotonic: false,
                    })),
                    metric(metric::Data::Histogram(Histogram {
                        data_points: vec![HistogramDataPoint {
                            attributes: vec![key_value()],
                            start_time_unix_nano: 0,
                            time_unix_nano: 0,
                            count: 0,
                            sum: None,
                            bucket_counts: vec![1],
                            explicit_bounds: vec![1.0],
                            exemplars: vec![exemplar()],
                            flags: 0,
                            min: None,
                            max: None,
                        }],
                        aggregation_temporality: 0,
                    })),
                    metric(metric::Data::ExponentialHistogram(ExponentialHistogram {
                        data_points: vec![ExponentialHistogramDataPoint {
                            attributes: vec![key_value()],
                            start_time_unix_nano: 0,
                            time_unix_nano: 0,
                            count: 0,
                            sum: None,
                            scale: 0,
                            zero_count: 0,
                            positive: buckets(),
                            negative: buckets(),
                            flags: 0,
                            exemplars: vec![exemplar()],
                            min: None,
                            max: None,
                            zero_threshold: 0.0,
                        }],
                        aggregation_temporality: 0,
                    })),
                    metric(metric::Data::Summary(Summary {
                        data_points: vec![SummaryDataPoint {
                            attributes: vec![key_value()],
                            start_time_unix_nano: 0,
                            time_unix_nano: 0,
                            count: 0,
                            sum: 0.0,
                            quantile_values: vec![ValueAtQuantile {
                                quantile: 0.0,
                                value: 0.0,
                            }],
                            flags: 0,
                        }],
                    })),
                ],
                schema_url: text(),
            }],
            schema_url: text(),
        }],
    }
}

const MANY: usize = 20_000;

fn many<T: Clone>(item: T) -> Vec<T> {
    vec![item; MANY]
}

/// Every repeated field, grown on its own: the walker must charge what it costs.
#[test]
fn every_repeated_field_is_charged() {
    use OtlpSignal::{Logs, Metrics, Traces};

    let traces = |edit: fn(&mut ExportTraceServiceRequest)| {
        let mut request = full_traces();
        edit(&mut request);
        request.encode_to_vec()
    };
    let logs = |edit: fn(&mut ExportLogsServiceRequest)| {
        let mut request = full_logs();
        edit(&mut request);
        request.encode_to_vec()
    };
    let metrics = |edit: fn(&mut ExportMetricsServiceRequest)| {
        let mut request = full_metrics();
        edit(&mut request);
        request.encode_to_vec()
    };
    fn span(request: &mut ExportTraceServiceRequest) -> &mut Span {
        &mut request.resource_spans[0].scope_spans[0].spans[0]
    }
    fn record(request: &mut ExportLogsServiceRequest) -> &mut LogRecord {
        &mut request.resource_logs[0].scope_logs[0].log_records[0]
    }
    fn data(request: &mut ExportMetricsServiceRequest, index: usize) -> &mut metric::Data {
        request.resource_metrics[0].scope_metrics[0].metrics[index]
            .data
            .as_mut()
            .unwrap()
    }
    fn histogram(request: &mut ExportMetricsServiceRequest) -> &mut HistogramDataPoint {
        match data(request, 2) {
            metric::Data::Histogram(histogram) => &mut histogram.data_points[0],
            _ => unreachable!(),
        }
    }
    fn exponential(
        request: &mut ExportMetricsServiceRequest,
    ) -> &mut ExponentialHistogramDataPoint {
        match data(request, 3) {
            metric::Data::ExponentialHistogram(histogram) => &mut histogram.data_points[0],
            _ => unreachable!(),
        }
    }
    fn summary(request: &mut ExportMetricsServiceRequest) -> &mut SummaryDataPoint {
        match data(request, 4) {
            metric::Data::Summary(summary) => &mut summary.data_points[0],
            _ => unreachable!(),
        }
    }
    fn gauge(request: &mut ExportMetricsServiceRequest) -> &mut NumberDataPoint {
        match data(request, 0) {
            metric::Data::Gauge(gauge) => &mut gauge.data_points[0],
            _ => unreachable!(),
        }
    }

    let cases: Vec<(&str, OtlpSignal, Vec<u8>)> = vec![
        (
            "resource_spans",
            Traces,
            traces(|r| r.resource_spans = many(Default::default())),
        ),
        (
            "scope_spans",
            Traces,
            traces(|r| r.resource_spans[0].scope_spans = many(Default::default())),
        ),
        (
            "spans",
            Traces,
            traces(|r| r.resource_spans[0].scope_spans[0].spans = many(Default::default())),
        ),
        (
            "span attributes",
            Traces,
            traces(|r| span(r).attributes = many(Default::default())),
        ),
        (
            "events",
            Traces,
            traces(|r| span(r).events = many(Default::default())),
        ),
        (
            "event attributes",
            Traces,
            traces(|r| span(r).events[0].attributes = many(Default::default())),
        ),
        (
            "links",
            Traces,
            traces(|r| span(r).links = many(Default::default())),
        ),
        (
            "link attributes",
            Traces,
            traces(|r| span(r).links[0].attributes = many(Default::default())),
        ),
        (
            "resource attributes",
            Traces,
            traces(|r| {
                r.resource_spans[0].resource.as_mut().unwrap().attributes =
                    many(Default::default());
            }),
        ),
        (
            "entity refs",
            Traces,
            traces(|r| {
                r.resource_spans[0].resource.as_mut().unwrap().entity_refs =
                    many(Default::default());
            }),
        ),
        (
            "entity id keys",
            Traces,
            traces(|r| {
                r.resource_spans[0].resource.as_mut().unwrap().entity_refs[0].id_keys =
                    many("k".to_owned());
            }),
        ),
        (
            "entity description keys",
            Traces,
            traces(|r| {
                r.resource_spans[0].resource.as_mut().unwrap().entity_refs[0].description_keys =
                    many("d".to_owned());
            }),
        ),
        (
            "scope attributes",
            Traces,
            traces(|r| {
                r.resource_spans[0].scope_spans[0]
                    .scope
                    .as_mut()
                    .unwrap()
                    .attributes = many(Default::default());
            }),
        ),
        (
            "resource_logs",
            Logs,
            logs(|r| r.resource_logs = many(Default::default())),
        ),
        (
            "scope_logs",
            Logs,
            logs(|r| r.resource_logs[0].scope_logs = many(Default::default())),
        ),
        (
            "log_records",
            Logs,
            logs(|r| r.resource_logs[0].scope_logs[0].log_records = many(Default::default())),
        ),
        (
            "log attributes",
            Logs,
            logs(|r| record(r).attributes = many(Default::default())),
        ),
        (
            "array values",
            Logs,
            logs(|r| {
                record(r).body = Some(AnyValue {
                    value: Some(any_value::Value::ArrayValue(ArrayValue {
                        values: many(Default::default()),
                    })),
                });
            }),
        ),
        (
            "kvlist values",
            Logs,
            logs(|r| {
                record(r).body = Some(AnyValue {
                    value: Some(any_value::Value::KvlistValue(KeyValueList {
                        values: many(Default::default()),
                    })),
                });
            }),
        ),
        (
            "resource_metrics",
            Metrics,
            metrics(|r| r.resource_metrics = many(Default::default())),
        ),
        (
            "scope_metrics",
            Metrics,
            metrics(|r| r.resource_metrics[0].scope_metrics = many(Default::default())),
        ),
        (
            "metrics",
            Metrics,
            metrics(|r| r.resource_metrics[0].scope_metrics[0].metrics = many(Default::default())),
        ),
        (
            "metric metadata",
            Metrics,
            metrics(|r| {
                r.resource_metrics[0].scope_metrics[0].metrics[0].metadata =
                    many(Default::default());
            }),
        ),
        (
            "gauge points",
            Metrics,
            metrics(|r| {
                *data(r, 0) = metric::Data::Gauge(Gauge {
                    data_points: many(Default::default()),
                });
            }),
        ),
        (
            "sum points",
            Metrics,
            metrics(|r| {
                *data(r, 1) = metric::Data::Sum(Sum {
                    data_points: many(Default::default()),
                    aggregation_temporality: 0,
                    is_monotonic: false,
                });
            }),
        ),
        (
            "histogram points",
            Metrics,
            metrics(|r| {
                *data(r, 2) = metric::Data::Histogram(Histogram {
                    data_points: many(Default::default()),
                    aggregation_temporality: 0,
                });
            }),
        ),
        (
            "exponential points",
            Metrics,
            metrics(|r| {
                *data(r, 3) = metric::Data::ExponentialHistogram(ExponentialHistogram {
                    data_points: many(Default::default()),
                    aggregation_temporality: 0,
                });
            }),
        ),
        (
            "summary points",
            Metrics,
            metrics(|r| {
                *data(r, 4) = metric::Data::Summary(Summary {
                    data_points: many(Default::default()),
                });
            }),
        ),
        (
            "number point attributes",
            Metrics,
            metrics(|r| gauge(r).attributes = many(Default::default())),
        ),
        (
            "number point exemplars",
            Metrics,
            metrics(|r| gauge(r).exemplars = many(Default::default())),
        ),
        (
            "exemplar attributes",
            Metrics,
            metrics(|r| gauge(r).exemplars[0].filtered_attributes = many(Default::default())),
        ),
        (
            "histogram attributes",
            Metrics,
            metrics(|r| histogram(r).attributes = many(Default::default())),
        ),
        (
            "histogram buckets",
            Metrics,
            metrics(|r| histogram(r).bucket_counts = many(1)),
        ),
        (
            "histogram bounds",
            Metrics,
            metrics(|r| histogram(r).explicit_bounds = many(1.0)),
        ),
        (
            "histogram exemplars",
            Metrics,
            metrics(|r| histogram(r).exemplars = many(Default::default())),
        ),
        (
            "exponential attributes",
            Metrics,
            metrics(|r| exponential(r).attributes = many(Default::default())),
        ),
        (
            "exponential exemplars",
            Metrics,
            metrics(|r| exponential(r).exemplars = many(Default::default())),
        ),
        (
            "exponential buckets",
            Metrics,
            metrics(|r| exponential(r).positive.as_mut().unwrap().bucket_counts = many(1)),
        ),
        (
            "summary attributes",
            Metrics,
            metrics(|r| summary(r).attributes = many(Default::default())),
        ),
        (
            "summary quantiles",
            Metrics,
            metrics(|r| summary(r).quantile_values = many(Default::default())),
        ),
    ];
    for (case, signal, wire) in cases {
        let estimate = usize::try_from(protobuf_cost(signal, &wire, u64::MAX).unwrap()).unwrap();
        let (actual, decoded) = peak_during(|| match signal {
            Traces => ExportTraceServiceRequest::decode(&wire[..]).map(drop),
            Logs => ExportLogsServiceRequest::decode(&wire[..]).map(drop),
            Metrics => ExportMetricsServiceRequest::decode(&wire[..]).map(drop),
        });
        decoded.unwrap_or_else(|error| panic!("{case} decodes: {error}"));
        assert!(
            estimate >= actual,
            "{case}: estimate {estimate} below the real peak {actual}"
        );
    }
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig::with_cases(512))]

    /// Damaged payloads the decoder still accepts are costed like any other: the
    /// walker never gives up on bytes the decoder would go on to allocate for.
    #[test]
    fn whatever_the_decoder_accepts_is_bounded(
        cut in 0_usize..4_000,
        flips in proptest::collection::vec((0_usize..4_000, proptest::num::u8::ANY), 0..6),
    ) {
        let mut wire = full_metrics().encode_to_vec();
        wire.extend(logs(3).encode_to_vec());
        for (at, byte) in flips {
            let at = at % wire.len();
            wire[at] = byte;
        }
        wire.truncate(wire.len().saturating_sub(cut % wire.len()));
        let estimate = usize::try_from(protobuf_cost(OtlpSignal::Metrics, &wire, u64::MAX).unwrap()).unwrap();
        let (actual, decoded) = peak_during(|| ExportMetricsServiceRequest::decode(&wire[..]).map(drop));
        if decoded.is_ok() {
            proptest::prop_assert!(estimate >= actual, "estimate {} below the real peak {}", estimate, actual);
        }
    }
}

/// Every string and bytes field filled at once, with lists at one element: the
/// text dominates, so a field the walker does not charge shows up as a shortfall.
#[test]
fn every_text_field_is_charged() {
    TEXT_LEN.with(|len| len.set(256 * 1024));
    let cases = [
        (OtlpSignal::Traces, full_traces().encode_to_vec()),
        (OtlpSignal::Logs, full_logs().encode_to_vec()),
        (OtlpSignal::Metrics, full_metrics().encode_to_vec()),
    ];
    TEXT_LEN.with(|len| len.set(0));
    for (signal, wire) in cases {
        let estimate = usize::try_from(protobuf_cost(signal, &wire, u64::MAX).unwrap()).unwrap();
        let (actual, decoded) = peak_during(|| match signal {
            OtlpSignal::Traces => ExportTraceServiceRequest::decode(&wire[..]).map(drop),
            OtlpSignal::Logs => ExportLogsServiceRequest::decode(&wire[..]).map(drop),
            OtlpSignal::Metrics => ExportMetricsServiceRequest::decode(&wire[..]).map(drop),
        });
        decoded.unwrap();
        assert!(
            estimate >= actual,
            "{signal:?}: estimate {estimate} below the real peak {actual}"
        );
    }
}
