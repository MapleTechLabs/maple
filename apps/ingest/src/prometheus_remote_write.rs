//! Prometheus remote write 1.0 (a snappy block of a protobuf
//! `prometheus.WriteRequest`) to an OTLP metrics request Maple stores.
//!
//! Remote write 1.0 carries no reliable type per series, so the type is read
//! from the metric name, or from metadata when the same request has it.

use std::collections::HashMap;
use std::mem::size_of;

use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::metrics::v1::{
    metric, number_data_point, AggregationTemporality, Gauge, Metric, NumberDataPoint,
    ResourceMetrics, ScopeMetrics, Sum,
};
use opentelemetry_proto::tonic::resource::v1::Resource;
use prost::Message;

use crate::decode_budget::{
    heap_len, skip_group, varint, OverBudget, Stop, WIRE_FIXED32, WIRE_FIXED64, WIRE_LEN,
    WIRE_START_GROUP, WIRE_VARINT,
};

pub const INGEST_SOURCE: &str = "prometheus-remote-write";

pub const ROUTE: &str = "/v1/prometheus/write";

const SCOPE_NAME: &str = "maple-prometheus-remote-write";

/// The NaN Prometheus writes when a series goes stale.
pub const STALE_NAN_BITS: u64 = 0x7ff0_0000_0000_0002;

/// A name ending in one of these is a cumulative, monotonic sum unless metadata says otherwise.
const SUM_SUFFIXES: [&str; 4] = ["_total", "_count", "_sum", "_bucket"];

/// `prometheus.WriteRequest`, with only the fields Maple reads.
#[derive(Clone, PartialEq, Message)]
pub struct WriteRequest {
    #[prost(message, repeated, tag = "1")]
    pub timeseries: Vec<TimeSeries>,
    #[prost(message, repeated, tag = "3")]
    pub metadata: Vec<MetricMetadata>,
}

#[derive(Clone, PartialEq, Message)]
pub struct TimeSeries {
    #[prost(message, repeated, tag = "1")]
    pub labels: Vec<Label>,
    #[prost(message, repeated, tag = "2")]
    pub samples: Vec<Sample>,
    #[prost(message, repeated, tag = "3")]
    pub exemplars: Vec<Skipped>,
    #[prost(message, repeated, tag = "4")]
    pub histograms: Vec<Skipped>,
}

#[derive(Clone, PartialEq, Eq, Message)]
pub struct Label {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(string, tag = "2")]
    pub value: String,
}

#[derive(Clone, Copy, PartialEq, Message)]
pub struct Sample {
    #[prost(double, tag = "1")]
    pub value: f64,
    /// Milliseconds since the Unix epoch.
    #[prost(int64, tag = "2")]
    pub timestamp: i64,
}

/// An exemplar or a native histogram: counted, never read, and zero-sized so a
/// list of them allocates nothing.
#[derive(Clone, Copy, PartialEq, Eq, Message)]
pub struct Skipped {}

#[derive(Clone, PartialEq, Eq, Message)]
pub struct MetricMetadata {
    #[prost(enumeration = "MetricType", tag = "1")]
    pub kind: i32,
    #[prost(string, tag = "2")]
    pub metric_family_name: String,
    #[prost(string, tag = "4")]
    pub help: String,
    #[prost(string, tag = "5")]
    pub unit: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, prost::Enumeration)]
#[repr(i32)]
pub enum MetricType {
    Unknown = 0,
    Counter = 1,
    Gauge = 2,
    Histogram = 3,
    GaugeHistogram = 4,
    Summary = 5,
    Info = 6,
    StateSet = 7,
}

/// The message a remote write 2.0 sender names in its `Content-Type`.
const V2_MESSAGE: &str = "io.prometheus.write.v2.Request";

/// `true` for a `Content-Type` whose `proto` parameter names the remote write
/// 2.0 message, quoted or not.
pub fn is_v2_content_type(content_type: &str) -> bool {
    content_type.split(';').skip(1).any(|parameter| {
        parameter.split_once('=').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case("proto")
                && value
                    .trim()
                    .trim_matches('"')
                    .eq_ignore_ascii_case(V2_MESSAGE)
        })
    })
}

/// What a request carried that was stored, and what was not and why.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Samples that became data points.
    pub samples_accepted: u64,
    /// Samples of series without a `__name__`.
    pub missing_name: u64,
    /// Staleness markers.
    pub stale: u64,
    /// NaN and infinite values that are not staleness markers.
    pub non_finite: u64,
    /// Samples with a timestamp before the Unix epoch.
    pub invalid_timestamp: u64,
    pub native_histograms: u64,
    pub exemplars: u64,
}

impl Stats {
    /// Everything not stored, by the reason label the gateway's counter uses.
    pub const fn dropped(&self) -> [(&'static str, u64); 6] {
        [
            ("missing_name", self.missing_name),
            ("stale", self.stale),
            ("non_finite", self.non_finite),
            ("invalid_timestamp", self.invalid_timestamp),
            ("native_histogram", self.native_histograms),
            ("exemplar", self.exemplars),
        ]
    }
}

/// Decodes an uncompressed `prometheus.WriteRequest` and maps it onto OTLP metrics.
pub fn decode(payload: &[u8]) -> Result<(ExportMetricsServiceRequest, Stats), prost::DecodeError> {
    let request = WriteRequest::decode(payload)?;
    Ok(convert(&request))
}

/// One resource per (`job`, `instance`), one metric per name inside it, one data
/// point per sample. `job` and `instance` also stay on the data point, like the
/// metrics Maple scrapes itself.
pub fn convert(request: &WriteRequest) -> (ExportMetricsServiceRequest, Stats) {
    let families = Families::of(&request.metadata);
    let mut builder = RequestBuilder::default();
    let mut stats = Stats::default();
    for series in &request.timeseries {
        stats.exemplars += series.exemplars.len() as u64;
        stats.native_histograms += series.histograms.len() as u64;
        let labels = SeriesLabels::of(&series.labels);
        let Some(name) = labels.name else {
            stats.missing_name += series.samples.len() as u64;
            continue;
        };
        let mut kept = series
            .samples
            .iter()
            .filter_map(|sample| sample_time(sample, &mut stats).map(|time| (time, sample.value)))
            .peekable();
        // A series whose samples were all dropped leaves no metric behind.
        if kept.peek().is_none() {
            continue;
        }
        let attributes = point_attributes(&series.labels);
        let points = builder.points(&labels, name, &families);
        let before = points.len();
        points.extend(kept.map(|(time_unix_nano, value)| NumberDataPoint {
            attributes: attributes.clone(),
            // Remote write does not say when a series started.
            start_time_unix_nano: 0,
            time_unix_nano,
            value: Some(number_data_point::Value::AsDouble(value)),
            exemplars: Vec::new(),
            flags: 0,
        }));
        let accepted = points.len() - before;
        stats.samples_accepted += accepted as u64;
    }
    (builder.finish(), stats)
}

/// The sample's time in nanoseconds, or `None` (counted in `stats`) for one Maple does not store.
fn sample_time(sample: &Sample, stats: &mut Stats) -> Option<u64> {
    if sample.value.to_bits() == STALE_NAN_BITS {
        // Not stored as a flagged point: queries do not filter those yet.
        stats.stale += 1;
        return None;
    }
    if !sample.value.is_finite() {
        // The stored row is JSON, which cannot carry NaN or an infinity.
        stats.non_finite += 1;
        return None;
    }
    let Ok(millis) = u64::try_from(sample.timestamp) else {
        stats.invalid_timestamp += 1;
        return None;
    };
    Some(millis.saturating_mul(1_000_000))
}

/// The labels that identify a series, borrowed from the request.
struct SeriesLabels<'a> {
    name: Option<&'a str>,
    job: Option<&'a str>,
    instance: Option<&'a str>,
}

impl<'a> SeriesLabels<'a> {
    /// An empty label value is an absent label, as in Prometheus.
    fn of(labels: &'a [Label]) -> Self {
        let value = |name: &str| {
            labels
                .iter()
                .find(|label| label.name == name && !label.value.is_empty())
                .map(|label| label.value.as_str())
        };
        Self {
            name: value("__name__"),
            job: value("job"),
            instance: value("instance"),
        }
    }
}

/// Every label but `__name__`, under its own name.
fn point_attributes(labels: &[Label]) -> Vec<KeyValue> {
    let kept = |label: &&Label| label.name != "__name__" && !label.value.is_empty();
    let mut attributes = Vec::with_capacity(labels.iter().filter(kept).count());
    attributes.extend(
        labels
            .iter()
            .filter(kept)
            .map(|label| attribute(&label.name, &label.value)),
    );
    attributes
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Gauge,
    /// Cumulative: remote write samples are the series' running value.
    Sum {
        monotonic: bool,
    },
}

/// The metadata a request carries, by metric family name.
struct Families<'a>(HashMap<&'a str, &'a MetricMetadata>);

impl<'a> Families<'a> {
    fn of(metadata: &'a [MetricMetadata]) -> Self {
        Self(
            metadata
                .iter()
                .filter(|family| !family.metric_family_name.is_empty())
                .map(|family| (family.metric_family_name.as_str(), family))
                .collect(),
        )
    }

    /// The kind of the series `name`, and the metadata that describes it.
    /// Metadata for the name itself wins over the suffix; a component series
    /// (`<family>_bucket`, `_count`, `_sum`, `_total`) reads its family's.
    fn resolve(&self, name: &str) -> (Kind, Option<&'a MetricMetadata>) {
        let by_suffix = if SUM_SUFFIXES.iter().any(|suffix| name.ends_with(suffix)) {
            Kind::Sum { monotonic: true }
        } else {
            Kind::Gauge
        };
        if let Some(family) = self.0.get(name).copied() {
            let kind = match family.kind() {
                MetricType::Counter => Kind::Sum { monotonic: true },
                // A summary's own name is its quantile series.
                MetricType::Gauge | MetricType::Summary => Kind::Gauge,
                _ => by_suffix,
            };
            return (kind, Some(family));
        }
        SUM_SUFFIXES
            .iter()
            .find_map(|suffix| {
                let family = self.0.get(name.strip_suffix(suffix)?).copied()?;
                let kind = match (family.kind(), *suffix) {
                    // A summary's sum falls when an observation is negative.
                    (MetricType::Summary, "_sum") => Kind::Sum { monotonic: false },
                    (MetricType::Summary, "_count")
                    | (MetricType::Histogram, "_bucket" | "_count" | "_sum")
                    | (MetricType::Counter, "_total") => by_suffix,
                    (MetricType::GaugeHistogram, "_bucket") => Kind::Gauge,
                    _ => return None,
                };
                Some((kind, Some(family)))
            })
            .unwrap_or((by_suffix, None))
    }
}

#[derive(Default)]
struct RequestBuilder<'a> {
    resources: Vec<ResourceGroup<'a>>,
    /// Each group's (`job`, `instance`), to its index.
    by_resource: HashMap<(Option<&'a str>, Option<&'a str>), usize>,
}

struct ResourceGroup<'a> {
    attributes: Vec<KeyValue>,
    metrics: Vec<PendingMetric>,
    by_name: HashMap<&'a str, usize>,
}

struct PendingMetric {
    name: String,
    description: String,
    unit: String,
    kind: Kind,
    points: Vec<NumberDataPoint>,
}

impl<'a> RequestBuilder<'a> {
    /// The data points of the metric `name` in the series' resource, created on first use.
    fn points(
        &mut self,
        labels: &SeriesLabels<'a>,
        name: &'a str,
        families: &Families<'_>,
    ) -> &mut Vec<NumberDataPoint> {
        let resources = &mut self.resources;
        let group_index = *self
            .by_resource
            .entry((labels.job, labels.instance))
            .or_insert_with(|| {
                let mut attributes = Vec::with_capacity(2);
                if let Some(job) = labels.job {
                    attributes.push(attribute("service.name", job));
                }
                if let Some(instance) = labels.instance {
                    attributes.push(attribute("service.instance.id", instance));
                }
                resources.push(ResourceGroup {
                    attributes,
                    metrics: Vec::new(),
                    by_name: HashMap::new(),
                });
                resources.len() - 1
            });
        let group = &mut self.resources[group_index];
        let metrics = &mut group.metrics;
        let metric_index = *group.by_name.entry(name).or_insert_with(|| {
            let (kind, family) = families.resolve(name);
            metrics.push(PendingMetric {
                name: name.to_owned(),
                description: family.map(|family| family.help.clone()).unwrap_or_default(),
                unit: family.map(|family| family.unit.clone()).unwrap_or_default(),
                kind,
                points: Vec::new(),
            });
            metrics.len() - 1
        });
        &mut group.metrics[metric_index].points
    }

    fn finish(self) -> ExportMetricsServiceRequest {
        ExportMetricsServiceRequest {
            resource_metrics: self
                .resources
                .into_iter()
                .map(|group| ResourceMetrics {
                    resource: Some(Resource {
                        attributes: group.attributes,
                        dropped_attributes_count: 0,
                        entity_refs: Vec::new(),
                    }),
                    scope_metrics: vec![ScopeMetrics {
                        scope: Some(InstrumentationScope {
                            name: SCOPE_NAME.to_owned(),
                            ..InstrumentationScope::default()
                        }),
                        metrics: group
                            .metrics
                            .into_iter()
                            .map(PendingMetric::build)
                            .collect(),
                        schema_url: String::new(),
                    }],
                    schema_url: String::new(),
                })
                .collect(),
        }
    }
}

impl PendingMetric {
    fn build(self) -> Metric {
        Metric {
            name: self.name,
            description: self.description,
            unit: self.unit,
            metadata: Vec::new(),
            data: Some(match self.kind {
                Kind::Gauge => metric::Data::Gauge(Gauge {
                    data_points: self.points,
                }),
                Kind::Sum { monotonic } => metric::Data::Sum(Sum {
                    data_points: self.points,
                    aggregation_temporality: AggregationTemporality::Cumulative.into(),
                    is_monotonic: monotonic,
                }),
            }),
        }
    }
}

fn attribute(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        key_strindex: 0,
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }),
    }
}

/// What [`decode`] costs in memory, estimated from the wire bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeCost {
    /// The most held at once: the decoded request and the OTLP request built from it.
    pub peak: u64,
    /// What the OTLP request alone holds once the decoded request is dropped.
    pub retained: u64,
}

/// Estimates what [`decode`] allocates for `payload`, failing once the peak is
/// past `budget`, before any of it is allocated. Malformed input is left to the decoder
/// to refuse, charged for what the decoder holds before it gets that far.
pub fn decode_cost(payload: &[u8], budget: u64) -> Result<DecodeCost, OverBudget> {
    let request = (size_of::<WriteRequest>() + size_of::<ExportMetricsServiceRequest>()) as u64;
    let mut cost = Cost {
        peak: request,
        retained: request,
        series: 0,
        widest_metadata: 0,
        budget,
    };
    let malformed = match cost.walk_request(payload) {
        Ok(()) => false,
        Err(Stop::Malformed) => true,
        Err(Stop::OverBudget) => return Err(OverBudget),
    };
    // The decoder fails at the same byte, but a length that overruns its own message
    // first makes it copy up to the rest of the payload into a string: a label has two.
    let overrun = if malformed {
        2 * heap_len(payload.len())
    } else {
        0
    };
    // Every metric holds a copy of its family's help and unit.
    let copies = cost.series.saturating_mul(cost.widest_metadata);
    let peak = cost.peak.saturating_add(copies).saturating_add(overrun);
    if peak > budget {
        return Err(OverBudget);
    }
    Ok(DecodeCost {
        peak,
        retained: cost.retained.saturating_add(copies),
    })
}

/// A list's elements, held up to twice as spare capacity and once more while it regrows.
const LIST_GROWTH: u64 = 3;

/// A list's elements once it has stopped growing.
const LIST_CAPACITY: u64 = 2;

/// What a series can leave in the OTLP request besides its data points: a metric
/// and a resource of its own, with the scope name and the resource attribute keys.
const SERIES_RETAINED: u64 = LIST_CAPACITY
    * (size_of::<Metric>() + size_of::<ResourceMetrics>()) as u64
    + (size_of::<ScopeMetrics>() + size_of::<InstrumentationScope>() + 2 * size_of::<KeyValue>())
        as u64
    + 128;

/// What a series adds only while it is mapped: its slot in the decoded request,
/// the builder's metric and resource, and their two index entries.
const SERIES_TRANSIENT: u64 = LIST_GROWTH
    * (size_of::<TimeSeries>() + size_of::<PendingMetric>() + size_of::<ResourceGroup<'_>>())
        as u64
    + (size_of::<Metric>() + size_of::<ResourceMetrics>()) as u64
    + 384;

struct Cost {
    peak: u64,
    retained: u64,
    series: u64,
    /// The largest help and unit text of one family.
    widest_metadata: u64,
    budget: u64,
}

impl Cost {
    /// `retained` bytes that outlive the mapping and `transient` ones that do not.
    fn charge(&mut self, retained: u64, transient: u64) -> Result<(), Stop> {
        self.retained = self.retained.saturating_add(retained);
        self.peak = self.peak.saturating_add(retained).saturating_add(transient);
        if self.peak > self.budget {
            return Err(Stop::OverBudget);
        }
        Ok(())
    }

    fn walk_request(&mut self, mut buf: &[u8]) -> Result<(), Stop> {
        while !buf.is_empty() {
            match field(&mut buf)? {
                (1, Some(series)) => self.series(series)?,
                (3, Some(metadata)) => {
                    // A malformed entry is charged its whole length: the decoder holds no
                    // more of it than that before it fails.
                    let (text, stop) = match text_len(metadata, &[2, 4, 5]) {
                        Ok(text) => (text, None),
                        Err(stop) => (heap_len(metadata.len()), Some(stop)),
                    };
                    self.widest_metadata = self.widest_metadata.max(text);
                    self.charge(0, LIST_GROWTH * size_of::<MetricMetadata>() as u64 + text)?;
                    if let Some(stop) = stop {
                        return Err(stop);
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// One series decoded, and every sample of it as a data point holding its own
    /// copy of the labels. A series that turns malformed partway is still charged for
    /// what it held up to there: the decoder builds that much before it fails.
    fn series(&mut self, mut buf: &[u8]) -> Result<(), Stop> {
        let (mut labels, mut text, mut samples) = (0_u64, 0_u64, 0_u64);
        let mut stop = None;
        while !buf.is_empty() {
            match field(&mut buf) {
                Ok((1, Some(label))) => {
                    labels += 1;
                    match text_len(label, &[1, 2]) {
                        Ok(len) => text = text.saturating_add(len),
                        Err(malformed) => {
                            text = text.saturating_add(heap_len(label.len()));
                            stop = Some(malformed);
                            break;
                        }
                    }
                }
                Ok((2, Some(_))) => samples += 1,
                Ok(_) => {}
                Err(malformed) => {
                    stop = Some(malformed);
                    break;
                }
            }
        }
        let point = size_of::<NumberDataPoint>() as u64;
        let attributes = (labels * size_of::<KeyValue>() as u64).saturating_add(text);
        // The metric name and resource values, and each point with its labels.
        let retained = SERIES_RETAINED.saturating_add(text).saturating_add(
            samples.saturating_mul((LIST_CAPACITY * point).saturating_add(attributes)),
        );
        // The decoded series, the label template, and the point list regrowing.
        let decoded = LIST_GROWTH
            * (labels * size_of::<Label>() as u64 + samples * size_of::<Sample>() as u64);
        let transient = SERIES_TRANSIENT
            .saturating_add(decoded)
            .saturating_add(text)
            .saturating_add(attributes)
            .saturating_add(samples.saturating_mul((LIST_GROWTH - LIST_CAPACITY) * point));
        self.series += 1;
        self.charge(retained, transient)?;
        stop.map_or(Ok(()), Err)
    }
}

/// The next field's tag, and its bytes when it is length-delimited.
fn field<'a>(buf: &mut &'a [u8]) -> Result<(u64, Option<&'a [u8]>), Stop> {
    let key = varint(buf)?;
    let (tag, wire) = (key >> 3, key & 7);
    if tag == 0 {
        return Err(Stop::Malformed);
    }
    match wire {
        WIRE_VARINT => {
            varint(buf)?;
        }
        WIRE_FIXED64 => *buf = buf.get(8..).ok_or(Stop::Malformed)?,
        WIRE_FIXED32 => *buf = buf.get(4..).ok_or(Stop::Malformed)?,
        WIRE_LEN => {
            let len = usize::try_from(varint(buf)?).map_err(|_| Stop::Malformed)?;
            let (body, rest) = buf.split_at_checked(len).ok_or(Stop::Malformed)?;
            *buf = rest;
            return Ok((tag, Some(body)));
        }
        WIRE_START_GROUP => skip_group(tag, buf, 1)?,
        _ => return Err(Stop::Malformed),
    }
    Ok((tag, None))
}

/// Heap bytes behind the string fields `tags` of one message.
fn text_len(mut buf: &[u8], tags: &[u64]) -> Result<u64, Stop> {
    let mut text = 0_u64;
    while !buf.is_empty() {
        if let (tag, Some(body)) = field(&mut buf)? {
            if tags.contains(&tag) {
                text = text.saturating_add(heap_len(body.len()));
            }
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn series(labels: &[(&str, &str)], samples: &[(f64, i64)]) -> TimeSeries {
        TimeSeries {
            labels: labels
                .iter()
                .map(|(name, value)| Label {
                    name: (*name).to_owned(),
                    value: (*value).to_owned(),
                })
                .collect(),
            samples: samples
                .iter()
                .map(|&(value, timestamp)| Sample { value, timestamp })
                .collect(),
            exemplars: Vec::new(),
            histograms: Vec::new(),
        }
    }

    fn family(kind: MetricType, name: &str, help: &str, unit: &str) -> MetricMetadata {
        MetricMetadata {
            kind: kind.into(),
            metric_family_name: name.to_owned(),
            help: help.to_owned(),
            unit: unit.to_owned(),
        }
    }

    fn write(timeseries: Vec<TimeSeries>, metadata: Vec<MetricMetadata>) -> WriteRequest {
        WriteRequest {
            timeseries,
            metadata,
        }
    }

    fn strings(attributes: &[KeyValue]) -> Vec<(&str, &str)> {
        attributes
            .iter()
            .map(|attribute| {
                let Some(AnyValue {
                    value: Some(any_value::Value::StringValue(value)),
                }) = &attribute.value
                else {
                    panic!("{} is not a string attribute", attribute.key);
                };
                (attribute.key.as_str(), value.as_str())
            })
            .collect()
    }

    /// Every metric of the request as (name, kind, values), in request order.
    fn kinds(request: &ExportMetricsServiceRequest) -> Vec<(&str, &'static str, Vec<f64>)> {
        let values = |points: &[NumberDataPoint]| {
            points
                .iter()
                .map(|point| match point.value {
                    Some(number_data_point::Value::AsDouble(value)) => value,
                    _ => panic!("a remote write point is a double"),
                })
                .collect()
        };
        request
            .resource_metrics
            .iter()
            .flat_map(|resource| &resource.scope_metrics)
            .flat_map(|scope| &scope.metrics)
            .map(|metric| match &metric.data {
                Some(metric::Data::Gauge(gauge)) => {
                    (metric.name.as_str(), "gauge", values(&gauge.data_points))
                }
                Some(metric::Data::Sum(sum)) => {
                    assert_eq!(
                        sum.aggregation_temporality,
                        i32::from(AggregationTemporality::Cumulative),
                        "{} is cumulative",
                        metric.name
                    );
                    let kind = if sum.is_monotonic {
                        "monotonic_sum"
                    } else {
                        "sum"
                    };
                    (metric.name.as_str(), kind, values(&sum.data_points))
                }
                other => panic!("{} became {other:?}", metric.name),
            })
            .collect()
    }

    fn kind_of(name: &str, metadata: Vec<MetricMetadata>) -> &'static str {
        let (request, _) = convert(&write(
            vec![series(&[("__name__", name)], &[(1.0, T0)])],
            metadata,
        ));
        kinds(&request)[0].1
    }

    #[test]
    fn a_write_request_round_trips_through_protobuf() {
        let request = write(
            vec![series(
                &[
                    ("__name__", "up"),
                    ("job", "api"),
                    ("instance", "10.0.0.1:9090"),
                ],
                &[(1.0, T0), (0.0, T0 + 15_000)],
            )],
            vec![family(
                MetricType::Gauge,
                "up",
                "Whether the target is up.",
                "",
            )],
        );
        let (decoded, stats) = decode(&request.encode_to_vec()).unwrap();
        assert_eq!(kinds(&decoded), vec![("up", "gauge", vec![1.0, 0.0])]);
        assert_eq!(stats.samples_accepted, 2);
        assert_eq!(
            stats.dropped().iter().map(|(_, count)| count).sum::<u64>(),
            0
        );
    }

    #[test]
    fn truncated_and_foreign_bytes_are_not_a_write_request() {
        let encoded = write(
            vec![series(&[("__name__", "up")], &[(1.0, T0)])],
            Vec::new(),
        )
        .encode_to_vec();
        assert!(decode(&encoded[..encoded.len() - 3]).is_err());
        assert!(decode(b"{\"timeseries\":[]}").is_err());
        // An empty body is an empty request, not an error.
        let (empty, stats) = decode(&[]).unwrap();
        assert!(empty.resource_metrics.is_empty());
        assert_eq!(stats, Stats::default());
    }

    #[test]
    fn the_name_suffix_decides_the_type_without_metadata() {
        for name in [
            "http_requests_total",
            "rpc_duration_seconds_count",
            "rpc_duration_seconds_sum",
            "rpc_duration_seconds_bucket",
        ] {
            assert_eq!(kind_of(name, Vec::new()), "monotonic_sum", "{name}");
        }
        for name in [
            "up",
            "process_resident_memory_bytes",
            "totally",
            "go_gc_duration_seconds",
        ] {
            assert_eq!(kind_of(name, Vec::new()), "gauge", "{name}");
        }
    }

    #[test]
    fn metadata_in_the_request_wins_over_the_suffix() {
        let counter = |name| vec![family(MetricType::Counter, name, "", "")];
        let gauge = |name| vec![family(MetricType::Gauge, name, "", "")];
        // A counter without the suffix, and a gauge with one.
        assert_eq!(
            kind_of("http_requests", counter("http_requests")),
            "monotonic_sum"
        );
        assert_eq!(
            kind_of("queue_items_total", gauge("queue_items_total")),
            "gauge"
        );
        assert_eq!(kind_of("jobs_count", gauge("jobs_count")), "gauge");
        // A counter family named without `_total` describes its `_total` series.
        assert_eq!(
            kind_of("http_requests_total", counter("http_requests")),
            "monotonic_sum"
        );
        // An unknown type says nothing, and another family's metadata is not this series'.
        assert_eq!(
            kind_of(
                "jobs_total",
                vec![family(MetricType::Unknown, "jobs_total", "", "")]
            ),
            "monotonic_sum"
        );
        assert_eq!(kind_of("jobs_total", gauge("jobs")), "monotonic_sum");
        assert_eq!(kind_of("up", counter("down")), "gauge");
    }

    #[test]
    fn histogram_and_summary_components_keep_the_suffix_rule() {
        let histogram = || vec![family(MetricType::Histogram, "rpc_seconds", "", "")];
        for name in ["rpc_seconds_bucket", "rpc_seconds_count", "rpc_seconds_sum"] {
            assert_eq!(kind_of(name, histogram()), "monotonic_sum", "{name}");
        }
        let summary = || vec![family(MetricType::Summary, "gc_seconds", "", "")];
        assert_eq!(kind_of("gc_seconds_count", summary()), "monotonic_sum");
        // The quantile series, and a sum that falls on a negative observation.
        assert_eq!(kind_of("gc_seconds", summary()), "gauge");
        assert_eq!(kind_of("gc_seconds_sum", summary()), "sum");
        // A gauge histogram's series can all fall: its count and sum are `_gcount` and `_gsum`.
        let gauge_histogram = || vec![family(MetricType::GaugeHistogram, "queue_age", "", "")];
        for name in ["queue_age_bucket", "queue_age_gcount", "queue_age_gsum"] {
            assert_eq!(kind_of(name, gauge_histogram()), "gauge", "{name}");
        }
    }

    #[test]
    fn unit_and_description_come_from_the_metadata() {
        let (request, _) = convert(&write(
            vec![
                series(
                    &[("__name__", "rpc_seconds_bucket"), ("le", "0.5")],
                    &[(3.0, T0)],
                ),
                series(&[("__name__", "up")], &[(1.0, T0)]),
            ],
            vec![family(
                MetricType::Histogram,
                "rpc_seconds",
                "RPC latency.",
                "seconds",
            )],
        ));
        let metrics = &request.resource_metrics[0].scope_metrics[0].metrics;
        assert_eq!(
            (metrics[0].description.as_str(), metrics[0].unit.as_str()),
            ("RPC latency.", "seconds")
        );
        assert_eq!(
            (metrics[1].description.as_str(), metrics[1].unit.as_str()),
            ("", "")
        );
    }

    #[test]
    fn job_and_instance_name_the_resource_and_stay_on_the_point() {
        let (request, stats) = convert(&write(
            vec![
                series(
                    &[
                        ("__name__", "http_requests_total"),
                        ("code", "200"),
                        ("instance", "10.0.0.1:9090"),
                        ("job", "api"),
                    ],
                    &[(7.0, T0)],
                ),
                series(
                    &[
                        ("__name__", "up"),
                        ("instance", "10.0.0.1:9090"),
                        ("job", "api"),
                    ],
                    &[(1.0, T0)],
                ),
                series(
                    &[
                        ("__name__", "up"),
                        ("instance", "10.0.0.2:9090"),
                        ("job", "api"),
                    ],
                    &[(1.0, T0)],
                ),
                series(&[("__name__", "up")], &[(1.0, T0)]),
            ],
            Vec::new(),
        ));
        assert_eq!(stats.samples_accepted, 4);
        let resources: Vec<_> = request
            .resource_metrics
            .iter()
            .map(|resource| strings(&resource.resource.as_ref().unwrap().attributes))
            .collect();
        assert_eq!(
            resources,
            vec![
                vec![
                    ("service.name", "api"),
                    ("service.instance.id", "10.0.0.1:9090")
                ],
                vec![
                    ("service.name", "api"),
                    ("service.instance.id", "10.0.0.2:9090")
                ],
                vec![],
            ]
        );
        let first = &request.resource_metrics[0].scope_metrics[0];
        assert_eq!(first.scope.as_ref().unwrap().name, SCOPE_NAME);
        assert_eq!(
            first.metrics.len(),
            2,
            "both series of one target share its resource"
        );
        let Some(metric::Data::Sum(sum)) = &first.metrics[0].data else {
            panic!("http_requests_total is a sum");
        };
        let point = &sum.data_points[0];
        assert_eq!(
            strings(&point.attributes),
            vec![
                ("code", "200"),
                ("instance", "10.0.0.1:9090"),
                ("job", "api")
            ],
            "every label but __name__, under its own name"
        );
        assert_eq!(
            (
                point.start_time_unix_nano,
                point.time_unix_nano,
                point.flags
            ),
            (0, 1_700_000_000_000_000_000, 0)
        );
    }

    #[test]
    fn samples_of_one_metric_across_series_share_a_metric() {
        let (request, _) = convert(&write(
            vec![
                series(
                    &[("__name__", "rpc_seconds_bucket"), ("le", "0.5")],
                    &[(3.0, T0)],
                ),
                series(
                    &[("__name__", "rpc_seconds_bucket"), ("le", "+Inf")],
                    &[(5.0, T0)],
                ),
            ],
            Vec::new(),
        ));
        assert_eq!(
            kinds(&request),
            vec![("rpc_seconds_bucket", "monotonic_sum", vec![3.0, 5.0])]
        );
        let Some(metric::Data::Sum(sum)) =
            &request.resource_metrics[0].scope_metrics[0].metrics[0].data
        else {
            panic!("a bucket series is a sum");
        };
        let le: Vec<_> = sum
            .data_points
            .iter()
            .map(|point| strings(&point.attributes))
            .collect();
        assert_eq!(le, vec![vec![("le", "0.5")], vec![("le", "+Inf")]]);
    }

    #[test]
    fn stale_markers_and_non_finite_values_are_dropped_and_counted() {
        let stale = f64::from_bits(STALE_NAN_BITS);
        let (request, stats) = convert(&write(
            vec![
                series(
                    &[("__name__", "up"), ("job", "api")],
                    &[(1.0, T0), (stale, T0 + 15_000)],
                ),
                // Only a stale marker: the series leaves no metric and no resource.
                series(&[("__name__", "gone"), ("job", "old")], &[(stale, T0)]),
                series(
                    &[("__name__", "ratio"), ("job", "api")],
                    &[
                        (f64::NAN, T0),
                        (f64::INFINITY, T0),
                        (f64::NEG_INFINITY, T0),
                        (0.5, T0),
                    ],
                ),
                series(&[("__name__", "ancient"), ("job", "api")], &[(1.0, -1)]),
            ],
            Vec::new(),
        ));
        assert_eq!(
            kinds(&request),
            vec![("up", "gauge", vec![1.0]), ("ratio", "gauge", vec![0.5])]
        );
        assert_eq!(request.resource_metrics.len(), 1);
        assert_eq!(
            stats,
            Stats {
                samples_accepted: 2,
                stale: 2,
                non_finite: 3,
                invalid_timestamp: 1,
                ..Stats::default()
            }
        );
    }

    #[test]
    fn a_series_without_a_name_is_dropped_and_counted() {
        let (request, stats) = convert(&write(
            vec![
                series(&[("job", "api")], &[(1.0, T0), (2.0, T0 + 1)]),
                series(&[("__name__", ""), ("job", "api")], &[(1.0, T0)]),
                series(
                    &[("__name__", "up"), ("job", "api"), ("zone", "")],
                    &[(1.0, T0)],
                ),
            ],
            Vec::new(),
        ));
        assert_eq!(kinds(&request), vec![("up", "gauge", vec![1.0])]);
        assert_eq!((stats.samples_accepted, stats.missing_name), (1, 3));
        let Some(metric::Data::Gauge(gauge)) =
            &request.resource_metrics[0].scope_metrics[0].metrics[0].data
        else {
            panic!("up is a gauge");
        };
        assert_eq!(
            strings(&gauge.data_points[0].attributes),
            vec![("job", "api")],
            "an empty label value is an absent label"
        );
    }

    #[test]
    fn exemplars_and_native_histograms_are_counted_and_skipped() {
        // An exemplar with a value and a timestamp, and a native histogram with a count.
        let exemplar = [0x11, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f, 0x18, 0x01];
        let histogram = [0x08, 0x05];
        let mut encoded_series =
            series(&[("__name__", "rpc_seconds")], &[(1.0, T0)]).encode_to_vec();
        for (tag, body) in [
            (0x1a, &exemplar[..]),
            (0x1a, &exemplar[..]),
            (0x22, &histogram[..]),
        ] {
            encoded_series.push(tag);
            encoded_series.push(u8::try_from(body.len()).unwrap());
            encoded_series.extend_from_slice(body);
        }
        let mut payload = vec![0x0a, u8::try_from(encoded_series.len()).unwrap()];
        payload.extend(encoded_series);

        let (request, stats) = decode(&payload).unwrap();
        assert_eq!(kinds(&request), vec![("rpc_seconds", "gauge", vec![1.0])]);
        assert_eq!(
            (
                stats.samples_accepted,
                stats.exemplars,
                stats.native_histograms
            ),
            (1, 2, 1)
        );
        assert_eq!(
            stats.dropped(),
            [
                ("missing_name", 0),
                ("stale", 0),
                ("non_finite", 0),
                ("invalid_timestamp", 0),
                ("native_histogram", 1),
                ("exemplar", 2),
            ]
        );
    }

    #[test]
    fn only_the_version_2_content_type_is_version_2() {
        assert!(is_v2_content_type(
            "application/x-protobuf;proto=io.prometheus.write.v2.Request"
        ));
        assert!(is_v2_content_type(
            "application/x-protobuf; proto=io.prometheus.write.v2.request"
        ));
        // A parameter value may be a quoted string, and other parameters may sit beside it.
        assert!(is_v2_content_type(
            "application/x-protobuf;proto=\"io.prometheus.write.v2.Request\""
        ));
        assert!(is_v2_content_type(
            "application/x-protobuf; charset=utf-8; PROTO = \"io.prometheus.write.v2.Request\""
        ));
        assert!(!is_v2_content_type(
            "application/x-protobuf;proto=\"prometheus.WriteRequest\""
        ));
        assert!(!is_v2_content_type("io.prometheus.write.v2.Request"));
        assert!(!is_v2_content_type("application/x-protobuf"));
        assert!(!is_v2_content_type(
            "application/x-protobuf;proto=prometheus.WriteRequest"
        ));
    }

    #[test]
    fn the_estimate_grows_with_what_a_sample_expands_into() {
        let one = write(
            vec![series(&[("__name__", "up"), ("job", "api")], &[(1.0, T0)])],
            Vec::new(),
        )
        .encode_to_vec();
        let base = decode_cost(&one, u64::MAX).unwrap();
        // 10,000 samples of one series are 10,000 copies of its labels.
        let samples: Vec<_> = (0..10_000).map(|i| (1.0, T0 + i)).collect();
        let many = write(
            vec![series(&[("__name__", "up"), ("job", "api")], &samples)],
            Vec::new(),
        )
        .encode_to_vec();
        let wide = decode_cost(&many, u64::MAX).unwrap();
        let points = 10_000 * size_of::<NumberDataPoint>() as u64;
        assert!(wide.retained > base.retained + points);
        assert!(wide.peak > wide.retained);
        assert_eq!(decode_cost(&many, wide.peak), Ok(wide));
        assert_eq!(decode_cost(&many, wide.peak - 1), Err(OverBudget));
        // Malformed input is costed up to where it breaks and left to the decoder.
        assert!(decode_cost(&many[..many.len() / 2], u64::MAX).is_ok());
    }
}
