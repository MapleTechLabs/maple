//! `row_budget`'s estimates against what storing a decoded request really allocates,
//! counted by the allocator: the rows through the real pipeline up to the WAL append,
//! and the body forwarded to a collector. Its own binary, so it sees only this.

#![expect(
    unsafe_code,
    reason = "a counting GlobalAlloc has to implement the unsafe trait"
)]
#![expect(
    clippy::unwrap_used,
    clippy::panic,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::too_many_lines,
    reason = "test fixtures: small known sizes, and one table of cases per signal"
)]

use bytes::Bytes;
use maple_ingest::row_budget::{
    log_rows, metric_rows, trace_rows, ForwardBody, RowEstimate, RowPlan, ROW_PIECE_BYTES,
};
use maple_ingest::telemetry::{
    encode_log_rows, encode_metric_rows, encode_pieces, encode_trace_rows, AttributeMappingRule,
    ClickHouseBreakerConfig, DatasourceNames, ExportDestination, MappingOperation,
    MappingSourceContext, RowSource, SamplingPolicy, TelemetryPipeline, TinybirdConfig,
};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{
    any_value, AnyValue, ArrayValue, InstrumentationScope, KeyValue, KeyValueList,
};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::metrics::v1::{
    exponential_histogram_data_point::Buckets, metric, number_data_point, Exemplar,
    ExponentialHistogram, ExponentialHistogramDataPoint, Gauge, Histogram, HistogramDataPoint,
    Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, Sum,
};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{span, ResourceSpans, ScopeSpans, Span, Status};
use prost::Message;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::path::PathBuf;
use std::time::Duration;

#[path = "support/random.rs"]
mod random;
#[path = "support/shapes.rs"]
mod shapes;

use random::Rng;

use shapes::string_attr;

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

static UNSAMPLED: SamplingPolicy = SamplingPolicy {
    trace_sample_ratio: 1.0,
    always_keep_error_spans: false,
    always_keep_slow_spans_ms: None,
};

/// A request of any signal, so one table covers all three.
#[derive(Clone)]
enum Request {
    Traces(ExportTraceServiceRequest),
    Logs(ExportLogsServiceRequest),
    Metrics(ExportMetricsServiceRequest),
}

impl Request {
    fn wire_len(&self) -> usize {
        match self {
            Self::Traces(request) => request.encoded_len(),
            Self::Logs(request) => request.encoded_len(),
            Self::Metrics(request) => request.encoded_len(),
        }
    }

    fn rows(&self) -> RowEstimate {
        match self {
            Self::Traces(request) => trace_rows("org", request, &SamplingPolicy::default(), &[]),
            Self::Logs(request) => log_rows(request),
            Self::Metrics(request) => metric_rows(request),
        }
    }

    fn source(&self) -> RowSource<'_> {
        match self {
            Self::Traces(request) => RowSource::Traces {
                request,
                policy: &UNSAMPLED,
                mappings: &[],
            },
            Self::Logs(request) => RowSource::Logs(request),
            Self::Metrics(request) => RowSource::Metrics(request),
        }
    }

    fn plan(&self) -> RowPlan {
        self.source().plan("org", ROW_PIECE_BYTES)
    }

    /// The bytes of rows the encoder writes for this request.
    fn row_bytes(&self) -> usize {
        match self {
            Self::Traces(request) => {
                encode_trace_rows("org", request, &SamplingPolicy::default(), &[])
            }
            Self::Logs(request) => encode_log_rows(request),
            Self::Metrics(request) => encode_metric_rows(request),
        }
        .unwrap()
        .iter()
        .map(Bytes::len)
        .sum()
    }

    fn forward_body(&self, json: bool, gzip: bool) -> ForwardBody {
        match self {
            Self::Traces(request) => ForwardBody::of(request, json, gzip),
            Self::Logs(request) => ForwardBody::of(request, json, gzip),
            Self::Metrics(request) => ForwardBody::of(request, json, gzip),
        }
        .unwrap()
    }

    fn forward(&self, body: &ForwardBody) -> Vec<u8> {
        match self {
            Self::Traces(request) => body.build(request),
            Self::Logs(request) => body.build(request),
            Self::Metrics(request) => body.build(request),
        }
        .unwrap()
    }
}

fn unique_dir(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    std::env::temp_dir().join(format!(
        "maple-row-heap-{name}-{}-{nanos}",
        std::process::id()
    ))
}

fn pipeline_config(queue_dir: PathBuf) -> TinybirdConfig {
    TinybirdConfig {
        endpoint: "http://127.0.0.1:9".to_owned(),
        token: "row-heap".to_owned(),
        queue_dir,
        queue_max_bytes: u64::MAX,
        org_queue_max_bytes: u64::MAX,
        queue_channel_capacity: 64,
        wal_shards: 1,
        wal_segment_max_bytes: maple_ingest::telemetry::WAL_SEGMENT_MAX_BYTES,
        wal_store_heartbeat_interval: maple_ingest::wal_store::DEFAULT_HEARTBEAT_INTERVAL,
        batch_max_rows: 5_000,
        batch_max_bytes: 4 * 1024 * 1024,
        queue_max_age: Duration::ZERO,
        // Never reached: the export would allocate on this thread while it is measured.
        batch_max_wait: Duration::from_secs(3_600),
        export_max_attempts: 1,
        clickhouse_export_timeout: Duration::from_secs(5),
        clickhouse_breaker: ClickHouseBreakerConfig::default(),
        clickhouse_allow_private_endpoints: false,
        datasources: DatasourceNames::defaults(),
        datasource_session_replays: "session_replays".to_owned(),
        datasource_session_replay_events: "session_replay_events".to_owned(),
        datasource_session_events: "session_events".to_owned(),
        datasource_product_events: "product_events".to_owned(),
        datasource_profiles: "profiles".to_owned(),
    }
}

/// Peak bytes the request path allocates accepting `request` into a real pipeline:
/// its rows, their frames and the WAL commit, on this thread. A committed piece's
/// rows stay in its lane's queue, which has its own per-org bound, so they count too.
fn native_peak(case: &str, request: &Request, plan: &RowPlan) -> usize {
    let queue_dir = unique_dir(&case.replace(' ', "-"));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let pipeline = runtime
        .block_on(TelemetryPipeline::new(
            pipeline_config(queue_dir.clone()),
            reqwest::Client::new(),
        ))
        .unwrap();
    let destination = ExportDestination::Tinybird;
    let (peak, accepted) = peak_during(|| {
        runtime.block_on(pipeline.accept_planned("org", request.source(), destination, plan))
    });
    let accepted = accepted.unwrap_or_else(|error| panic!("{case} is accepted: {error}"));
    assert_eq!(accepted.rows as u64, plan.total.rows, "{case}: rows counted");
    drop(pipeline);
    drop(runtime);
    drop(std::fs::remove_dir_all(&queue_dir));
    peak
}

fn kv(key: &str, value: any_value::Value) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue { value: Some(value) }),
        ..Default::default()
    }
}

fn resource(attributes: Vec<KeyValue>) -> Resource {
    Resource {
        attributes,
        ..Default::default()
    }
}

fn one_span(span: Span) -> ExportTraceServiceRequest {
    spans_under(Vec::new(), None, vec![span])
}

fn spans_under(
    resource_attributes: Vec<KeyValue>,
    scope: Option<InstrumentationScope>,
    spans: Vec<Span>,
) -> ExportTraceServiceRequest {
    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(resource(resource_attributes)),
            scope_spans: vec![ScopeSpans {
                scope,
                spans,
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

fn logs_under(
    resource_attributes: Vec<KeyValue>,
    scope: Option<InstrumentationScope>,
    log_records: Vec<LogRecord>,
) -> ExportLogsServiceRequest {
    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(resource(resource_attributes)),
            scope_logs: vec![ScopeLogs {
                scope,
                log_records,
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

fn metrics_of(metrics: Vec<Metric>) -> ExportMetricsServiceRequest {
    ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            resource: Some(resource(Vec::new())),
            scope_metrics: vec![ScopeMetrics {
                metrics,
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

fn gauge(name: &str, description: String, data_points: Vec<NumberDataPoint>) -> Metric {
    Metric {
        name: name.to_owned(),
        description,
        data: Some(metric::Data::Gauge(Gauge { data_points })),
        ..Default::default()
    }
}

/// `count` attributes with distinct two-character keys and empty values: the most
/// map entries for the fewest bytes.
fn tiny_attributes(count: usize) -> Vec<KeyValue> {
    (0..count)
        .map(|index| KeyValue {
            key: char::from_u32(0x100 + index as u32).unwrap().to_string(),
            ..Default::default()
        })
        .collect()
}

/// A map of `count` empty entries inside an array of `count` empty strings.
fn nested(count: usize) -> any_value::Value {
    let entries = (0..count)
        .map(|index| KeyValue {
            key: format!("k{index}"),
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue("\"q\"\n".to_owned())),
            }),
            ..Default::default()
        })
        .collect();
    let mut values = vec![AnyValue::default(); count];
    values.push(AnyValue {
        value: Some(any_value::Value::KvlistValue(KeyValueList {
            values: entries,
        })),
    });
    any_value::Value::ArrayValue(ArrayValue { values })
}

struct Case {
    name: &'static str,
    /// Shaped like real telemetry, so the reservation must not overshoot it much.
    realistic: bool,
    request: Request,
}

fn realistic(name: &'static str, request: Request) -> Case {
    Case {
        name,
        realistic: true,
        request,
    }
}

fn hostile(name: &'static str, request: Request) -> Case {
    Case {
        name,
        realistic: false,
        request,
    }
}

const LONG: usize = 64 * 1024;

fn cases() -> Vec<Case> {
    let long = || "d".repeat(LONG);
    let escapes = || "\"\\\n\u{1}".repeat(LONG / 4);
    vec![
        realistic("traces", Request::Traces(shapes::traces(4_000))),
        realistic("logs", Request::Logs(shapes::logs(4_000))),
        realistic("metrics", Request::Metrics(shapes::metrics(8_000))),
        realistic(
            "metrics from a jvm",
            Request::Metrics(shapes::metrics_from(shapes::jvm_resource(), 2_000)),
        ),
        hostile(
            "long description on empty points",
            Request::Metrics(metrics_of(vec![gauge(
                "m",
                long(),
                vec![NumberDataPoint::default(); 1_000],
            )])),
        ),
        hostile(
            "long resource attribute on empty spans",
            Request::Traces(spans_under(
                vec![string_attr("service.name", &long())],
                None,
                vec![Span::default(); 500],
            )),
        ),
        hostile(
            "long scope strings on empty logs",
            Request::Logs(logs_under(
                Vec::new(),
                Some(InstrumentationScope {
                    name: long(),
                    version: long(),
                    attributes: vec![string_attr("scope.attribute", &long())],
                    ..Default::default()
                }),
                vec![LogRecord::default(); 300],
            )),
        ),
        hostile(
            "escaped description on empty points",
            Request::Metrics(metrics_of(vec![gauge(
                "m",
                escapes(),
                vec![NumberDataPoint::default(); 300],
            )])),
        ),
        hostile(
            "many resources",
            Request::Logs(ExportLogsServiceRequest {
                resource_logs: (0..20_000)
                    .map(|index| ResourceLogs {
                        resource: Some(resource(vec![string_attr(
                            "service.name",
                            &index.to_string(),
                        )])),
                        scope_logs: vec![ScopeLogs {
                            log_records: vec![LogRecord::default()],
                            ..Default::default()
                        }],
                        ..Default::default()
                    })
                    .collect(),
            }),
        ),
        hostile(
            "many empty resources",
            Request::Traces(ExportTraceServiceRequest {
                resource_spans: vec![
                    ResourceSpans {
                        scope_spans: vec![ScopeSpans {
                            spans: vec![Span::default()],
                            ..Default::default()
                        }],
                        ..Default::default()
                    };
                    50_000
                ],
            }),
        ),
        hostile(
            "wide span attributes",
            Request::Traces(one_span(Span {
                attributes: tiny_attributes(50_000),
                ..Default::default()
            })),
        ),
        realistic(
            "event-named log records",
            Request::Logs(logs_under(
                vec![kv("service.name", any_value::Value::StringValue("evaluator".to_owned()))],
                None,
                (0..2_000)
                    .map(|_| LogRecord {
                        event_name: "gen_ai.evaluation.result".to_owned(),
                        attributes: vec![kv(
                            "gen_ai.evaluation.name",
                            any_value::Value::StringValue("Relevance".to_owned()),
                        )],
                        ..Default::default()
                    })
                    .collect(),
            )),
        ),
        hostile(
            "wide log attributes",
            Request::Logs(logs_under(
                tiny_attributes(20_000),
                None,
                vec![LogRecord {
                    attributes: tiny_attributes(50_000),
                    ..Default::default()
                }],
            )),
        ),
        hostile(
            "wide point attributes",
            Request::Metrics(metrics_of(vec![gauge(
                "m",
                String::new(),
                vec![NumberDataPoint {
                    attributes: tiny_attributes(50_000),
                    ..Default::default()
                }],
            )])),
        ),
        hostile(
            "one repeated attribute key",
            Request::Traces(one_span(Span {
                attributes: vec![string_attr("k", "value"); 50_000],
                ..Default::default()
            })),
        ),
        hostile(
            "one large log body",
            Request::Logs(logs_under(
                Vec::new(),
                None,
                vec![LogRecord {
                    body: Some(AnyValue {
                        value: Some(any_value::Value::StringValue("b".repeat(8 * 1024 * 1024))),
                    }),
                    ..Default::default()
                }],
            )),
        ),
        hostile(
            "nested log body",
            Request::Logs(logs_under(
                Vec::new(),
                None,
                vec![LogRecord {
                    body: Some(AnyValue {
                        value: Some(nested(20_000)),
                    }),
                    attributes: vec![kv("nested", nested(20_000))],
                    ..Default::default()
                }],
            )),
        ),
        hostile(
            "numbers and bytes as attributes",
            Request::Traces(one_span(Span {
                attributes: (0..20_000)
                    .map(|index| match index % 4 {
                        0 => kv(&index.to_string(), any_value::Value::DoubleValue(1e300)),
                        1 => kv(&index.to_string(), any_value::Value::DoubleValue(5e-324)),
                        2 => kv(&index.to_string(), any_value::Value::IntValue(i64::MIN)),
                        _ => kv(
                            &index.to_string(),
                            any_value::Value::BytesValue(vec![1; 40]),
                        ),
                    })
                    .collect(),
                ..Default::default()
            })),
        ),
        hostile(
            "many events and links",
            Request::Traces(one_span(Span {
                events: vec![
                    span::Event {
                        name: "e".to_owned(),
                        attributes: tiny_attributes(3),
                        ..Default::default()
                    };
                    20_000
                ],
                links: vec![
                    span::Link {
                        trace_id: vec![7; 64],
                        span_id: vec![7; 64],
                        attributes: tiny_attributes(3),
                        ..Default::default()
                    };
                    20_000
                ],
                trace_id: vec![9; 4_096],
                status: Some(Status {
                    message: long(),
                    ..Default::default()
                }),
                ..Default::default()
            })),
        ),
        hostile(
            "many exemplars",
            Request::Metrics(metrics_of(vec![gauge(
                "m",
                String::new(),
                vec![NumberDataPoint {
                    exemplars: vec![
                        Exemplar {
                            trace_id: vec![5; 16],
                            span_id: vec![5; 8],
                            filtered_attributes: tiny_attributes(2),
                            value: Some(
                                opentelemetry_proto::tonic::metrics::v1::exemplar::Value::AsDouble(
                                    -1.797_693_134_862_315_7e308,
                                ),
                            ),
                            ..Default::default()
                        };
                        20_000
                    ],
                    ..Default::default()
                }],
            )])),
        ),
        hostile(
            "many buckets",
            Request::Metrics(metrics_of(vec![
                Metric {
                    name: "h".to_owned(),
                    data: Some(metric::Data::Histogram(Histogram {
                        data_points: vec![HistogramDataPoint {
                            bucket_counts: vec![u64::MAX; 200_000],
                            explicit_bounds: vec![-2.225_073_858_507_201_4e-308; 200_000],
                            ..Default::default()
                        }],
                        aggregation_temporality: i32::MIN,
                    })),
                    ..Default::default()
                },
                Metric {
                    name: "e".to_owned(),
                    data: Some(metric::Data::ExponentialHistogram(ExponentialHistogram {
                        data_points: vec![ExponentialHistogramDataPoint {
                            positive: Some(Buckets {
                                offset: i32::MIN,
                                bucket_counts: vec![0; 200_000],
                            }),
                            negative: Some(Buckets {
                                offset: i32::MIN,
                                bucket_counts: vec![u64::MAX; 200_000],
                            }),
                            scale: i32::MIN,
                            ..Default::default()
                        }],
                        aggregation_temporality: i32::MIN,
                    })),
                    ..Default::default()
                },
                Metric {
                    name: "s".to_owned(),
                    data: Some(metric::Data::Sum(Sum {
                        data_points: vec![NumberDataPoint {
                            value: Some(number_data_point::Value::AsInt(i64::MIN)),
                            flags: u32::MAX,
                            ..Default::default()
                        }],
                        aggregation_temporality: i32::MIN,
                        is_monotonic: true,
                    })),
                    ..Default::default()
                },
            ])),
        ),
    ]
}

/// For each signal, the rows a request is stored as never exceed their estimate and
/// accepting it never allocates past what the estimate reserves, for real telemetry
/// and for requests built to repeat a shared string or to cost the most per byte.
#[test]
fn native_accept_stays_within_what_the_rows_were_estimated_at() {
    for Case {
        name,
        realistic,
        request,
    } in cases()
    {
        let plan = request.plan();
        let rows = plan.total;
        assert_eq!(request.rows(), rows, "{name}: one estimate, however it is split");
        let written = request.row_bytes();
        let peak = native_peak(name, &request, &plan);
        let reserved = plan.largest_piece_heap() as usize;
        // Pieces already committed wait in the queue while the next is built.
        let queued = if plan.pieces.len() > 1 { written } else { 0 };
        eprintln!(
            "{name:>40}: wire {:>9} B, rows {written:>10} B ({:>7.1}x wire), estimate {:>10} B, \
             peak {peak:>10} B, reserved {reserved:>10} B ({:.2}x peak)",
            request.wire_len(),
            written as f64 / request.wire_len() as f64,
            rows.row_bytes(),
            reserved as f64 / peak as f64,
        );
        assert!(
            written as u64 <= rows.row_bytes(),
            "{name}: {written} bytes of rows against an estimate of {}",
            rows.row_bytes()
        );
        assert!(
            peak <= reserved + queued,
            "{name}: reserved {reserved} below the real peak {peak}"
        );
        assert!(
            !realistic || (rows.row_bytes() as usize) * 10 <= written * 12,
            "{name}: estimate {} over 1.2x the {written} bytes of rows",
            rows.row_bytes()
        );
        assert!(
            !realistic || reserved * 10 <= peak * 13,
            "{name}: reserved {reserved} over 1.3x the real peak {peak}"
        );
    }
}

/// Peak bytes encoding `source` allocates when each piece is handed off before the
/// next is built, as the WAL append does, and the bytes of rows written in all.
fn piece_peak(source: RowSource<'_>, plan: &RowPlan) -> (usize, usize) {
    let mut written = 0;
    let (peak, encoded) = peak_during(|| {
        encode_pieces("org", source, plan, |frames| {
            written += frames.iter().map(|(_, payload)| payload.len()).sum::<usize>();
        })
    });
    encoded.unwrap();
    (peak, written)
}

/// However many rows a request expands to, building them holds one piece at a time:
/// the peak stays within the largest piece's reservation, far below the rows.
#[test]
fn rows_are_built_in_bounded_memory_whatever_the_request_expands_to() {
    let jvm_points = 200_000;
    let cases = [
        // A long resource attribute repeated on every one of 2,000 points.
        (
            "high expansion",
            Request::Metrics(metrics_of(vec![gauge(
                "m",
                "d".repeat(LONG),
                vec![NumberDataPoint::default(); 2_000],
            )])),
        ),
        // An ordinary batch the size of the largest ones seen, from a JVM service.
        (
            "large ordinary batch",
            Request::Metrics(shapes::metrics_from(shapes::jvm_resource(), jvm_points)),
        ),
    ];
    for (name, request) in cases {
        let plan = request.plan();
        let (peak, written) = piece_peak(request.source(), &plan);
        let reserved = plan.largest_piece_heap() as usize;
        eprintln!(
            "{name:>22}: wire {:>10} B, rows {written:>11} B in {:>3} pieces, peak {peak:>10} B, \
             reserved {reserved:>10} B",
            request.wire_len(),
            plan.pieces.len(),
        );
        assert!(written as u64 <= plan.total.row_bytes(), "{name}: rows within the estimate");
        assert!(plan.pieces.len() > 4, "{name}: split into pieces");
        assert!(peak <= reserved, "{name}: reserved {reserved} below the peak {peak}");
        assert!(
            reserved <= 2 * ROW_PIECE_BYTES as usize,
            "{name}: one piece reserves {reserved}, about one piece of rows"
        );
        assert!(peak * 4 < written, "{name}: peak {peak} against {written} bytes of rows");
    }
}

/// Mapping rules that copy a value one to the next copy the longest value each time,
/// and the estimate holds for that: the rows and the peak stay within it.
#[test]
fn chained_attribute_mappings_stay_within_their_estimate() {
    let long = 4 * 1024;
    let mut rules = vec![AttributeMappingRule {
        source_context: MappingSourceContext::Resource,
        source_key: "process.command_line".to_owned(),
        target_key: "m0".to_owned(),
        operation: MappingOperation::Copy,
    }];
    rules.extend((1..64).map(|step| AttributeMappingRule {
        source_context: MappingSourceContext::Span,
        source_key: format!("m{}", step - 1),
        target_key: format!("m{step}"),
        operation: MappingOperation::Copy,
    }));
    let request = spans_under(
        vec![string_attr("process.command_line", &"c".repeat(long))],
        None,
        vec![Span::default(); 200],
    );
    let policy = SamplingPolicy::default();
    let source = RowSource::Traces {
        request: &request,
        policy: &policy,
        mappings: &rules,
    };
    let plan = source.plan("org", ROW_PIECE_BYTES);
    let (peak, written) = piece_peak(source, &plan);
    let reserved = plan.largest_piece_heap() as usize;
    eprintln!(
        "chained mappings: rows {written} B ({} B estimated) in {} pieces, peak {peak} B, \
         reserved {reserved} B",
        plan.total.row_bytes(),
        plan.pieces.len(),
    );
    // Every span carries 64 copies of the long value.
    assert!(written > 200 * 64 * long, "the chain copied the value on: {written}");
    assert!(written as u64 <= plan.total.row_bytes(), "rows within the estimate");
    assert!(peak <= reserved, "reserved {reserved} below the peak {peak}");
}

/// Building the body a request is forwarded as never allocates past what is
/// reserved for it, as protobuf or JSON and with or without gzip.
#[test]
fn forward_body_stays_within_what_was_reserved() {
    for Case {
        name,
        realistic,
        request,
    } in cases()
    {
        for (format, json) in [("protobuf", false), ("json", true)] {
            for gzip in [false, true] {
                let body = request.forward_body(json, gzip);
                let reserved = body.heap_bytes() as usize;
                let (peak, sent) = peak_during(|| request.forward(&body));
                eprintln!(
                    "{name:>40} {format:>8} gzip={gzip:<5}: body {:>10} B, peak {peak:>10} B, \
                     reserved {reserved:>10} B ({:.2}x peak)",
                    sent.len(),
                    reserved as f64 / peak as f64,
                );
                assert!(
                    peak <= reserved,
                    "{name} as {format}, gzip {gzip}: reserved {reserved} below the real peak {peak}"
                );
                // Uncompressed protobuf is the encoded request, held exactly once.
                assert!(
                    json || gzip || peak == reserved,
                    "{name} as {format}: reserved {reserved} is not the peak {peak}"
                );
                assert!(
                    !realistic || reserved <= peak * 3,
                    "{name} as {format}, gzip {gzip}: reserved {reserved} over 3x the peak {peak}"
                );
            }
        }
    }
}

/// What encoding allocated and wrote, against the estimate made first.
fn assert_within(
    rows: &RowEstimate,
    peak: usize,
    payloads: &[Bytes],
) -> Result<(), proptest::test_runner::TestCaseError> {
    let written: usize = payloads.iter().map(Bytes::len).sum();
    // Every row ends in a newline, so splitting on them leaves one empty piece.
    let lines = payloads
        .iter()
        .map(|payload| payload.split(|byte| *byte == b'\n').count() - 1)
        .sum::<usize>();
    proptest::prop_assert_eq!(lines as u64, rows.rows, "rows counted");
    proptest::prop_assert!(
        written as u64 <= rows.row_bytes(),
        "{} bytes of rows against an estimate of {}",
        written,
        rows.row_bytes()
    );
    proptest::prop_assert!(
        peak as u64 <= rows.heap_bytes(),
        "reserved {} below the real peak {}",
        rows.heap_bytes(),
        peak
    );
    Ok(())
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig::with_cases(512))]

    /// Whatever a request holds, in whatever shape, its rows fit their estimate and
    /// encoding them fits what the estimate reserves: sampled, mapped, escaped,
    /// nested, repeated keys, ids of any length.
    #[test]
    fn any_request_is_encoded_within_its_estimate(seed in 1_u64..) {
        let mut rng = Rng(seed);
        let (traces, policy, mappings) = (rng.traces(), rng.policy(), rng.mappings());
        let rows = trace_rows("org", &traces, &policy, &mappings);
        let (peak, payloads) =
            peak_during(|| encode_trace_rows("org", &traces, &policy, &mappings).unwrap());
        // Encoding estimates for itself; that pass allocates nothing that lasts.
        assert_within(&rows, peak, &payloads)?;

        let logs = rng.logs();
        let rows = log_rows(&logs);
        let (peak, payloads) = peak_during(|| encode_log_rows(&logs).unwrap());
        assert_within(&rows, peak, &payloads)?;

        let metrics = rng.metrics();
        let rows = metric_rows(&metrics);
        let (peak, payloads) = peak_during(|| encode_metric_rows(&metrics).unwrap());
        assert_within(&rows, peak, &payloads)?;
    }
}

/// A JSON value whose every object has its keys in strictly ascending order.
struct KeysInOrder;

impl<'de> serde::Deserialize<'de> for KeysInOrder {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = KeysInOrder;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a JSON value")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<KeysInOrder, A::Error> {
                let mut last: Option<String> = None;
                while let Some(key) = map.next_key::<String>()? {
                    if last.as_ref().is_some_and(|last| *last >= key) {
                        return Err(serde::de::Error::custom(format!(
                            "key {key:?} follows {last:?}"
                        )));
                    }
                    map.next_value::<KeysInOrder>()?;
                    last = Some(key);
                }
                Ok(KeysInOrder)
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<KeysInOrder, A::Error> {
                while seq.next_element::<KeysInOrder>()?.is_some() {}
                Ok(KeysInOrder)
            }

            fn visit_str<E>(self, _: &str) -> Result<KeysInOrder, E> {
                Ok(KeysInOrder)
            }

            fn visit_bool<E>(self, _: bool) -> Result<KeysInOrder, E> {
                Ok(KeysInOrder)
            }

            fn visit_u64<E>(self, _: u64) -> Result<KeysInOrder, E> {
                Ok(KeysInOrder)
            }

            fn visit_i64<E>(self, _: i64) -> Result<KeysInOrder, E> {
                Ok(KeysInOrder)
            }

            fn visit_f64<E>(self, _: f64) -> Result<KeysInOrder, E> {
                Ok(KeysInOrder)
            }

            fn visit_unit<E>(self) -> Result<KeysInOrder, E> {
                Ok(KeysInOrder)
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

/// Every row is one JSON object with its keys in ascending order and no key
/// twice, at every depth: the order rows were written in when each was built as a
/// sorted map first, so writing them straight into the frame changed no row.
#[test]
fn rows_are_written_with_their_keys_in_order() {
    let mut rng = Rng(0x5eed);
    let mut checked = 0;
    for _ in 0..200 {
        let payloads = [
            encode_trace_rows("org", &rng.traces(), &rng.policy(), &rng.mappings()).unwrap(),
            encode_log_rows(&rng.logs()).unwrap(),
            encode_metric_rows(&rng.metrics()).unwrap(),
        ];
        for payload in payloads.iter().flatten() {
            for row in payload
                .split(|byte| *byte == b'\n')
                .filter(|row| !row.is_empty())
            {
                serde_json::from_slice::<KeysInOrder>(row)
                    .unwrap_or_else(|error| panic!("{error} in {}", String::from_utf8_lossy(row)));
                checked += 1;
            }
        }
    }
    assert!(checked > 1_000, "only {checked} rows were generated");
}
