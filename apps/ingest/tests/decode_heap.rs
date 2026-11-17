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
use maple_ingest::profiles::{flatten, FlattenError, ResourceStamps, MAX_ROW_BYTES};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::profiles::v1development::ExportProfilesServiceRequest;
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
use opentelemetry_proto::tonic::profiles::v1development as profiles;
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

/// A real export of the Maple SDK's Node profiler, as OTLP/JSON.
const SDK_PROFILES: &[u8] = include_bytes!("../src/testdata/profiles-sdk-node.json");

/// Profiles are read by `maple_ingest::profiles::decode_json`, not the derives. It
/// builds no `Value` tree, so `json_cost` bounds it with room to spare: these
/// cases hold the estimate to covering the decode, not to staying close to it.
fn profiles_json_case(case: &'static str, wire: &[u8]) -> Measured {
    let estimate = json_cost(wire, u64::MAX).unwrap();
    let (actual, decoded) = peak_during(|| maple_ingest::profiles::decode_json(wire));
    decoded.unwrap_or_else(|error| panic!("{case} decodes: {error}"));
    Measured {
        case,
        realistic: false,
        wire: wire.len(),
        actual,
        estimate,
    }
}

/// A JSON profiles export of one sample whose `field` holds `element`, many times.
fn json_sample_list(field: &str, element: &str) -> String {
    let elements = vec![element; 200_000].join(",");
    format!(
        "{{\"resourceProfiles\":[{{\"scopeProfiles\":[{{\"profiles\":[{{\"samples\":[{{\
         \"{field}\":[{elements}]}}]}}]}}]}}]}}"
    )
}

fn cases() -> Vec<Measured> {
    use OtlpSignal::{Logs, Metrics, Profiles, Traces};
    let sdk_profiles = maple_ingest::profiles::decode_json(SDK_PROFILES).unwrap();
    vec![
        protobuf_case::<ExportProfilesServiceRequest>(
            "profiles",
            Profiles,
            &sdk_profiles.encode_to_vec(),
        ),
        protobuf_case::<ExportProfilesServiceRequest>(
            "empty resource profiles",
            Profiles,
            &empty_entries(1, 200_000),
        ),
        // The dictionary in a hundred occurrences, which decode into one string table.
        protobuf_case::<ExportProfilesServiceRequest>(
            "empty split dictionary",
            Profiles,
            &nest(2, &empty_entries(5, 1_400)).repeat(100),
        ),
        profiles_json_case("profiles json", SDK_PROFILES),
        profiles_json_case(
            "keyed sample values json",
            json_sample_list("values", "\"1\"").as_bytes(),
        ),
        profiles_json_case(
            "keyed sample timestamps json",
            json_sample_list("timestampsUnixNano", "1").as_bytes(),
        ),
        profiles_json_case(
            "keyed sample attribute indices json",
            json_sample_list("attributeIndices", "1").as_bytes(),
        ),
        profiles_json_case(
            "empty samples json",
            format!(
                "{{\"resourceProfiles\":[{{\"scopeProfiles\":[{{\"profiles\":[{{\"samples\":[{}{{}}]}}]}}]}}]}}",
                "{},".repeat(100_000)
            )
            .as_bytes(),
        ),
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

fn full_profiles() -> ExportProfilesServiceRequest {
    let value_type = || {
        Some(profiles::ValueType {
            type_strindex: 0,
            unit_strindex: 0,
        })
    };
    ExportProfilesServiceRequest {
        resource_profiles: vec![profiles::ResourceProfiles {
            resource: Some(full_resource()),
            scope_profiles: vec![profiles::ScopeProfiles {
                scope: Some(full_scope()),
                profiles: vec![profiles::Profile {
                    sample_type: value_type(),
                    samples: vec![profiles::Sample {
                        stack_index: 0,
                        attribute_indices: vec![0],
                        link_index: 0,
                        values: vec![0],
                        timestamps_unix_nano: vec![0],
                    }],
                    time_unix_nano: 0,
                    duration_nano: 0,
                    period_type: value_type(),
                    period: 0,
                    profile_id: text().into_bytes(),
                    dropped_attributes_count: 0,
                    original_payload_format: text(),
                    original_payload: text().into_bytes(),
                    attribute_indices: vec![0],
                }],
                schema_url: text(),
            }],
            schema_url: text(),
        }],
        dictionary: Some(profiles::ProfilesDictionary {
            mapping_table: vec![profiles::Mapping {
                memory_start: 0,
                memory_limit: 0,
                file_offset: 0,
                filename_strindex: 0,
                attribute_indices: vec![0],
            }],
            location_table: vec![profiles::Location {
                mapping_index: 0,
                address: 0,
                lines: vec![profiles::Line {
                    function_index: 0,
                    line: 0,
                    column: 0,
                }],
                attribute_indices: vec![0],
            }],
            function_table: vec![profiles::Function {
                name_strindex: 0,
                system_name_strindex: 0,
                filename_strindex: 0,
                start_line: 0,
            }],
            link_table: vec![profiles::Link {
                trace_id: text().into_bytes(),
                span_id: text().into_bytes(),
            }],
            string_table: vec![text()],
            attribute_table: vec![profiles::KeyValueAndUnit {
                key_strindex: 0,
                value: Some(any_value_list()),
                unit_strindex: 0,
            }],
            stack_table: vec![profiles::Stack {
                location_indices: vec![0],
            }],
        }),
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
            OtlpSignal::Profiles => ExportProfilesServiceRequest::decode(&wire[..]).map(drop),
        });
        decoded.unwrap_or_else(|error| panic!("{case} decodes: {error}"));
        assert!(
            estimate >= actual,
            "{case}: estimate {estimate} below the real peak {actual}"
        );
    }
}

/// The profiles export's repeated fields, each grown on its own.
#[test]
fn every_repeated_profiles_field_is_charged() {
    type Edit = fn(&mut ExportProfilesServiceRequest);
    fn profile(request: &mut ExportProfilesServiceRequest) -> &mut profiles::Profile {
        &mut request.resource_profiles[0].scope_profiles[0].profiles[0]
    }
    fn sample(request: &mut ExportProfilesServiceRequest) -> &mut profiles::Sample {
        &mut profile(request).samples[0]
    }
    fn dictionary(request: &mut ExportProfilesServiceRequest) -> &mut profiles::ProfilesDictionary {
        request.dictionary.as_mut().unwrap()
    }
    // Indexes of one byte on the wire, of several, and negative ones of ten.
    let cases: Vec<(&str, Edit)> = vec![
        ("resource_profiles", |r| {
            r.resource_profiles = many(Default::default());
        }),
        ("scope_profiles", |r| {
            r.resource_profiles[0].scope_profiles = many(Default::default());
        }),
        ("profiles", |r| {
            r.resource_profiles[0].scope_profiles[0].profiles = many(Default::default());
        }),
        ("resource attributes", |r| {
            r.resource_profiles[0].resource.as_mut().unwrap().attributes = many(Default::default());
        }),
        ("scope attributes", |r| {
            let scope = r.resource_profiles[0].scope_profiles[0].scope.as_mut();
            scope.unwrap().attributes = many(Default::default());
        }),
        ("samples", |r| {
            profile(r).samples = many(Default::default());
        }),
        ("sample attribute indices", |r| {
            sample(r).attribute_indices = many(1);
        }),
        ("sample values", |r| {
            sample(r).values = many(1);
        }),
        ("sample negative values", |r| {
            sample(r).values = many(-1);
        }),
        ("sample timestamps", |r| {
            sample(r).timestamps_unix_nano = many(1);
        }),
        ("profile attribute indices", |r| {
            profile(r).attribute_indices = many(300);
        }),
        ("mappings", |r| {
            dictionary(r).mapping_table = many(Default::default());
        }),
        ("mapping attribute indices", |r| {
            dictionary(r).mapping_table[0].attribute_indices = many(-1);
        }),
        ("locations", |r| {
            dictionary(r).location_table = many(Default::default());
        }),
        ("location lines", |r| {
            dictionary(r).location_table[0].lines = many(Default::default());
        }),
        ("location attribute indices", |r| {
            dictionary(r).location_table[0].attribute_indices = many(1);
        }),
        ("functions", |r| {
            dictionary(r).function_table = many(Default::default());
        }),
        ("links", |r| {
            dictionary(r).link_table = many(Default::default());
        }),
        ("strings", |r| {
            dictionary(r).string_table = many(String::new());
        }),
        ("attributes", |r| {
            dictionary(r).attribute_table = many(Default::default());
        }),
        ("stacks", |r| {
            dictionary(r).stack_table = many(Default::default());
        }),
        ("stack locations", |r| {
            dictionary(r).stack_table[0].location_indices = many(70_000);
        }),
    ];
    for (case, edit) in cases {
        let mut request = full_profiles();
        edit(&mut request);
        let wire = request.encode_to_vec();
        let estimate =
            usize::try_from(protobuf_cost(OtlpSignal::Profiles, &wire, u64::MAX).unwrap()).unwrap();
        let (actual, decoded) =
            peak_during(|| ExportProfilesServiceRequest::decode(&wire[..]).map(drop));
        decoded.unwrap_or_else(|error| panic!("{case} decodes: {error}"));
        assert!(
            estimate >= actual,
            "{case}: estimate {estimate} below the real peak {actual}"
        );
    }
}

/// One stack built to grow: a location inlining thousands of lines, listed
/// thousands of times, whose function name and file are control characters that
/// JSON writes at six bytes each. `samples` rows of it, each on a link of its own.
fn hostile_profiles(samples: i32) -> ExportProfilesServiceRequest {
    let control = "\u{1}".repeat(50_000);
    let line = profiles::Line {
        function_index: 1,
        line: 1,
        column: 0,
    };
    ExportProfilesServiceRequest {
        resource_profiles: vec![profiles::ResourceProfiles {
            scope_profiles: vec![profiles::ScopeProfiles {
                profiles: vec![profiles::Profile {
                    samples: (0..samples)
                        .map(|link_index| profiles::Sample {
                            stack_index: 1,
                            link_index,
                            values: vec![1],
                            ..Default::default()
                        })
                        .collect(),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
        dictionary: Some(profiles::ProfilesDictionary {
            string_table: vec![String::new(), control],
            function_table: vec![
                Default::default(),
                profiles::Function {
                    name_strindex: 1,
                    filename_strindex: 1,
                    ..Default::default()
                },
            ],
            location_table: vec![
                Default::default(),
                profiles::Location {
                    lines: vec![line; 5_000],
                    ..Default::default()
                },
            ],
            stack_table: vec![
                Default::default(),
                profiles::Stack {
                    location_indices: vec![1; 5_000],
                },
            ],
            ..Default::default()
        }),
    }
}

/// What flattening `request` allocates at its peak, and what it was granted of
/// `budget` before that: `(peak, granted, rows or the refusal)`.
fn flatten_within(
    request: &ExportProfilesServiceRequest,
    budget: u64,
) -> (usize, u64, Result<Vec<Vec<u8>>, FlattenError>) {
    let stamps = ResourceStamps::default();
    let mut granted = 0_u64;
    let (peak, flattened) = peak_during(|| {
        flatten(
            request,
            &stamps,
            1,
            &mut || [7; 16],
            MAX_ROW_BYTES,
            &mut |bytes| {
                let fits = granted + bytes <= budget;
                if fits {
                    granted += bytes;
                }
                fits
            },
        )
    });
    (peak, granted, flattened.map(|flattened| flattened.rows))
}

/// The flatten asks for a row's memory before it builds the row, and for all of
/// it: escaping included. So a refusing budget is never passed, only reached.
#[test]
fn a_hostile_profile_never_allocates_past_what_it_was_granted() {
    const MIB: u64 = 1024 * 1024;

    // One row: the deepest stack of the longest text at its most expensive.
    let (peak, granted, rows) = flatten_within(&hostile_profiles(1), 8 * MIB);
    let rows = rows.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(
        rows[0].len() > 3_000_000 && rows[0].len() <= MAX_ROW_BYTES,
        "a row of {} bytes",
        rows[0].len()
    );
    assert!(
        peak as u64 <= granted,
        "peak {peak} past the {granted} granted"
    );

    // Many rows against a budget that holds a few: refused, and still inside it.
    let (peak, granted, rows) = flatten_within(&hostile_profiles(200), 32 * MIB);
    assert_eq!(rows, Err(FlattenError::OverBudget));
    assert!(
        peak as u64 <= granted && granted <= 32 * MIB,
        "peak {peak} past the {granted} granted"
    );
}

/// One small stack whose resource and sample carry binary attributes, which are
/// read as hex at twice their wire size: in a list, a map, and on their own.
fn expanding_profiles(attribute_bytes: usize) -> ExportProfilesServiceRequest {
    let binary = || AnyValue {
        value: Some(any_value::Value::BytesValue(vec![1; attribute_bytes])),
    };
    let mut request = hostile_profiles(1);
    let dictionary = request.dictionary.as_mut().unwrap();
    dictionary.string_table = vec![String::new(), "main".to_owned(), "blob".to_owned()];
    dictionary.location_table[1].lines.truncate(1);
    dictionary.stack_table[1].location_indices.truncate(1);
    dictionary.attribute_table = vec![
        Default::default(),
        profiles::KeyValueAndUnit {
            key_strindex: 2,
            value: Some(AnyValue {
                value: Some(any_value::Value::KvlistValue(KeyValueList {
                    values: vec![KeyValue {
                        key_strindex: 2,
                        value: Some(binary()),
                        ..Default::default()
                    }],
                })),
            }),
            ..Default::default()
        },
    ];
    let resource_profiles = &mut request.resource_profiles[0];
    resource_profiles.resource = Some(opentelemetry_proto::tonic::resource::v1::Resource {
        attributes: vec![
            KeyValue {
                key: "blob".to_owned(),
                value: Some(binary()),
                ..Default::default()
            },
            KeyValue {
                key: "blobs".to_owned(),
                value: Some(AnyValue {
                    value: Some(any_value::Value::ArrayValue(ArrayValue {
                        values: vec![binary()],
                    })),
                }),
                ..Default::default()
            },
        ],
        ..Default::default()
    });
    resource_profiles.scope_profiles[0].profiles[0].samples[0].attribute_indices = vec![1];
    request
}

/// Attributes that grow as they are read are charged before they are read, even
/// when the row they would go in is past the ceiling and never written.
#[test]
fn attributes_that_expand_as_they_are_read_never_allocate_past_what_was_granted() {
    const MIB: u64 = 1024 * 1024;

    // Small enough for its row to be written.
    let (peak, granted, rows) = flatten_within(&expanding_profiles(64 * 1024), 8 * MIB);
    assert_eq!(rows.map(|rows| rows.len()), Ok(1));
    assert!(
        peak as u64 <= granted,
        "peak {peak} past the {granted} granted"
    );

    // A resource past the row ceiling once read: the row is dropped, and what was
    // read on the way stayed inside the grant.
    let (peak, granted, rows) = flatten_within(&expanding_profiles(3 * 1024 * 1024), 64 * MIB);
    assert_eq!(rows.map(|rows| rows.len()), Ok(0));
    assert!(
        peak as u64 <= granted,
        "peak {peak} past the {granted} granted"
    );

    // A budget that cannot hold the expansion refuses it before it is built.
    let (peak, granted, rows) = flatten_within(&expanding_profiles(3 * 1024 * 1024), 4 * MIB);
    assert_eq!(rows, Err(FlattenError::OverBudget));
    assert!(
        peak as u64 <= granted,
        "peak {peak} past the {granted} granted"
    );
}

/// Resource keys named by string-table indices past the table: each reads as no key,
/// but the flatten still notes where each was named.
#[test]
fn resource_keys_named_past_the_string_table_stay_inside_what_was_granted() {
    const MIB: u64 = 1024 * 1024;
    let mut request = expanding_profiles(16);
    request.resource_profiles[0].resource = Some(opentelemetry_proto::tonic::resource::v1::Resource {
        attributes: (0..200_000)
            .map(|at| KeyValue {
                key_strindex: 1_000_000 + at,
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    });
    let (peak, granted, rows) = flatten_within(&request, 2 * MIB);
    assert_eq!(rows, Err(FlattenError::OverBudget));
    assert!(peak as u64 <= granted, "peak {peak} past the {granted} granted");
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
        (OtlpSignal::Profiles, full_profiles().encode_to_vec()),
    ];
    TEXT_LEN.with(|len| len.set(0));
    for (signal, wire) in cases {
        let estimate = usize::try_from(protobuf_cost(signal, &wire, u64::MAX).unwrap()).unwrap();
        let (actual, decoded) = peak_during(|| match signal {
            OtlpSignal::Traces => ExportTraceServiceRequest::decode(&wire[..]).map(drop),
            OtlpSignal::Logs => ExportLogsServiceRequest::decode(&wire[..]).map(drop),
            OtlpSignal::Metrics => ExportMetricsServiceRequest::decode(&wire[..]).map(drop),
            OtlpSignal::Profiles => ExportProfilesServiceRequest::decode(&wire[..]).map(drop),
        });
        decoded.unwrap();
        assert!(
            estimate >= actual,
            "{signal:?}: estimate {estimate} below the real peak {actual}"
        );
    }
}

mod prometheus {
    use super::{peak_during, LIVE};
    use maple_ingest::prometheus_remote_write::{
        decode, decode_cost, Label, MetricMetadata, MetricType, Sample, Skipped, TimeSeries,
        WriteRequest,
    };
    use prost::Message;
    use std::cell::Cell;

    fn label(name: &str, value: &str) -> Label {
        Label {
            name: name.to_owned(),
            value: value.to_owned(),
        }
    }

    /// `series` series of `samples` samples, each with `labels` labels besides
    /// its name, `job` and `instance`, spread over `targets` targets.
    fn request(series: usize, samples: usize, labels: usize, targets: usize) -> WriteRequest {
        let timeseries = (0..series)
            .map(|i| {
                let mut all = vec![
                    label("__name__", &format!("http_requests_{}_total", i % 200)),
                    label("instance", &format!("10.0.{}.1:9090", i % targets)),
                    label("job", "api"),
                ];
                all.extend(
                    (0..labels).map(|l| label(&format!("label_{l}"), &format!("value-{i}-{l}"))),
                );
                TimeSeries {
                    labels: all,
                    samples: (0..samples)
                        .zip(1_700_000_000_000_i64..)
                        .map(|(s, timestamp)| Sample {
                            value: s as f64,
                            timestamp,
                        })
                        .collect(),
                    exemplars: vec![Skipped {}; 2],
                    histograms: Vec::new(),
                }
            })
            .collect();
        WriteRequest {
            timeseries,
            metadata: Vec::new(),
        }
    }

    struct Measured {
        /// Estimated and real peak while decoding and mapping.
        peak: (usize, usize),
        /// Estimated and real bytes the mapped request holds afterwards.
        retained: (usize, usize),
    }

    fn measure(wire: &[u8]) -> Measured {
        let cost = decode_cost(wire, u64::MAX).unwrap();
        let base = LIVE.with(Cell::get);
        let (peak, decoded) = peak_during(|| decode(wire));
        let retained = LIVE.with(Cell::get) - base;
        decoded.unwrap();
        Measured {
            peak: (usize::try_from(cost.peak).unwrap(), peak),
            retained: (usize::try_from(cost.retained).unwrap(), retained),
        }
    }

    #[test]
    fn the_estimate_bounds_decoding_and_mapping_a_remote_write() {
        let help = "h".repeat(4 * 1024);
        let mut described = request(2_000, 1, 8, 2_000);
        described.metadata = (0..200)
            .map(|i| MetricMetadata {
                kind: MetricType::Counter.into(),
                metric_family_name: format!("http_requests_{i}_total"),
                help: help.clone(),
                unit: "requests".to_owned(),
            })
            .collect();
        // (case, request, a shape a real sender produces)
        let cases = [
            ("one sample per series", request(2_000, 1, 8, 50), true),
            ("a backfill of one series", request(1, 20_000, 8, 1), true),
            ("a few samples per series", request(500, 10, 12, 20), true),
            ("a target per series", request(2_000, 1, 2, 2_000), false),
            ("many labels", request(50, 4, 400, 5), false),
            ("help text on every metric", described, false),
            ("no labels at all", request(5_000, 1, 0, 1), false),
        ];
        for (case, request, realistic) in cases {
            let wire = request.encode_to_vec();
            let Measured {
                peak: (estimate, actual),
                retained: (kept_estimate, kept),
            } = measure(&wire);
            eprintln!(
                "{case:>26}: wire {:>8} B, peak {actual:>9} B ({:>5.1}x wire), estimate {estimate:>9} B ({:.2}x), retained {kept:>9} B, estimate {kept_estimate:>9} B ({:.2}x)",
                wire.len(),
                actual as f64 / wire.len() as f64,
                estimate as f64 / actual as f64,
                kept_estimate as f64 / kept as f64,
            );
            assert!(
                estimate >= actual,
                "{case}: estimate {estimate} below the real peak {actual}"
            );
            assert!(
                kept_estimate >= kept,
                "{case}: retained estimate {kept_estimate} below the real {kept}"
            );
            // Loose on purpose: every series is costed as a metric and a resource of its own.
            assert!(
                !realistic || (estimate <= actual * 4 && kept_estimate <= kept * 3),
                "{case}: estimates {estimate} and {kept_estimate} overshoot {actual} and {kept}"
            );
        }
    }

    /// A body of nothing but empty series and empty labels is the cheapest way
    /// to make the decoder allocate; the estimate still covers it.
    #[test]
    fn the_estimate_bounds_a_body_of_empty_messages() {
        let empty_series = [0x0a, 0x00].repeat(100_000);
        let empty_labels = [0x0a, 0x00].repeat(60_000);
        let mut one_series = vec![0x0a, 0x80 | (empty_labels.len() & 0x7f) as u8];
        one_series.push(((empty_labels.len() >> 7) & 0x7f) as u8 | 0x80);
        one_series.push((empty_labels.len() >> 14) as u8);
        one_series.extend(&empty_labels);
        for (case, wire) in [("empty series", empty_series), ("empty labels", one_series)] {
            let Measured {
                peak: (estimate, actual),
                retained: (kept_estimate, kept),
            } = measure(&wire);
            eprintln!(
                "{case}: wire {} B, peak {actual} B, estimate {estimate} B",
                wire.len()
            );
            assert!(
                estimate >= actual,
                "{case}: estimate {estimate} below the real peak {actual}"
            );
            assert!(
                kept_estimate >= kept,
                "{case}: retained estimate {kept_estimate} below the real {kept}"
            );
        }
    }
    /// Field `tag` holding `body`, length-delimited.
    fn framed(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![(tag << 3) | 2];
        prost::encoding::encode_varint(body.len() as u64, &mut out);
        out.extend_from_slice(body);
        out
    }

    /// The decoder builds everything before a malformed byte and only then fails, so
    /// the estimate has to cover that prefix: a request the decoder will refuse must
    /// not be decoded under a reservation that ignores what it holds on the way.
    #[test]
    fn the_estimate_bounds_what_a_malformed_body_allocates_before_it_fails() {
        let empty_labels = [0x0a, 0x00].repeat(60_000);
        // A series of empty labels that ends in a tag of zero.
        let bad_tail = framed(1, &[empty_labels.as_slice(), &[0x00]].concat());
        // The same labels, then a label whose own body is cut short.
        let bad_label = framed(1, &[empty_labels.as_slice(), &[0x0a, 0x02, 0x0a, 0x7f]].concat());
        // Good series, then a byte that is not a field.
        let good = request(2_000, 1, 8, 50).encode_to_vec();
        let bad_after_good = [good.as_slice(), &[0x00]].concat();
        // Metadata with a long help text and then a tag of zero.
        let help = [&[0x22, 0x80, 0x40][..], &[b'h'; 8 * 1024]].concat();
        let bad_metadata = framed(3, &[help.as_slice(), &[0x00]].concat());
        // A label two bytes long whose name claims the 8 kB that follow the series: the
        // decoder copies them into the name before it notices the label was overrun.
        let overrun = [
            framed(1, &[0x0a, 0x02, 0x0a, 0x80, 0x40]).as_slice(),
            &[b'x'; 8 * 1024],
        ]
        .concat();
        for (case, wire) in [
            ("a label overrunning its series", overrun),
            ("a series ending in a bad tag", bad_tail),
            ("a series ending in a cut label", bad_label),
            ("a bad byte after good series", bad_after_good),
            ("metadata ending in a bad tag", bad_metadata),
        ] {
            let cost = decode_cost(&wire, u64::MAX).unwrap();
            let (actual, decoded) = peak_during(|| decode(&wire));
            assert!(decoded.is_err(), "{case}: the decoder accepted it");
            let estimate = usize::try_from(cost.peak).unwrap();
            eprintln!("{case}: wire {} B, peak {actual} B, estimate {estimate} B", wire.len());
            assert!(
                estimate >= actual,
                "{case}: estimate {estimate} below the real peak {actual}"
            );
        }
    }
    /// A small deterministic generator, so a failing case can be replayed from its seed.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, bound: usize) -> usize {
            (self.next() % bound.max(1) as u64) as usize
        }

        fn text(&mut self, longest: usize) -> String {
            let len = self.below(longest + 1);
            (0..len).map(|_| char::from(b'a' + self.below(26) as u8)).collect()
        }
    }

    /// A request of random shape: any number of series, labels, samples and metadata.
    fn random_request(rng: &mut Rng) -> WriteRequest {
        let timeseries = (0..rng.below(40))
            .map(|_| TimeSeries {
                labels: (0..rng.below(30))
                    .map(|_| label(&rng.text(24), &rng.text(40)))
                    .collect(),
                samples: (0..rng.below(60))
                    .map(|_| Sample {
                        value: rng.below(1_000) as f64,
                        timestamp: 1_700_000_000_000 + i64::try_from(rng.below(1_000_000)).unwrap_or(0),
                    })
                    .collect(),
                exemplars: vec![Skipped {}; rng.below(3)],
                histograms: vec![Skipped {}; rng.below(2)],
            })
            .collect();
        let metadata = (0..rng.below(6))
            .map(|_| MetricMetadata {
                kind: MetricType::Counter.into(),
                metric_family_name: rng.text(24),
                help: rng.text(300),
                unit: rng.text(8),
            })
            .collect();
        WriteRequest {
            timeseries,
            metadata,
        }
    }

    /// Damages `wire` the ways a hostile sender would: cut it, overwrite bytes, and
    /// splice in runs of the cheapest messages the decoder allocates for.
    fn mutate(rng: &mut Rng, mut wire: Vec<u8>) -> Vec<u8> {
        for _ in 0..rng.below(4) {
            if wire.is_empty() {
                break;
            }
            let at = rng.below(wire.len());
            match rng.below(5) {
                0 => wire.truncate(at),
                1 => wire[at] = rng.next() as u8,
                2 => wire.insert(at, 0x00),
                3 => {
                    let run = [0x0a, 0x00].repeat(rng.below(4_000));
                    wire.splice(at..at, run);
                }
                _ => {
                    let run = framed(1, &[0x0a, 0x00].repeat(rng.below(4_000)));
                    wire.splice(at..at, run);
                }
            }
        }
        wire
    }

    /// What the decoder's own error value can hold, however large the input.
    const ERROR_VALUE_BYTES: usize = 1024;

    /// Whatever the bytes are, and whether the decoder accepts them or not, it never
    /// allocates more than the estimate reserved for it.
    #[test]
    fn the_estimate_bounds_random_and_damaged_bodies() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        let (mut refused, mut accepted) = (0_u32, 0_u32);
        for case in 0..12_000 {
            let seed = rng.0;
            let wire = random_request(&mut rng).encode_to_vec();
            let wire = if case % 3 == 0 { wire } else { mutate(&mut rng, wire) };
            let cost = decode_cost(&wire, u64::MAX).unwrap();
            let (actual, decoded) = peak_during(|| decode(&wire));
            if decoded.is_ok() {
                accepted += 1;
            } else {
                refused += 1;
            }
            drop(decoded);
            // A refusal also allocates the decoder's error value: its message and the
            // path to the field, a few hundred bytes whatever the input.
            let estimate = usize::try_from(cost.peak).unwrap() + ERROR_VALUE_BYTES;
            assert!(
                estimate >= actual,
                "case {case} (seed {seed:#x}, {} wire bytes): estimate {estimate} below the real peak {actual}",
                wire.len()
            );
        }
        eprintln!("{accepted} bodies decoded, {refused} refused");
        assert!(accepted > 500 && refused > 500, "{accepted} decoded, {refused} refused");
    }
}
