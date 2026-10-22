//! CloudWatch Metric Streams (OpenTelemetry 1.0 output, delivered by Amazon
//! Data Firehose's HTTP endpoint destination) to an OTLP metrics request Maple
//! stores.
//!
//! CloudWatch sends every metric as a Summary, which the native encoder drops,
//! so each summary point is expanded into gauges and delta sums.

use std::collections::HashMap;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::metrics::v1::{
    metric, number_data_point, AggregationTemporality, Gauge, Metric, NumberDataPoint,
    ResourceMetrics, ScopeMetrics, Sum, SummaryDataPoint,
};
use opentelemetry_proto::tonic::resource::v1::Resource;
use prost::Message;
use serde::Deserialize;

pub const INGEST_SOURCE: &str = "aws-metric-stream";

const SCOPE_NAME: &str = "aws.cloudwatch.metric_stream";

// What a connection's `stream_last_error` holds. The customer reads it on the
// connection: one sentence of cause, one of what to do.

/// A delivery that is not a Firehose request of OpenTelemetry 1.0 records.
pub const UNREADABLE_DELIVERY: &str = "Maple could not read a metric stream delivery. Check \
    that the stream's output format is OpenTelemetry 1.0. Metrics sent meanwhile are lost.";

/// A delivery over the decoded size Maple accepts.
pub const DELIVERY_TOO_LARGE: &str = "A metric stream delivery was larger than Maple accepts. \
    Lower the Firehose stream's buffer size. Metrics sent meanwhile are lost.";

/// A delivery Maple accepted but could not hand to the pipeline.
pub const DELIVERY_NOT_STORED: &str = "Maple could not store a delivery just now. Firehose \
    retries it. Nothing to do.";

/// A delivery refused because the organization is over its plan limit.
pub const OVER_PLAN_LIMIT: &str = "This Maple organization is over its plan limit, so Maple \
    refuses new metrics. Firehose retries for a while. See Settings, Billing.";

/// The connection a delivery arrived on, stamped on every resource.
#[derive(Clone, Copy, Debug)]
pub struct Connection<'a> {
    pub id: &'a str,
    pub org_id: &'a str,
    /// The integration source's public `src_` id.
    pub source_id: Option<&'a str>,
}

/// The body Firehose's HTTP endpoint destination posts.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub request_id: Option<String>,
    records: Vec<DeliveryRecord>,
}

#[derive(Debug, Deserialize)]
struct DeliveryRecord {
    /// Base64 of one or more length-delimited `ExportMetricsServiceRequest`s.
    data: String,
}

/// Why a delivery's records could not be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordError {
    Unreadable,
    /// The records decode to more than the allowed bytes.
    TooLarge,
}

/// `None` when the body is not a Firehose request.
pub fn parse_delivery(payload: &[u8]) -> Option<Delivery> {
    serde_json::from_slice(payload).ok()
}

impl Delivery {
    /// Every request in the records, in order. Fails once the base64-decoded
    /// records add up to more than `max_decoded` bytes.
    pub fn metric_requests(
        &self,
        max_decoded: usize,
    ) -> Result<Vec<ExportMetricsServiceRequest>, RecordError> {
        let mut decoded_total = 0_usize;
        let mut requests = Vec::new();
        for record in &self.records {
            let bytes = STANDARD
                .decode(record.data.as_bytes())
                .map_err(|_| RecordError::Unreadable)?;
            decoded_total = decoded_total.saturating_add(bytes.len());
            if decoded_total > max_decoded {
                return Err(RecordError::TooLarge);
            }
            let mut buffer = bytes.as_slice();
            while !buffer.is_empty() {
                let mut request = ExportMetricsServiceRequest::decode_length_delimited(&mut buffer)
                    .map_err(|_| RecordError::Unreadable)?;
                // Empty messages decode from a byte or two each but cost far more in memory:
                // keep only what carries metrics, so a run of zero bytes allocates nothing.
                request
                    .resource_metrics
                    .retain(|resource| !resource.scope_metrics.is_empty());
                if !request.resource_metrics.is_empty() {
                    requests.push(request);
                }
            }
        }
        Ok(requests)
    }
}

/// `aws.` + namespace + `.` + metric name, each snake_cased:
/// (`AWS/ECS`, `CPUUtilization`) is `aws.ecs.cpu_utilization`.
pub fn metric_base_name(namespace: &str, metric_name: &str) -> String {
    format!(
        "aws.{}.{}",
        normalize_namespace(namespace),
        snake_case(metric_name)
    )
}

/// `AWS/ECS` is `ecs`, `ECS/ContainerInsights` is `ecs.container_insights`.
pub fn normalize_namespace(namespace: &str) -> String {
    let namespace = namespace.strip_prefix("AWS/").unwrap_or(namespace);
    namespace
        .split('/')
        .map(snake_case)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(".")
}

/// `CPUUtilization` is `cpu_utilization`. A digit does not start a new word, so
/// `HTTPCode_Target_5XX_Count` is `http_code_target_5xx_count`.
pub fn snake_case(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut spaced = String::with_capacity(name.len() + 4);
    for (index, &current) in chars.iter().enumerate() {
        if current.is_ascii_uppercase() && index > 0 {
            let previous = chars[index - 1];
            let next_is_lower = chars.get(index + 1).is_some_and(char::is_ascii_lowercase);
            if previous.is_ascii_lowercase() || (previous.is_ascii_uppercase() && next_is_lower) {
                spaced.push('_');
            }
        }
        spaced.push(current.to_ascii_lowercase());
    }

    let mut snake = String::with_capacity(spaced.len());
    for current in spaced.chars() {
        let current = if current.is_ascii_lowercase() || current.is_ascii_digit() {
            current
        } else {
            '_'
        };
        if current == '_' && (snake.is_empty() || snake.ends_with('_')) {
            continue;
        }
        snake.push(current);
    }
    while snake.ends_with('_') {
        snake.pop();
    }
    snake
}

/// Dimensions naming the resource a metric is about, most specific first. The
/// first one present becomes `service.name`.
const SERVICE_DIMENSIONS: &[&str] = &[
    "ServiceName",
    "FunctionName",
    "DBInstanceIdentifier",
    "DBClusterIdentifier",
    "LoadBalancer",
    "QueueName",
    "InstanceId",
];

/// One CloudWatch metric's identity, read off a summary point.
#[derive(Debug)]
struct CloudWatchMetric {
    namespace: String,
    metric_name: String,
    dimensions: Vec<(String, String)>,
}

impl CloudWatchMetric {
    /// From the point's `Namespace`, `MetricName` and `Dimensions` attributes,
    /// falling back to the `amazonaws.com/<Namespace>/<MetricName>` metric name.
    fn of(metric: &Metric, point: &SummaryDataPoint) -> Option<Self> {
        let mut namespace = None;
        let mut metric_name = None;
        let mut dimensions = Vec::new();
        for attribute in &point.attributes {
            match (attribute.key.as_str(), any(attribute)) {
                ("Namespace", Some(any_value::Value::StringValue(value))) => {
                    namespace = Some(value.clone());
                }
                ("MetricName", Some(any_value::Value::StringValue(value))) => {
                    metric_name = Some(value.clone());
                }
                ("Dimensions", Some(any_value::Value::KvlistValue(list))) => {
                    dimensions.extend(list.values.iter().filter_map(|dimension| {
                        match any(dimension)? {
                            any_value::Value::StringValue(value) => {
                                Some((dimension.key.clone(), value.clone()))
                            }
                            _ => None,
                        }
                    }));
                }
                _ => {}
            }
        }
        let from_name = metric
            .name
            .strip_prefix("amazonaws.com/")
            .and_then(|rest| rest.rsplit_once('/'));
        let namespace = namespace.or_else(|| from_name.map(|(ns, _)| ns.to_owned()))?;
        let metric_name = metric_name.or_else(|| from_name.map(|(_, name)| name.to_owned()))?;
        if namespace.is_empty() || metric_name.is_empty() {
            return None;
        }
        Some(Self {
            namespace,
            metric_name,
            dimensions,
        })
    }

    fn dimension(&self, name: &str) -> Option<&str> {
        self.dimensions
            .iter()
            .find(|(key, value)| key == name && !value.is_empty())
            .map(|(_, value)| value.as_str())
    }

    fn service_name(&self) -> String {
        SERVICE_DIMENSIONS
            .iter()
            .find_map(|name| self.dimension(name))
            .map_or_else(
                || format!("aws/{}", normalize_namespace(&self.namespace)),
                str::to_owned,
            )
    }

    fn cloud_platform(&self) -> Option<&'static str> {
        match self.namespace.as_str() {
            "AWS/ECS" | "ECS/ContainerInsights" => Some("aws_ecs"),
            "AWS/Lambda" => Some("aws_lambda"),
            "AWS/EC2" => Some("aws_ec2"),
            _ => None,
        }
    }

    fn point_attributes(&self) -> Vec<KeyValue> {
        let mut attributes: Vec<KeyValue> = self
            .dimensions
            .iter()
            .map(|(name, value)| attribute(&format!("aws.dimension.{}", snake_case(name)), value))
            .collect();
        attributes.push(attribute("aws.namespace", &self.namespace));
        attributes.push(attribute("aws.metric_name", &self.metric_name));
        attributes
    }

    /// The stream's own resource attributes (`cloud.*`, `aws.exporter.arn`)
    /// with Maple's stamped over them, sorted by key.
    fn resource_attributes(
        &self,
        incoming: &[KeyValue],
        connection: &Connection<'_>,
    ) -> Vec<KeyValue> {
        let mut attributes: Vec<KeyValue> = incoming
            .iter()
            .filter(|attribute| {
                !attribute.key.starts_with("maple_")
                    && !matches!(
                        attribute.key.as_str(),
                        "org_id" | "service.name" | "cloud.platform"
                    )
            })
            .cloned()
            .collect();
        attributes.push(attribute("service.name", &self.service_name()));
        if let Some(platform) = self.cloud_platform() {
            attributes.push(attribute("cloud.platform", platform));
        }
        attributes.push(attribute("maple_org_id", connection.org_id));
        attributes.push(attribute("maple_ingest_source", INGEST_SOURCE));
        attributes.push(attribute("maple_ingest_key_type", "connector"));
        attributes.push(attribute("maple_aws_connection_id", connection.id));
        if let Some(source_id) = connection.source_id {
            attributes.push(attribute("maple_source_id", source_id));
        }
        attributes.sort_by(|a, b| a.key.cmp(&b.key));
        attributes
    }
}

/// The metrics Maple stores for a delivery's summary points: per point a
/// `<base>` average gauge (when it has samples), `<base>.min` and `<base>.max`
/// gauges, and `<base>.sum` / `<base>.count` delta sums. Other metric types
/// are not part of the format and are skipped.
pub fn build_metrics_request(
    requests: &[ExportMetricsServiceRequest],
    connection: &Connection<'_>,
) -> ExportMetricsServiceRequest {
    let mut builder = RequestBuilder::default();
    for resource_metrics in requests
        .iter()
        .flat_map(|request| &request.resource_metrics)
    {
        let incoming = resource_metrics
            .resource
            .as_ref()
            .map_or(&[][..], |resource| resource.attributes.as_slice());
        for metric in resource_metrics
            .scope_metrics
            .iter()
            .flat_map(|scope| &scope.metrics)
        {
            let Some(metric::Data::Summary(summary)) = &metric.data else {
                continue;
            };
            for point in &summary.data_points {
                builder.add_point(incoming, metric, point, connection);
            }
        }
    }
    builder.finish()
}

#[derive(Default)]
struct RequestBuilder {
    resources: Vec<ResourceGroup>,
    /// The encoded resource attributes of each group, to its index.
    by_resource: HashMap<Vec<u8>, usize>,
}

struct ResourceGroup {
    attributes: Vec<KeyValue>,
    metrics: Vec<Metric>,
    by_name: HashMap<String, usize>,
}

#[derive(Clone, Copy)]
enum Kind {
    Gauge,
    DeltaSum { monotonic: bool },
}

impl RequestBuilder {
    fn add_point(
        &mut self,
        incoming: &[KeyValue],
        metric: &Metric,
        point: &SummaryDataPoint,
        connection: &Connection<'_>,
    ) {
        let Some(cloudwatch) = CloudWatchMetric::of(metric, point) else {
            return;
        };
        let group = self.group(cloudwatch.resource_attributes(incoming, connection));
        let base = metric_base_name(&cloudwatch.namespace, &cloudwatch.metric_name);
        let attributes = cloudwatch.point_attributes();
        let number = |value: number_data_point::Value| NumberDataPoint {
            attributes: attributes.clone(),
            start_time_unix_nano: point.start_time_unix_nano,
            time_unix_nano: point.time_unix_nano,
            value: Some(value),
            exemplars: Vec::new(),
            flags: point.flags,
        };
        let double = |value: f64| number(number_data_point::Value::AsDouble(value));
        let unit = metric.unit.as_str();

        if point.count > 0 {
            #[expect(
                clippy::cast_precision_loss,
                reason = "a sample count past 2^53 averages the same within f64 precision"
            )]
            let average = point.sum / point.count as f64;
            group.push(base.clone(), unit, Kind::Gauge, double(average));
        }
        if let Some(min) = quantile(point, 0.0) {
            group.push(format!("{base}.min"), unit, Kind::Gauge, double(min));
        }
        if let Some(max) = quantile(point, 1.0) {
            group.push(format!("{base}.max"), unit, Kind::Gauge, double(max));
        }
        group.push(
            format!("{base}.sum"),
            unit,
            Kind::DeltaSum { monotonic: false },
            double(point.sum),
        );
        // A count of samples, whatever the metric measures.
        let count = i64::try_from(point.count).unwrap_or(i64::MAX);
        group.push(
            format!("{base}.count"),
            "1",
            Kind::DeltaSum { monotonic: true },
            number(number_data_point::Value::AsInt(count)),
        );
    }

    fn group(&mut self, attributes: Vec<KeyValue>) -> &mut ResourceGroup {
        let key = Resource {
            attributes: attributes.clone(),
            ..Default::default()
        }
        .encode_to_vec();
        let index = *self.by_resource.entry(key).or_insert_with(|| {
            self.resources.push(ResourceGroup {
                attributes,
                metrics: Vec::new(),
                by_name: HashMap::new(),
            });
            self.resources.len() - 1
        });
        &mut self.resources[index]
    }

    fn finish(self) -> ExportMetricsServiceRequest {
        ExportMetricsServiceRequest {
            resource_metrics: self
                .resources
                .into_iter()
                .map(|group| ResourceMetrics {
                    resource: Some(Resource {
                        attributes: group.attributes,
                        ..Default::default()
                    }),
                    scope_metrics: vec![ScopeMetrics {
                        scope: Some(InstrumentationScope {
                            name: SCOPE_NAME.to_owned(),
                            ..Default::default()
                        }),
                        metrics: group.metrics,
                        schema_url: String::new(),
                    }],
                    schema_url: String::new(),
                })
                .collect(),
        }
    }
}

impl ResourceGroup {
    fn push(&mut self, name: String, unit: &str, kind: Kind, point: NumberDataPoint) {
        if let Some(&index) = self.by_name.get(&name) {
            match &mut self.metrics[index].data {
                Some(metric::Data::Gauge(gauge)) => gauge.data_points.push(point),
                Some(metric::Data::Sum(sum)) => sum.data_points.push(point),
                _ => {}
            }
            return;
        }
        let data = match kind {
            Kind::Gauge => metric::Data::Gauge(Gauge {
                data_points: vec![point],
            }),
            Kind::DeltaSum { monotonic } => metric::Data::Sum(Sum {
                data_points: vec![point],
                aggregation_temporality: AggregationTemporality::Delta as i32,
                is_monotonic: monotonic,
            }),
        };
        self.by_name.insert(name.clone(), self.metrics.len());
        self.metrics.push(Metric {
            name,
            unit: unit.to_owned(),
            data: Some(data),
            ..Default::default()
        });
    }
}

fn quantile(point: &SummaryDataPoint, quantile: f64) -> Option<f64> {
    point
        .quantile_values
        .iter()
        .find(|value| (value.quantile - quantile).abs() < f64::EPSILON)
        .map(|value| value.value)
}

fn any(attribute: &KeyValue) -> Option<&any_value::Value> {
    attribute.value.as_ref()?.value.as_ref()
}

fn attribute(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::common::v1::KeyValueList;
    use opentelemetry_proto::tonic::metrics::v1::summary_data_point::ValueAtQuantile;
    use opentelemetry_proto::tonic::metrics::v1::Summary;

    const CONNECTION: Connection<'static> = Connection {
        id: "6f1c2b9e-1d3a-4c5b-9e8f-0a1b2c3d4e5f",
        org_id: "org_1",
        source_id: Some("src_aws"),
    };
    const START: u64 = 1_800_000_000_000_000_000;
    const END: u64 = 1_800_000_060_000_000_000;

    fn string(value: &str) -> AnyValue {
        AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }
    }

    fn kv(key: &str, value: &str) -> KeyValue {
        KeyValue {
            key: key.to_owned(),
            value: Some(string(value)),
            ..Default::default()
        }
    }

    /// A point as CloudWatch writes it: count, sum, min at 0.0 and max at 1.0.
    fn point(
        dimensions: &[(&str, &str)],
        count: u64,
        sum: f64,
        min: f64,
        max: f64,
    ) -> SummaryDataPoint {
        point_in(
            "AWS/ECS",
            "CPUUtilization",
            dimensions,
            count,
            sum,
            min,
            max,
        )
    }

    fn point_in(
        namespace: &str,
        metric_name: &str,
        dimensions: &[(&str, &str)],
        count: u64,
        sum: f64,
        min: f64,
        max: f64,
    ) -> SummaryDataPoint {
        SummaryDataPoint {
            attributes: vec![
                kv("Namespace", namespace),
                kv("MetricName", metric_name),
                KeyValue {
                    key: "Dimensions".to_owned(),
                    value: Some(AnyValue {
                        value: Some(any_value::Value::KvlistValue(KeyValueList {
                            values: dimensions.iter().map(|(k, v)| kv(k, v)).collect(),
                        })),
                    }),
                    ..Default::default()
                },
            ],
            start_time_unix_nano: START,
            time_unix_nano: END,
            count,
            sum,
            quantile_values: vec![
                ValueAtQuantile {
                    quantile: 0.0,
                    value: min,
                },
                ValueAtQuantile {
                    quantile: 0.99,
                    value: max,
                },
                ValueAtQuantile {
                    quantile: 1.0,
                    value: max,
                },
            ],
            flags: 0,
        }
    }

    fn stream_request(
        metrics: Vec<(&str, &str, Vec<SummaryDataPoint>)>,
    ) -> ExportMetricsServiceRequest {
        ExportMetricsServiceRequest {
            resource_metrics: vec![ResourceMetrics {
                resource: Some(Resource {
                    attributes: vec![
                        kv("cloud.provider", "aws"),
                        kv("cloud.account.id", "123456789012"),
                        kv("cloud.region", "us-east-1"),
                        kv(
                            "aws.exporter.arn",
                            "arn:aws:cloudwatch:us-east-1:123456789012:metric-stream/maple",
                        ),
                        kv("maple_org_id", "org_forged"),
                        kv("org_id", "org_forged"),
                    ],
                    ..Default::default()
                }),
                scope_metrics: vec![ScopeMetrics {
                    scope: None,
                    metrics: metrics
                        .into_iter()
                        .map(|(name, unit, points)| Metric {
                            name: name.to_owned(),
                            unit: unit.to_owned(),
                            data: Some(metric::Data::Summary(Summary {
                                data_points: points,
                            })),
                            ..Default::default()
                        })
                        .collect(),
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        }
    }

    fn string_attr<'a>(attributes: &'a [KeyValue], key: &str) -> Option<&'a str> {
        attributes
            .iter()
            .find(|attribute| attribute.key == key)
            .and_then(|attribute| match any(attribute)? {
                any_value::Value::StringValue(value) => Some(value.as_str()),
                _ => None,
            })
    }

    fn resource_attrs(resource: &ResourceMetrics) -> &[KeyValue] {
        &resource.resource.as_ref().unwrap().attributes
    }

    fn metrics(resource: &ResourceMetrics) -> &[Metric] {
        &resource.scope_metrics[0].metrics
    }

    fn find<'a>(resource: &'a ResourceMetrics, name: &str) -> &'a Metric {
        metrics(resource)
            .iter()
            .find(|metric| metric.name == name)
            .unwrap_or_else(|| panic!("no metric {name}"))
    }

    fn value(point: &NumberDataPoint) -> f64 {
        match point.value {
            Some(number_data_point::Value::AsDouble(value)) => value,
            #[expect(clippy::cast_precision_loss, reason = "small test counts")]
            Some(number_data_point::Value::AsInt(value)) => value as f64,
            None => f64::NAN,
        }
    }

    fn gauge_value(metric: &Metric) -> f64 {
        match &metric.data {
            Some(metric::Data::Gauge(gauge)) => value(&gauge.data_points[0]),
            other => panic!("{} is not a gauge: {other:?}", metric.name),
        }
    }

    #[test]
    fn snake_cases_cloudwatch_metric_names() {
        for (name, expected) in [
            ("CPUUtilization", "cpu_utilization"),
            ("HTTPCode_Target_5XX_Count", "http_code_target_5xx_count"),
            ("RequestCount", "request_count"),
            (
                "ApproximateAgeOfOldestMessage",
                "approximate_age_of_oldest_message",
            ),
            ("MemoryUtilized", "memory_utilized"),
            ("4XXError", "4xx_error"),
            ("Already_snake__case_", "already_snake_case"),
        ] {
            assert_eq!(snake_case(name), expected, "{name}");
        }
    }

    #[test]
    fn normalizes_namespaces() {
        for (namespace, expected) in [
            ("AWS/ECS", "ecs"),
            ("ECS/ContainerInsights", "ecs.container_insights"),
            ("AWS/ApplicationELB", "application_elb"),
            ("AWS/Lambda", "lambda"),
            ("Custom/MyApp", "custom.my_app"),
        ] {
            assert_eq!(normalize_namespace(namespace), expected, "{namespace}");
        }
        assert_eq!(
            metric_base_name("AWS/ApplicationELB", "HTTPCode_Target_5XX_Count"),
            "aws.application_elb.http_code_target_5xx_count"
        );
    }

    #[test]
    fn expands_a_summary_point_into_gauges_and_delta_sums() {
        let request = stream_request(vec![(
            "amazonaws.com/AWS/ECS/CPUUtilization",
            "Percent",
            vec![point(
                &[("ClusterName", "prod"), ("ServiceName", "checkout")],
                4,
                100.0,
                10.0,
                40.0,
            )],
        )]);
        let built = build_metrics_request(&[request], &CONNECTION);
        assert_eq!(built.resource_metrics.len(), 1);
        let resource = &built.resource_metrics[0];
        let names: Vec<&str> = metrics(resource).iter().map(|m| m.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "aws.ecs.cpu_utilization",
                "aws.ecs.cpu_utilization.min",
                "aws.ecs.cpu_utilization.max",
                "aws.ecs.cpu_utilization.sum",
                "aws.ecs.cpu_utilization.count",
            ]
        );
        assert!((gauge_value(find(resource, "aws.ecs.cpu_utilization")) - 25.0).abs() < 1e-9);
        assert!((gauge_value(find(resource, "aws.ecs.cpu_utilization.min")) - 10.0).abs() < 1e-9);
        assert!((gauge_value(find(resource, "aws.ecs.cpu_utilization.max")) - 40.0).abs() < 1e-9);

        for (name, expected, monotonic) in [
            ("aws.ecs.cpu_utilization.sum", 100.0, false),
            ("aws.ecs.cpu_utilization.count", 4.0, true),
        ] {
            let Some(metric::Data::Sum(sum)) = &find(resource, name).data else {
                panic!("{name} is not a sum");
            };
            assert_eq!(
                sum.aggregation_temporality,
                AggregationTemporality::Delta as i32,
                "{name}"
            );
            assert_eq!(sum.is_monotonic, monotonic, "{name}");
            assert!(
                (value(&sum.data_points[0]) - expected).abs() < 1e-9,
                "{name}"
            );
            assert_eq!(sum.data_points[0].start_time_unix_nano, START);
            assert_eq!(sum.data_points[0].time_unix_nano, END);
        }
        assert_eq!(find(resource, "aws.ecs.cpu_utilization").unit, "Percent");
        assert_eq!(
            find(resource, "aws.ecs.cpu_utilization.sum").unit,
            "Percent"
        );
    }

    #[test]
    fn a_point_without_samples_has_no_average() {
        let request = stream_request(vec![(
            "amazonaws.com/AWS/SQS/NumberOfMessagesSent",
            "Count",
            vec![point_in(
                "AWS/SQS",
                "NumberOfMessagesSent",
                &[("QueueName", "jobs")],
                0,
                0.0,
                0.0,
                0.0,
            )],
        )]);
        let built = build_metrics_request(&[request], &CONNECTION);
        let resource = &built.resource_metrics[0];
        assert!(metrics(resource)
            .iter()
            .all(|metric| metric.name != "aws.sqs.number_of_messages_sent"));
        assert_eq!(metrics(resource).len(), 4);
    }

    #[test]
    fn stamps_dimensions_on_points_and_maple_attributes_on_the_resource() {
        let request = stream_request(vec![(
            "amazonaws.com/AWS/ECS/CPUUtilization",
            "Percent",
            vec![point(
                &[("ClusterName", "prod"), ("ServiceName", "checkout")],
                1,
                5.0,
                5.0,
                5.0,
            )],
        )]);
        let built = build_metrics_request(&[request], &CONNECTION);
        let resource = &built.resource_metrics[0];
        let Some(metric::Data::Gauge(gauge)) = &find(resource, "aws.ecs.cpu_utilization").data
        else {
            panic!("not a gauge");
        };
        let point_attrs = &gauge.data_points[0].attributes;
        assert_eq!(
            string_attr(point_attrs, "aws.dimension.cluster_name"),
            Some("prod")
        );
        assert_eq!(
            string_attr(point_attrs, "aws.dimension.service_name"),
            Some("checkout")
        );
        assert_eq!(string_attr(point_attrs, "aws.namespace"), Some("AWS/ECS"));
        assert_eq!(
            string_attr(point_attrs, "aws.metric_name"),
            Some("CPUUtilization")
        );

        let attrs = resource_attrs(resource);
        assert_eq!(string_attr(attrs, "service.name"), Some("checkout"));
        assert_eq!(string_attr(attrs, "cloud.platform"), Some("aws_ecs"));
        assert_eq!(string_attr(attrs, "cloud.provider"), Some("aws"));
        assert_eq!(string_attr(attrs, "cloud.account.id"), Some("123456789012"));
        assert_eq!(string_attr(attrs, "cloud.region"), Some("us-east-1"));
        assert!(string_attr(attrs, "aws.exporter.arn").is_some());
        assert_eq!(string_attr(attrs, "maple_org_id"), Some("org_1"));
        assert_eq!(
            string_attr(attrs, "maple_ingest_source"),
            Some(INGEST_SOURCE)
        );
        assert_eq!(
            string_attr(attrs, "maple_ingest_key_type"),
            Some("connector")
        );
        assert_eq!(
            string_attr(attrs, "maple_aws_connection_id"),
            Some(CONNECTION.id)
        );
        assert_eq!(string_attr(attrs, "maple_source_id"), Some("src_aws"));
        assert!(string_attr(attrs, "org_id").is_none());
        assert_eq!(
            attrs.iter().filter(|kv| kv.key == "maple_org_id").count(),
            1
        );
    }

    #[test]
    fn derives_service_name_and_platform_from_dimensions() {
        for (namespace, dimensions, service, platform) in [
            (
                "AWS/Lambda",
                vec![("FunctionName", "resize")],
                "resize",
                Some("aws_lambda"),
            ),
            (
                "AWS/RDS",
                vec![
                    ("DBInstanceIdentifier", "db-1"),
                    ("DBClusterIdentifier", "c"),
                ],
                "db-1",
                None,
            ),
            (
                "AWS/RDS",
                vec![("DBClusterIdentifier", "cluster-1")],
                "cluster-1",
                None,
            ),
            (
                "AWS/ApplicationELB",
                vec![("LoadBalancer", "app/web/50dc")],
                "app/web/50dc",
                None,
            ),
            ("AWS/SQS", vec![("QueueName", "jobs")], "jobs", None),
            (
                "AWS/EC2",
                vec![("InstanceId", "i-0abc")],
                "i-0abc",
                Some("aws_ec2"),
            ),
            (
                "ECS/ContainerInsights",
                vec![("ClusterName", "prod")],
                "aws/ecs.container_insights",
                Some("aws_ecs"),
            ),
            ("AWS/EBS", vec![("VolumeId", "vol-1")], "aws/ebs", None),
        ] {
            let request = stream_request(vec![(
                "ignored",
                "None",
                vec![point_in(namespace, "Metric", &dimensions, 1, 1.0, 1.0, 1.0)],
            )]);
            let built = build_metrics_request(&[request], &CONNECTION);
            let attrs = resource_attrs(&built.resource_metrics[0]);
            assert_eq!(
                string_attr(attrs, "service.name"),
                Some(service),
                "{namespace}"
            );
            assert_eq!(
                string_attr(attrs, "cloud.platform"),
                platform,
                "{namespace}"
            );
        }
    }

    #[test]
    fn groups_points_into_one_resource_per_service() {
        let first = stream_request(vec![(
            "amazonaws.com/AWS/ECS/CPUUtilization",
            "Percent",
            vec![
                point(&[("ServiceName", "checkout")], 1, 1.0, 1.0, 1.0),
                point(&[("ServiceName", "search")], 1, 2.0, 2.0, 2.0),
            ],
        )]);
        let second = stream_request(vec![(
            "amazonaws.com/AWS/ECS/MemoryUtilization",
            "Percent",
            vec![point_in(
                "AWS/ECS",
                "MemoryUtilization",
                &[("ServiceName", "checkout")],
                1,
                3.0,
                3.0,
                3.0,
            )],
        )]);
        let built = build_metrics_request(&[first, second], &CONNECTION);
        let services: Vec<Option<&str>> = built
            .resource_metrics
            .iter()
            .map(|resource| string_attr(resource_attrs(resource), "service.name"))
            .collect();
        assert_eq!(services, [Some("checkout"), Some("search")]);
        let checkout = &built.resource_metrics[0];
        assert!(metrics(checkout)
            .iter()
            .any(|m| m.name == "aws.ecs.cpu_utilization"));
        assert!(metrics(checkout)
            .iter()
            .any(|m| m.name == "aws.ecs.memory_utilization"));
        assert_eq!(metrics(&built.resource_metrics[1]).len(), 5);
    }

    #[test]
    fn falls_back_to_the_metric_name_for_namespace_and_name() {
        let mut bare = point(&[], 1, 1.0, 1.0, 1.0);
        bare.attributes
            .retain(|attribute| attribute.key == "Dimensions");
        let request = stream_request(vec![(
            "amazonaws.com/ECS/ContainerInsights/CpuUtilized",
            "None",
            vec![bare],
        )]);
        let built = build_metrics_request(&[request], &CONNECTION);
        let resource = &built.resource_metrics[0];
        assert!(metrics(resource)
            .iter()
            .any(|m| m.name == "aws.ecs.container_insights.cpu_utilized"));
    }

    fn delivery_json(records: &[Vec<u8>]) -> Vec<u8> {
        let records: Vec<serde_json::Value> = records
            .iter()
            .map(|data| serde_json::json!({ "data": STANDARD.encode(data) }))
            .collect();
        serde_json::json!({ "requestId": "req-1", "timestamp": 1_800_000_000_000_i64, "records": records })
            .to_string()
            .into_bytes()
    }

    fn length_delimited(requests: &[ExportMetricsServiceRequest]) -> Vec<u8> {
        requests
            .iter()
            .flat_map(Message::encode_length_delimited_to_vec)
            .collect()
    }

    #[test]
    fn reads_every_length_delimited_request_in_every_record() {
        let one = stream_request(vec![(
            "amazonaws.com/AWS/ECS/A",
            "None",
            vec![point(&[], 1, 1.0, 1.0, 1.0)],
        )]);
        let two = stream_request(vec![(
            "amazonaws.com/AWS/ECS/B",
            "None",
            vec![point(&[], 2, 2.0, 1.0, 1.0)],
        )]);
        let body = delivery_json(&[
            length_delimited(&[one.clone(), two.clone()]),
            length_delimited(std::slice::from_ref(&one)),
        ]);

        let delivery = parse_delivery(&body).expect("a Firehose request");
        assert_eq!(delivery.request_id.as_deref(), Some("req-1"));
        let requests = delivery
            .metric_requests(1024 * 1024)
            .expect("readable records");
        assert_eq!(requests, [one.clone(), two, one]);
    }

    #[test]
    fn refuses_unreadable_or_oversized_records() {
        assert!(parse_delivery(b"not json").is_none());
        assert!(parse_delivery(br#"{"requestId":"r"}"#).is_none());

        let bad_base64 =
            parse_delivery(br#"{"requestId":"r","records":[{"data":"!!!"}]}"#).unwrap();
        assert_eq!(
            bad_base64.metric_requests(1024).unwrap_err(),
            RecordError::Unreadable
        );

        let truncated = {
            let mut bytes = length_delimited(&[stream_request(vec![])]);
            bytes.push(0x7f);
            bytes
        };
        let delivery = parse_delivery(&delivery_json(&[truncated])).unwrap();
        assert_eq!(
            delivery.metric_requests(1024).unwrap_err(),
            RecordError::Unreadable
        );

        let big = length_delimited(&[stream_request(vec![(
            "amazonaws.com/AWS/ECS/A",
            "None",
            vec![point(&[], 1, 1.0, 1.0, 1.0)],
        )])]);
        let delivery = parse_delivery(&delivery_json(&[big.clone(), big.clone()])).unwrap();
        assert_eq!(
            delivery.metric_requests(big.len() + 1).unwrap_err(),
            RecordError::TooLarge
        );
        assert_eq!(delivery.metric_requests(big.len() * 2).unwrap().len(), 2);
    }

    #[test]
    fn keeps_nothing_for_empty_requests_or_resources() {
        let one = stream_request(vec![(
            "amazonaws.com/AWS/ECS/A",
            "None",
            vec![point(&[], 1, 1.0, 1.0, 1.0)],
        )]);
        let mut padded = one.clone();
        padded.resource_metrics.push(Default::default());
        // Zero bytes are empty requests, one per byte.
        let mut record = vec![0_u8; 4096];
        record.extend(length_delimited(&[padded]));
        let delivery = parse_delivery(&delivery_json(&[record])).unwrap();
        assert_eq!(delivery.metric_requests(1024 * 1024).unwrap(), [one]);
    }
}
