//! A small deterministic generator of OTLP requests in every shape the encoders
//! take: escapes, nesting, repeated keys, ids of any length, sampling and mappings.

#![expect(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_possible_wrap,
    reason = "random fixtures: truncating a random number is still a random number"
)]

use maple_ingest::telemetry::{
    AttributeMappingRule, MappingOperation, MappingSourceContext, SamplingPolicy,
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

/// A small deterministic generator: the cases a seed makes are reproducible.
pub(crate) struct Rng(pub(crate) u64);

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

    fn chance(&mut self, one_in: usize) -> bool {
        self.below(one_in) == 0
    }

    /// Text with the characters JSON escapes and some that take several bytes.
    fn text(&mut self, max: usize) -> String {
        const ALPHABET: [char; 12] = [
            'a', 'k', '.', ' ', '"', '\\', '\n', '\t', '\u{1}', '\u{7f}', 'é', '😀',
        ];
        let len = self.below(max + 1);
        (0..len)
            .map(|_| ALPHABET[self.below(ALPHABET.len())])
            .collect()
    }

    fn bytes(&mut self, max: usize) -> Vec<u8> {
        let len = self.below(max + 1);
        // Zeroed ids are written empty, and some bytes are text.
        match self.below(3) {
            0 => vec![0; len],
            1 => self.text(len).into_bytes(),
            _ => (0..len).map(|_| self.next() as u8).collect(),
        }
    }

    fn number(&mut self) -> u64 {
        match self.below(4) {
            0 => 0,
            1 => u64::MAX,
            2 => self.next() % 1_000,
            _ => self.next(),
        }
    }

    fn float(&mut self) -> f64 {
        match self.below(7) {
            0 => 0.0,
            1 => f64::NAN,
            2 => f64::INFINITY,
            3 => -1.797_693_134_862_315_7e308,
            4 => 5e-324,
            5 => self.below(1_000) as f64 / 8.0,
            _ => f64::from_bits(self.next()),
        }
    }

    fn any(&mut self, depth: usize) -> Option<AnyValue> {
        let value = match self.below(if depth == 0 { 7 } else { 9 }) {
            0 => return None,
            1 => return Some(AnyValue::default()),
            2 => any_value::Value::StringValue(self.text(24)),
            3 => any_value::Value::BoolValue(self.chance(2)),
            4 => any_value::Value::IntValue(self.number() as i64),
            5 => any_value::Value::DoubleValue(self.float()),
            6 => any_value::Value::BytesValue(self.bytes(12)),
            7 => any_value::Value::ArrayValue(ArrayValue {
                values: (0..self.below(4))
                    .map(|_| self.any(depth - 1).unwrap_or_default())
                    .collect(),
            }),
            _ => any_value::Value::KvlistValue(KeyValueList {
                values: self.attributes(depth - 1),
            }),
        };
        Some(AnyValue { value: Some(value) })
    }

    fn attributes(&mut self, depth: usize) -> Vec<KeyValue> {
        const KEYS: [&str; 6] = [
            "service.name",
            "SampleRate",
            "a",
            "b\"",
            "",
            "long.key.name",
        ];
        (0..self.below(5))
            .map(|_| KeyValue {
                key: if self.chance(3) {
                    self.text(8)
                } else {
                    KEYS[self.below(KEYS.len())].to_owned()
                },
                value: self.any(depth),
                ..Default::default()
            })
            .collect()
    }

    fn resource(&mut self) -> Option<Resource> {
        (!self.chance(5)).then(|| Resource {
            attributes: self.attributes(2),
            ..Default::default()
        })
    }

    fn scope(&mut self) -> Option<InstrumentationScope> {
        (!self.chance(5)).then(|| InstrumentationScope {
            name: self.text(12),
            version: self.text(6),
            attributes: self.attributes(2),
            ..Default::default()
        })
    }

    fn span(&mut self) -> Span {
        let start = self.number();
        Span {
            trace_id: self.bytes(20),
            span_id: self.bytes(10),
            parent_span_id: self.bytes(10),
            trace_state: if self.chance(4) {
                "th:8".to_owned()
            } else {
                self.text(8)
            },
            name: self.text(20),
            kind: self.below(8) as i32 - 1,
            start_time_unix_nano: start,
            end_time_unix_nano: start.wrapping_add(self.number()),
            attributes: self.attributes(2),
            events: (0..self.below(3))
                .map(|_| span::Event {
                    time_unix_nano: self.number(),
                    name: self.text(10),
                    attributes: self.attributes(1),
                    ..Default::default()
                })
                .collect(),
            links: (0..self.below(3))
                .map(|_| span::Link {
                    trace_id: self.bytes(20),
                    span_id: self.bytes(10),
                    trace_state: self.text(8),
                    attributes: self.attributes(1),
                    ..Default::default()
                })
                .collect(),
            status: (!self.chance(3)).then(|| Status {
                message: self.text(16),
                code: self.below(4) as i32,
            }),
            ..Default::default()
        }
    }

    pub(crate) fn traces(&mut self) -> ExportTraceServiceRequest {
        ExportTraceServiceRequest {
            resource_spans: (0..self.below(4))
                .map(|_| ResourceSpans {
                    resource: self.resource(),
                    scope_spans: (0..self.below(3))
                        .map(|_| ScopeSpans {
                            scope: self.scope(),
                            spans: (0..self.below(5)).map(|_| self.span()).collect(),
                            schema_url: self.text(10),
                        })
                        .collect(),
                    schema_url: self.text(10),
                })
                .collect(),
        }
    }

    pub(crate) fn logs(&mut self) -> ExportLogsServiceRequest {
        ExportLogsServiceRequest {
            resource_logs: (0..self.below(4))
                .map(|_| ResourceLogs {
                    resource: self.resource(),
                    scope_logs: (0..self.below(3))
                        .map(|_| ScopeLogs {
                            scope: self.scope(),
                            log_records: (0..self.below(5))
                                .map(|_| LogRecord {
                                    time_unix_nano: self.number(),
                                    observed_time_unix_nano: self.number(),
                                    severity_number: self.number() as i32,
                                    severity_text: self.text(6),
                                    body: self.any(2),
                                    attributes: self.attributes(2),
                                    flags: self.number() as u32,
                                    trace_id: self.bytes(20),
                                    span_id: self.bytes(10),
                                    ..Default::default()
                                })
                                .collect(),
                            schema_url: self.text(10),
                        })
                        .collect(),
                    schema_url: self.text(10),
                })
                .collect(),
        }
    }

    fn exemplars(&mut self) -> Vec<Exemplar> {
        use opentelemetry_proto::tonic::metrics::v1::exemplar::Value;
        (0..self.below(3))
            .map(|_| Exemplar {
                filtered_attributes: self.attributes(1),
                time_unix_nano: self.number(),
                span_id: self.bytes(10),
                trace_id: self.bytes(20),
                value: match self.below(3) {
                    0 => None,
                    1 => Some(Value::AsInt(self.number() as i64)),
                    _ => Some(Value::AsDouble(self.float())),
                },
            })
            .collect()
    }

    fn number_point(&mut self) -> NumberDataPoint {
        NumberDataPoint {
            attributes: self.attributes(1),
            start_time_unix_nano: self.number(),
            time_unix_nano: self.number(),
            exemplars: self.exemplars(),
            flags: self.number() as u32,
            value: match self.below(3) {
                0 => None,
                1 => Some(number_data_point::Value::AsInt(self.number() as i64)),
                _ => Some(number_data_point::Value::AsDouble(self.float())),
            },
        }
    }

    fn buckets(&mut self) -> Option<Buckets> {
        (!self.chance(3)).then(|| Buckets {
            offset: self.number() as i32,
            bucket_counts: (0..self.below(6)).map(|_| self.number()).collect(),
        })
    }

    fn metric(&mut self) -> Metric {
        let temporality = self.number() as i32;
        let data = match self.below(6) {
            0 => None,
            1 => Some(metric::Data::Gauge(Gauge {
                data_points: (0..self.below(4)).map(|_| self.number_point()).collect(),
            })),
            2 => Some(metric::Data::Sum(Sum {
                data_points: (0..self.below(4)).map(|_| self.number_point()).collect(),
                aggregation_temporality: temporality,
                is_monotonic: self.chance(2),
            })),
            3 => Some(metric::Data::Histogram(Histogram {
                data_points: (0..self.below(4))
                    .map(|_| HistogramDataPoint {
                        attributes: self.attributes(1),
                        start_time_unix_nano: self.number(),
                        time_unix_nano: self.number(),
                        count: self.number(),
                        sum: self.chance(2).then(|| self.float()),
                        bucket_counts: (0..self.below(6)).map(|_| self.number()).collect(),
                        explicit_bounds: (0..self.below(6)).map(|_| self.float()).collect(),
                        exemplars: self.exemplars(),
                        flags: self.number() as u32,
                        min: self.chance(2).then(|| self.float()),
                        max: self.chance(2).then(|| self.float()),
                    })
                    .collect(),
                aggregation_temporality: temporality,
            })),
            4 => Some(metric::Data::ExponentialHistogram(ExponentialHistogram {
                data_points: (0..self.below(4))
                    .map(|_| ExponentialHistogramDataPoint {
                        attributes: self.attributes(1),
                        start_time_unix_nano: self.number(),
                        time_unix_nano: self.number(),
                        count: self.number(),
                        sum: self.chance(2).then(|| self.float()),
                        scale: self.number() as i32,
                        zero_count: self.number(),
                        positive: self.buckets(),
                        negative: self.buckets(),
                        flags: self.number() as u32,
                        exemplars: self.exemplars(),
                        min: self.chance(2).then(|| self.float()),
                        max: self.chance(2).then(|| self.float()),
                        zero_threshold: self.float(),
                    })
                    .collect(),
                aggregation_temporality: temporality,
            })),
            _ => Some(metric::Data::Summary(
                opentelemetry_proto::tonic::metrics::v1::Summary::default(),
            )),
        };
        Metric {
            name: self.text(16),
            description: self.text(40),
            unit: self.text(4),
            data,
            ..Default::default()
        }
    }

    pub(crate) fn metrics(&mut self) -> ExportMetricsServiceRequest {
        ExportMetricsServiceRequest {
            resource_metrics: (0..self.below(4))
                .map(|_| ResourceMetrics {
                    resource: self.resource(),
                    scope_metrics: (0..self.below(3))
                        .map(|_| ScopeMetrics {
                            scope: self.scope(),
                            metrics: (0..self.below(4)).map(|_| self.metric()).collect(),
                            schema_url: self.text(10),
                        })
                        .collect(),
                    schema_url: self.text(10),
                })
                .collect(),
        }
    }

    pub(crate) fn policy(&mut self) -> SamplingPolicy {
        SamplingPolicy {
            trace_sample_ratio: [1.0, 0.5, 0.01, f64::NAN][self.below(4)],
            always_keep_error_spans: self.chance(2),
            always_keep_slow_spans_ms: self.chance(3).then_some(5),
        }
    }

    /// Rules that may read a key an earlier rule wrote, so values are copied on.
    pub(crate) fn mappings(&mut self) -> Vec<AttributeMappingRule> {
        let mut rules: Vec<AttributeMappingRule> = Vec::new();
        for _ in 0..self.below(6) {
            let source_key = match rules.last() {
                Some(last) if self.chance(2) => last.target_key.clone(),
                _ => ["a", "service.name", "b\"", "missing"][self.below(4)].to_owned(),
            };
            rules.push(AttributeMappingRule {
                source_context: if self.chance(2) {
                    MappingSourceContext::Span
                } else {
                    MappingSourceContext::Resource
                },
                source_key,
                target_key: self.text(12),
                operation: if self.chance(2) {
                    MappingOperation::Move
                } else {
                    MappingOperation::Copy
                },
            });
        }
        rules
    }
}
