//! What storing a decoded OTLP request allocates, worked out before a row is built.
//! A row repeats its resource, scope and metric strings, so the rows are not bounded
//! by the request's size. Mirrors `telemetry`'s encoders: never below what they write.

use crate::telemetry::{self, AttributeMappingRule, MappingSourceContext, RowKind, SamplingPolicy};
use flate2::write::GzEncoder;
use flate2::Compression;
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::metrics::v1::{metric, Exemplar};
use opentelemetry_proto::tonic::resource::v1::Resource;
use serde::Serialize;
use std::fmt;
use std::io::{self, Write};
use std::mem::size_of;

/// Datasources one request can write to: the four metric shapes.
pub const ROW_SLOTS: usize = 4;

/// The rows a request encodes to, as an upper bound.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RowEstimate {
    pub rows: u64,
    /// NDJSON bytes per datasource, newlines included.
    pub payload_bytes: [u64; ROW_SLOTS],
    /// Heap the largest row needs while it is built, with its resource and scope.
    pub work_bytes: u64,
}

impl RowEstimate {
    /// Bytes of rows the request stores, across its datasources.
    pub fn row_bytes(&self) -> u64 {
        self.payload_bytes
            .iter()
            .fold(0, |total, bytes| total.saturating_add(*bytes))
    }

    /// Everything encoding the rows allocates: the payloads, held once each, the
    /// working memory, and the frames around them.
    pub fn heap_bytes(&self) -> u64 {
        self.row_bytes()
            .saturating_add(self.work_bytes)
            .saturating_add(FRAMES)
    }
}

/// A frame's header, names and queue entry, for each of a request's frames.
const FRAMES: u64 = 16 * 1024;
/// A row's ids, timestamps and sampling key, none of which the sender can grow.
const ROW_BASE: u64 = 4 * 1024;
/// A formatted timestamp, in the `String` its formatting grew.
const TIMESTAMP: u64 = 64;
/// A timestamp as a row writes it, with its quotes and a comma.
const TIMESTAMP_JSON: u64 = 32;
/// The longest a float is written, and an `i32` with its sign.
const FLOAT_JSON: u64 = 24;
const INT_JSON: u64 = 11;
/// The `SampleRate` attribute a sampled span gains.
const SAMPLE_RATE_JSON: u64 = 40;
const VALUE: u64 = size_of::<serde_json::Value>() as u64;
/// A `BTreeMap<String, Value>` node: eleven entries, its header and its edges.
const MAP_BASE: u64 = 11 * (size_of::<String>() as u64 + VALUE) + 112;
/// One more entry: nodes split half full and their parents hold an edge each.
const MAP_ENTRY: u64 = 160;

/// A value's bytes in a row and the heap building it takes.
#[derive(Clone, Copy, Default)]
struct Cost {
    json: u64,
    work: u64,
}

type Escapes = [u8; 256];

/// Bytes each input byte becomes in a JSON string: `quote` for a quote or
/// backslash, `short` for a two-character escape, `unicode` for other controls.
const fn escapes(quote: u8, short: u8, unicode: u8) -> Escapes {
    let mut table = [1_u8; 256];
    let mut control = 0;
    while control < 0x20 {
        table[control] = unicode;
        control += 1;
    }
    table[0x08] = short;
    table[0x09] = short;
    table[0x0a] = short;
    table[0x0c] = short;
    table[0x0d] = short;
    table[b'"' as usize] = quote;
    table[b'\\' as usize] = quote;
    table
}

const ESCAPED: Escapes = escapes(2, 2, 6);
/// A JSON string inside a JSON string: the first escaping's backslashes and
/// quotes are escaped again.
const ESCAPED_TWICE: Escapes = escapes(4, 3, 7);

/// Bytes `text` takes as the contents of a JSON string.
fn escaped(text: &[u8], table: &Escapes) -> u64 {
    // Counting without an early exit vectorizes, and most text needs no escape.
    let special = text
        .iter()
        .filter(|&&byte| byte < 0x20 || byte == b'"' || byte == b'\\')
        .count();
    if special == 0 {
        return text.len() as u64;
    }
    text.iter()
        .map(|&byte| u64::from(table[usize::from(byte)]))
        .sum()
}

fn text_json(text: &str) -> u64 {
    escaped(text.as_bytes(), &ESCAPED)
}

/// A byte string as hex, which is how ids are written.
const fn hex(bytes: &[u8]) -> u64 {
    2 * bytes.len() as u64
}

struct Counter(u64);

impl fmt::Write for Counter {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        self.0 += text.len() as u64;
        Ok(())
    }
}

impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 += bytes.len() as u64;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Characters `value` formats to.
fn display_len(value: impl fmt::Display) -> u64 {
    let mut counter = Counter(0);
    // A counter takes every write, so formatting into it cannot fail.
    fmt::Write::write_fmt(&mut counter, format_args!("{value}")).unwrap_or_default();
    counter.0
}

/// Bytes `value` serializes to as JSON, without building it.
pub fn json_len(value: &impl Serialize) -> Result<u64, serde_json::Error> {
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}

/// A scalar as the text `any_value_string` makes of it, escaped by `table`.
fn scalar_cost(value: &AnyValue, table: &Escapes) -> Cost {
    // A formatted number's `String` doubles as it grows, from eight bytes.
    let formatted = |len: u64| Cost {
        json: len,
        work: 2 * len + 16,
    };
    match value.value.as_ref() {
        Some(any_value::Value::StringValue(text)) => Cost {
            json: escaped(text.as_bytes(), table),
            work: text.len() as u64,
        },
        Some(any_value::Value::BoolValue(value)) => formatted(display_len(value)),
        Some(any_value::Value::IntValue(value)) => formatted(display_len(value)),
        Some(any_value::Value::DoubleValue(value)) => formatted(display_len(value)),
        // Kept as text or written as hex: the longer of the two covers both.
        Some(any_value::Value::BytesValue(bytes)) => Cost {
            json: escaped(bytes, table).max(hex(bytes)),
            work: hex(bytes),
        },
        _ => Cost::default(),
    }
}

/// An attribute value as the JSON string a row stores it as, quotes excluded.
fn value_cost(value: &AnyValue) -> Cost {
    match value.value.as_ref() {
        Some(any_value::Value::ArrayValue(_) | any_value::Value::KvlistValue(_)) => {
            let nested = nested_cost(value);
            Cost {
                json: nested.json,
                // The `Value` tree, and the string serialized from it as it doubles.
                work: nested.work + 3 * nested.json + 256,
            }
        }
        _ => scalar_cost(value, &ESCAPED),
    }
}

/// A nested array or map as the JSON a row stores inside a string, and the
/// `Value` tree it is serialized from.
fn nested_cost(value: &AnyValue) -> Cost {
    match value.value.as_ref() {
        Some(any_value::Value::ArrayValue(array)) => {
            let mut cost = Cost {
                json: 2,
                work: array.values.len() as u64 * VALUE,
            };
            for element in &array.values {
                let element = nested_cost(element);
                cost.json += element.json + 1;
                cost.work += element.work;
            }
            cost
        }
        Some(any_value::Value::KvlistValue(list)) => {
            let mut cost = Cost {
                json: 2,
                work: MAP_BASE,
            };
            for entry in &list.values {
                let empty = Cost { json: 4, work: 0 };
                let value = entry.value.as_ref().map_or(empty, nested_cost);
                // The key's escaped quotes, a colon and a comma.
                cost.json += escaped(entry.key.as_bytes(), &ESCAPED_TWICE) + 6 + value.json;
                cost.work += MAP_ENTRY + entry.key.len() as u64 + value.work;
            }
            cost
        }
        _ => {
            let text = scalar_cost(value, &ESCAPED_TWICE);
            // A scalar is a string here, and its quotes are escaped too.
            Cost {
                json: text.json + 4,
                work: text.work,
            }
        }
    }
}

/// An attribute list as the JSON object a row stores it as, and the map it is
/// built in.
#[derive(Clone, Copy)]
struct Attributes {
    json: u64,
    work: u64,
    /// The longest value: what an attribute mapping can copy into a span.
    longest: Cost,
}

fn attributes_cost(attributes: &[KeyValue]) -> Attributes {
    let mut cost = Attributes {
        json: 2,
        work: MAP_BASE,
        longest: Cost::default(),
    };
    for attribute in attributes {
        let value = attribute.value.as_ref().map(value_cost).unwrap_or_default();
        // The key's and value's quotes, a colon and a comma.
        cost.json += text_json(&attribute.key) + 6 + value.json;
        cost.work += MAP_ENTRY + attribute.key.len() as u64 + value.work;
        cost.longest.json = cost.longest.json.max(value.json);
        cost.longest.work = cost.longest.work.max(value.work);
    }
    cost
}

/// What every row under a resource repeats: its attributes, schema URL and the
/// service name read out of the attributes.
fn resource_cost(resource: Option<&Resource>, schema_url: &str) -> Attributes {
    let attributes = resource.map_or(&[][..], |resource| &resource.attributes);
    let mut cost = attributes_cost(attributes);
    let service_name = attributes
        .iter()
        .rev()
        .find(|attribute| attribute.key == "service.name")
        .and_then(|attribute| attribute.value.as_ref())
        .map_or(0, |value| value_cost(value).json);
    cost.json += service_name + text_json(schema_url);
    cost
}

/// What every row under a scope repeats.
fn scope_cost(scope: Option<&InstrumentationScope>, schema_url: &str) -> Attributes {
    let mut cost = attributes_cost(scope.map_or(&[][..], |scope| &scope.attributes));
    if let Some(scope) = scope {
        cost.json += text_json(&scope.name) + text_json(&scope.version);
    }
    cost.json += text_json(schema_url);
    cost
}

/// An org's attribute mappings, as what each can add to a span.
struct Mappings {
    /// The target keys and their punctuation.
    keys: Cost,
    from_span: u64,
    from_resource: u64,
}

impl Mappings {
    fn of(rules: &[AttributeMappingRule]) -> Self {
        let mut mappings = Self {
            keys: Cost::default(),
            from_span: 0,
            from_resource: 0,
        };
        for rule in rules {
            mappings.keys.json += text_json(&rule.target_key) + 6;
            mappings.keys.work += MAP_ENTRY + rule.target_key.len() as u64;
            match rule.source_context {
                MappingSourceContext::Span => mappings.from_span += 1,
                MappingSourceContext::Resource => mappings.from_resource += 1,
            }
        }
        mappings
    }

    /// The most the rules add to a span: each copies one value, at most the longest.
    fn cost(&self, span: Cost, resource: Cost) -> Cost {
        Cost {
            json: self.keys.json + self.from_span * span.json + self.from_resource * resource.json,
            work: self.keys.work + self.from_span * span.work + self.from_resource * resource.work,
        }
    }
}

struct Tally {
    estimate: RowEstimate,
    resource_work: u64,
    scope_work: u64,
    row_work: u64,
}

impl Tally {
    fn new() -> Self {
        Self {
            estimate: RowEstimate::default(),
            resource_work: 0,
            scope_work: 0,
            row_work: 0,
        }
    }

    /// One row of `kind`: its `json` on top of the empty row, built in `work`.
    fn row(&mut self, kind: RowKind, json: u64, work: u64) {
        let slot = &mut self.estimate.payload_bytes[kind.slot()];
        *slot = slot.saturating_add(telemetry::empty_row_len(kind).saturating_add(json));
        self.estimate.rows += 1;
        self.row_work = self.row_work.max(work);
    }

    fn finish(mut self) -> RowEstimate {
        // One resource's map, one scope's and one row are alive at a time.
        self.estimate.work_bytes = self
            .resource_work
            .saturating_add(self.scope_work)
            .saturating_add(self.row_work)
            .saturating_add(ROW_BASE);
        self.estimate
    }
}

/// The rows `request` encodes to once `policy` has sampled it and `mappings` have
/// run: the spans the encoder keeps, each with everything it repeats.
pub fn trace_rows(
    org_id: &str,
    request: &ExportTraceServiceRequest,
    policy: &SamplingPolicy,
    mappings: &[AttributeMappingRule],
) -> RowEstimate {
    let sampling = policy.samples();
    let mappings = Mappings::of(mappings);
    let mut tally = Tally::new();
    for resource_spans in &request.resource_spans {
        let resource = resource_cost(resource_spans.resource.as_ref(), &resource_spans.schema_url);
        tally.resource_work = tally.resource_work.max(resource.work);
        for scope_spans in &resource_spans.scope_spans {
            let scope = scope_cost(scope_spans.scope.as_ref(), &scope_spans.schema_url);
            tally.scope_work = tally.scope_work.max(scope.work);
            let shared = resource.json + scope.json;
            for span in &scope_spans.spans {
                if sampling && !telemetry::keeps_span(org_id, span, policy) {
                    continue;
                }
                let attributes = attributes_cost(&span.attributes);
                let mapped = mappings.cost(attributes.longest, resource.longest);
                let ids = hex(&span.trace_id) + hex(&span.span_id) + hex(&span.parent_span_id);
                let duration = span
                    .end_time_unix_nano
                    .saturating_sub(span.start_time_unix_nano);
                let mut json = shared
                    + attributes.json
                    + mapped.json
                    + ids
                    + digits(duration)
                    + text_json(&span.name)
                    + text_json(&span.trace_state)
                    + span
                        .status
                        .as_ref()
                        .map_or(0, |status| text_json(&status.message));
                let mut work = attributes.work + mapped.work + ids;
                if sampling {
                    json += SAMPLE_RATE_JSON;
                    work += MAP_ENTRY + TIMESTAMP;
                }
                for event in &span.events {
                    let attributes = attributes_cost(&event.attributes);
                    json += text_json(&event.name) + 3 + TIMESTAMP_JSON + attributes.json + 1;
                    work += 2 * TIMESTAMP + attributes.work;
                }
                for link in &span.links {
                    let attributes = attributes_cost(&link.attributes);
                    let ids = hex(&link.trace_id) + hex(&link.span_id);
                    json += ids + text_json(&link.trace_state) + 9 + attributes.json + 1;
                    work += ids + 2 * TIMESTAMP + attributes.work;
                }
                tally.row(RowKind::Trace, json, work);
            }
        }
    }
    tally.finish()
}

/// The rows `request` encodes to: one per log record.
pub fn log_rows(request: &ExportLogsServiceRequest) -> RowEstimate {
    let mut tally = Tally::new();
    for resource_logs in &request.resource_logs {
        let resource = resource_cost(resource_logs.resource.as_ref(), &resource_logs.schema_url);
        tally.resource_work = tally.resource_work.max(resource.work);
        for scope_logs in &resource_logs.scope_logs {
            let scope = scope_cost(scope_logs.scope.as_ref(), &scope_logs.schema_url);
            tally.scope_work = tally.scope_work.max(scope.work);
            let shared = resource.json + scope.json;
            for log in &scope_logs.log_records {
                let attributes = attributes_cost(&log.attributes);
                let mut body = log.body.as_ref().map(value_cost).unwrap_or_default();
                // A text body is written from the request itself, not from a copy.
                if matches!(
                    log.body.as_ref().and_then(|body| body.value.as_ref()),
                    Some(any_value::Value::StringValue(_))
                ) {
                    body.work = 0;
                }
                let ids = hex(&log.trace_id) + hex(&log.span_id);
                let json = shared
                    + attributes.json
                    + body.json
                    + ids
                    + digits(u64::from(log.flags))
                    + INT_JSON
                    + text_json(&log.severity_text);
                tally.row(RowKind::Log, json, attributes.work + body.work + ids);
            }
        }
    }
    tally.finish()
}

/// Decimal digits of `value`.
fn digits(value: u64) -> u64 {
    u64::from(value.checked_ilog10().unwrap_or(0)) + 1
}

/// A list of integers as a row writes it: each with a comma.
fn integers_json(values: &[u64]) -> u64 {
    values.iter().map(|value| digits(*value) + 1).sum()
}

fn exemplars_cost(exemplars: &[Exemplar]) -> Cost {
    let mut cost = Cost::default();
    for exemplar in exemplars {
        let attributes = attributes_cost(&exemplar.filtered_attributes);
        let ids = hex(&exemplar.trace_id) + hex(&exemplar.span_id);
        // Two quoted ids, a timestamp and a value, each with its comma.
        cost.json += ids + 6 + TIMESTAMP_JSON + FLOAT_JSON + 1 + attributes.json + 1;
        cost.work += ids + 3 * TIMESTAMP + attributes.work;
    }
    cost
}

/// The rows `request` encodes to: one per data point, each repeating its metric's
/// name, description and unit. Summaries are not stored.
pub fn metric_rows(request: &ExportMetricsServiceRequest) -> RowEstimate {
    let mut tally = Tally::new();
    for resource_metrics in &request.resource_metrics {
        let resource = resource_cost(
            resource_metrics.resource.as_ref(),
            &resource_metrics.schema_url,
        );
        tally.resource_work = tally.resource_work.max(resource.work);
        for scope_metrics in &resource_metrics.scope_metrics {
            let scope = scope_cost(scope_metrics.scope.as_ref(), &scope_metrics.schema_url);
            tally.scope_work = tally.scope_work.max(scope.work);
            for metric in &scope_metrics.metrics {
                let shared = resource.json
                    + scope.json
                    + text_json(&metric.name)
                    + text_json(&metric.description)
                    + text_json(&metric.unit);
                // What every point's row holds besides its own numbers.
                let point = |attributes: &[KeyValue], exemplars: &[Exemplar], flags: u32| {
                    let attributes = attributes_cost(attributes);
                    let exemplars = exemplars_cost(exemplars);
                    Cost {
                        json: shared + attributes.json + exemplars.json + digits(u64::from(flags)),
                        work: attributes.work + exemplars.work,
                    }
                };
                match metric.data.as_ref() {
                    Some(metric::Data::Gauge(gauge)) => {
                        for data in &gauge.data_points {
                            let row = point(&data.attributes, &data.exemplars, data.flags);
                            tally.row(RowKind::Gauge, row.json + FLOAT_JSON, row.work);
                        }
                    }
                    Some(metric::Data::Sum(sum)) => {
                        for data in &sum.data_points {
                            let row = point(&data.attributes, &data.exemplars, data.flags);
                            tally.row(RowKind::Sum, row.json + FLOAT_JSON + INT_JSON, row.work);
                        }
                    }
                    Some(metric::Data::Histogram(histogram)) => {
                        for data in &histogram.data_points {
                            let row = point(&data.attributes, &data.exemplars, data.flags);
                            // The sum, minimum and maximum, then each bound.
                            let numbers = INT_JSON
                                + digits(data.count)
                                + 3 * FLOAT_JSON
                                + integers_json(&data.bucket_counts)
                                + data.explicit_bounds.len() as u64 * (FLOAT_JSON + 1);
                            tally.row(RowKind::Histogram, row.json + numbers, row.work);
                        }
                    }
                    Some(metric::Data::ExponentialHistogram(histogram)) => {
                        for data in &histogram.data_points {
                            let row = point(&data.attributes, &data.exemplars, data.flags);
                            let buckets = [data.positive.as_ref(), data.negative.as_ref()]
                                .into_iter()
                                .flatten()
                                .map(|buckets| integers_json(&buckets.bucket_counts))
                                .sum::<u64>();
                            // The temporality, scale and two offsets, then the three floats.
                            let numbers = 4 * INT_JSON
                                + digits(data.count)
                                + digits(data.zero_count)
                                + 3 * FLOAT_JSON
                                + buckets;
                            tally.row(RowKind::ExponentialHistogram, row.json + numbers, row.work);
                        }
                    }
                    Some(metric::Data::Summary(_)) | None => {}
                }
            }
        }
    }
    tally.finish()
}

/// The compressor's own tables and window, whatever it is given.
const GZIP_STATE: u64 = 1024 * 1024;

/// The most `len` bytes gzip to: incompressible input is stored in blocks.
const fn gzip_bound(len: u64) -> u64 {
    len + len / 512 + 1024
}

/// A request that can be forwarded to a collector.
pub trait ForwardRequest: prost::Message + Serialize {
    /// Elements of its longest list of integers, which the JSON form writes from a
    /// list of strings it builds first.
    fn longest_integer_list(&self) -> u64 {
        0
    }
}

impl ForwardRequest for ExportTraceServiceRequest {}
impl ForwardRequest for ExportLogsServiceRequest {}

impl ForwardRequest for ExportMetricsServiceRequest {
    fn longest_integer_list(&self) -> u64 {
        let metrics = self
            .resource_metrics
            .iter()
            .flat_map(|resource| &resource.scope_metrics)
            .flat_map(|scope| &scope.metrics);
        let mut longest = 0;
        for metric in metrics {
            match metric.data.as_ref() {
                Some(metric::Data::Histogram(histogram)) => {
                    for point in &histogram.data_points {
                        longest = longest.max(point.bucket_counts.len());
                    }
                }
                Some(metric::Data::ExponentialHistogram(histogram)) => {
                    for point in &histogram.data_points {
                        for buckets in [point.positive.as_ref(), point.negative.as_ref()] {
                            let len = buckets.map_or(0, |buckets| buckets.bucket_counts.len());
                            longest = longest.max(len);
                        }
                    }
                }
                _ => {}
            }
        }
        longest as u64
    }
}

/// The body a request is forwarded to a collector as, costed before it is built.
#[derive(Clone, Copy, Debug)]
pub struct ForwardBody {
    json: bool,
    gzip: bool,
    /// Bytes the request encodes to.
    len: u64,
    /// Heap encoding it takes beyond those bytes.
    work: u64,
}

impl ForwardBody {
    /// A number as the string the JSON form writes it as, in a list of them.
    const INTEGER_STRING: u64 = (size_of::<String>() + 32) as u64;

    pub fn of(
        request: &impl ForwardRequest,
        json: bool,
        gzip: bool,
    ) -> Result<Self, serde_json::Error> {
        if !json {
            // Protobuf is written straight into its buffer.
            return Ok(Self {
                json,
                gzip,
                len: request.encoded_len() as u64,
                work: 0,
            });
        }
        let len = json_len(request)?;
        // An id or a bytes value is turned into text before it is written, and that
        // text is part of the output, so no longer than it.
        let work = len + request.longest_integer_list() * Self::INTEGER_STRING + 4096;
        Ok(Self {
            json,
            gzip,
            len,
            work,
        })
    }

    /// What building the body allocates: the encoded request, and its gzip output
    /// beside it when the sender compressed.
    pub fn heap_bytes(&self) -> u64 {
        let mut heap = self.len.saturating_add(self.work);
        if self.gzip {
            heap = heap
                .saturating_add(gzip_bound(self.len))
                .saturating_add(GZIP_STATE);
        }
        heap
    }

    /// The body, each of its buffers allocated once at the size costed.
    pub fn build(&self, request: &impl ForwardRequest) -> io::Result<Vec<u8>> {
        let mut encoded = Vec::with_capacity(usize::try_from(self.len).unwrap_or(0));
        if self.json {
            serde_json::to_writer(&mut encoded, request)?;
        } else {
            request.encode(&mut encoded).map_err(io::Error::other)?;
        }
        if !self.gzip {
            return Ok(encoded);
        }
        let capacity = usize::try_from(gzip_bound(encoded.len() as u64)).unwrap_or(0);
        let mut encoder = GzEncoder::new(Vec::with_capacity(capacity), Compression::default());
        encoder.write_all(&encoded)?;
        encoder.finish()
    }
}
