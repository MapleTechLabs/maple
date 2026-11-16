//! Rows as the gateway built them before the borrowed-struct encoders: each one a
//! `serde_json::Value` serialized whole, one frame per datasource for the request.
//! A frozen copy, kept so the encoders can be held to it byte for byte.

#![expect(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "a frozen copy, kept as it was written"
)]

use maple_ingest::telemetry::{
    AttributeMappingRule, DatasourceNames, MappingOperation, MappingSourceContext, SamplingPolicy,
};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::logs::v1::LogRecord;
use opentelemetry_proto::tonic::metrics::v1::{
    metric, number_data_point, Exemplar, NumberDataPoint,
};
use opentelemetry_proto::tonic::trace::v1::{span, status, Span};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};

/// Each frame's datasource and rows, in the order they were committed.
pub(crate) type Frames = Vec<(String, Vec<u8>)>;

fn rows_to_frames(
    _org_id: &str,
    _routing_key: u64,
    _signal: (),
    datasource: String,
    rows: &[Vec<u8>],
) -> Frames {
    if rows.is_empty() {
        return Vec::new();
    }
    let mut payload = Vec::new();
    for row in rows {
        payload.extend_from_slice(row);
        payload.push(b'\n');
    }
    vec![(datasource, payload)]
}

fn clamped_ratio(policy: &SamplingPolicy) -> f64 {
    if !policy.trace_sample_ratio.is_finite() {
        return 1.0;
    }
    policy.trace_sample_ratio.clamp(0.000_001, 1.0)
}

pub(crate) fn encode_traces(
    datasources: &DatasourceNames,
    org_id: &str,
    request: &ExportTraceServiceRequest,
    policy: &SamplingPolicy,
    attribute_mappings: &[AttributeMappingRule],
) -> Result<Frames, String> {
    let mut rows = Vec::new();
    let mut routing_key = hash64(org_id);
    let sample_ratio = clamped_ratio(policy);
    let sample_rate = 1.0 / sample_ratio;

    for resource_spans in &request.resource_spans {
        let resource = resource_spans.resource.as_ref();
        let resource_attrs = resource
            .map(|resource| attr_map(&resource.attributes))
            .unwrap_or_default();
        let service_name = resource_attrs
            .get("service.name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();

        for scope_spans in &resource_spans.scope_spans {
            let scope = scope_spans.scope.as_ref();
            let scope_attrs = scope
                .map(|scope| attr_map(&scope.attributes))
                .unwrap_or_default();
            let scope_name = scope.map_or("", |scope| scope.name.as_str());
            let scope_version = scope.map_or("", |scope| scope.version.as_str());

            for span in &scope_spans.spans {
                let trace_id = bytes_hex(&span.trace_id);
                if !trace_id.is_empty() {
                    routing_key = hash64(&trace_id);
                }

                let should_keep = should_keep_trace(org_id, &trace_id, span, policy);
                if !should_keep {
                    continue;
                }

                let mut span_attrs = attr_map(&span.attributes);
                if sample_ratio < 1.0
                    && !span_attrs.contains_key("SampleRate")
                    && !span.trace_state.contains("th:")
                {
                    span_attrs.insert(
                        "SampleRate".to_owned(),
                        json!(format_sample_rate(sample_rate)),
                    );
                }
                apply_attribute_mappings(attribute_mappings, &resource_attrs, &mut span_attrs);

                let events_timestamp: Vec<Value> = span
                    .events
                    .iter()
                    .map(|event| json!(format_timestamp_nano(event.time_unix_nano)))
                    .collect();
                let events_name: Vec<Value> =
                    span.events.iter().map(|event| json!(event.name)).collect();
                let events_attributes: Vec<Value> = span
                    .events
                    .iter()
                    .map(|event| Value::Object(attr_map(&event.attributes)))
                    .collect();
                let links_trace_id: Vec<Value> = span
                    .links
                    .iter()
                    .map(|link| json!(bytes_hex(&link.trace_id)))
                    .collect();
                let links_span_id: Vec<Value> = span
                    .links
                    .iter()
                    .map(|link| json!(bytes_hex(&link.span_id)))
                    .collect();
                let links_trace_state: Vec<Value> = span
                    .links
                    .iter()
                    .map(|link| json!(link.trace_state))
                    .collect();
                let links_attributes: Vec<Value> = span
                    .links
                    .iter()
                    .map(|link| Value::Object(attr_map(&link.attributes)))
                    .collect();

                rows.push(json_line(json!({
                    "start_time": format_timestamp_nano(span.start_time_unix_nano),
                    "trace_id": trace_id,
                    "span_id": bytes_hex(&span.span_id),
                    "parent_span_id": bytes_hex(&span.parent_span_id),
                    "trace_state": span.trace_state,
                    "span_name": span.name,
                    "span_kind": span_kind(span.kind),
                    "service_name": service_name,
                    "resource_schema_url": resource_spans.schema_url,
                    "resource_attributes": resource_attrs,
                    "scope_schema_url": scope_spans.schema_url,
                    "scope_name": scope_name,
                    "scope_version": scope_version,
                    "scope_attributes": scope_attrs,
                    "duration": span.end_time_unix_nano.saturating_sub(span.start_time_unix_nano),
                    "status_code": status_code(span.status.as_ref().map(|status| status.code).unwrap_or_default()),
                    "status_message": span.status.as_ref().map_or("", |status| status.message.as_str()),
                    "span_attributes": span_attrs,
                    "events_timestamp": events_timestamp,
                    "events_name": events_name,
                    "events_attributes": events_attributes,
                    "links_trace_id": links_trace_id,
                    "links_span_id": links_span_id,
                    "links_trace_state": links_trace_state,
                    "links_attributes": links_attributes
                }))?);
            }
        }
    }

    let frames = rows_to_frames(org_id, routing_key, (), datasources.traces.clone(), &rows);
    Ok(frames)
}

pub(crate) fn encode_logs(
    datasources: &DatasourceNames,
    org_id: &str,
    request: &ExportLogsServiceRequest,
) -> Result<Frames, String> {
    let mut rows = Vec::new();
    let mut routing_key = hash64(org_id);

    for resource_logs in &request.resource_logs {
        let resource = resource_logs.resource.as_ref();
        let resource_attrs = resource
            .map(|resource| attr_map(&resource.attributes))
            .unwrap_or_default();
        let service_name = resource_attrs
            .get("service.name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();

        for scope_logs in &resource_logs.scope_logs {
            let scope = scope_logs.scope.as_ref();
            let scope_attrs = scope
                .map(|scope| attr_map(&scope.attributes))
                .unwrap_or_default();
            let scope_name = scope.map_or("", |scope| scope.name.as_str());
            let scope_version = scope.map_or("", |scope| scope.version.as_str());

            for log in &scope_logs.log_records {
                let trace_id = bytes_hex(&log.trace_id);
                if !trace_id.is_empty() {
                    routing_key = hash64(&trace_id);
                }
                rows.push(encode_log_row(
                    log,
                    &service_name,
                    &resource_logs.schema_url,
                    &resource_attrs,
                    &scope_logs.schema_url,
                    scope_name,
                    scope_version,
                    &scope_attrs,
                )?);
            }
        }
    }

    let frames = rows_to_frames(org_id, routing_key, (), datasources.logs.clone(), &rows);
    Ok(frames)
}

fn encode_log_row(
    log: &LogRecord,
    service_name: &str,
    resource_schema_url: &str,
    resource_attrs: &Map<String, Value>,
    scope_schema_url: &str,
    scope_name: &str,
    scope_version: &str,
    scope_attrs: &Map<String, Value>,
) -> Result<Vec<u8>, String> {
    json_line(json!({
        "timestamp": format_timestamp_nano(if log.time_unix_nano != 0 { log.time_unix_nano } else { log.observed_time_unix_nano }),
        "trace_id": bytes_hex(&log.trace_id),
        "span_id": bytes_hex(&log.span_id),
        "flags": log.flags,
        "severity_text": if log.severity_text.is_empty() { severity_number_to_text(log.severity_number) } else { log.severity_text.as_str() },
        "severity_number": log.severity_number,
        "service_name": service_name,
        "body": log.body.as_ref().map(any_value_string).unwrap_or_default(),
        "resource_schema_url": resource_schema_url,
        "resource_attributes": resource_attrs,
        "scope_schema_url": scope_schema_url,
        "scope_name": scope_name,
        "scope_version": scope_version,
        "scope_attributes": scope_attrs,
        "log_attributes": attr_map(&log.attributes)
    }))
}

pub(crate) fn encode_metrics(
    datasources: &DatasourceNames,
    org_id: &str,
    request: &ExportMetricsServiceRequest,
) -> Result<Frames, String> {
    let mut by_datasource: BTreeMap<String, Vec<Vec<u8>>> = BTreeMap::new();
    let mut routing_key = hash64(org_id);

    for resource_metrics in &request.resource_metrics {
        let resource = resource_metrics.resource.as_ref();
        let resource_attrs = resource
            .map(|resource| attr_map(&resource.attributes))
            .unwrap_or_default();
        let service_name = resource_attrs
            .get("service.name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();

        for scope_metrics in &resource_metrics.scope_metrics {
            let scope = scope_metrics.scope.as_ref();
            let scope_attrs = scope
                .map(|scope| attr_map(&scope.attributes))
                .unwrap_or_default();
            let scope_name = scope.map_or("", |scope| scope.name.as_str());
            let scope_version = scope.map_or("", |scope| scope.version.as_str());

            for metric in &scope_metrics.metrics {
                routing_key = hash64(&metric.name);
                match metric.data.as_ref() {
                    Some(metric::Data::Gauge(gauge)) => {
                        for point in &gauge.data_points {
                            push_metric_number_row(
                                &mut by_datasource,
                                &datasources.metrics_gauge,
                                point,
                                metric,
                                &service_name,
                                &resource_metrics.schema_url,
                                &resource_attrs,
                                &scope_metrics.schema_url,
                                scope_name,
                                scope_version,
                                &scope_attrs,
                                None,
                                None,
                            )?;
                        }
                    }
                    Some(metric::Data::Sum(sum)) => {
                        for point in &sum.data_points {
                            push_metric_number_row(
                                &mut by_datasource,
                                &datasources.metrics_sum,
                                point,
                                metric,
                                &service_name,
                                &resource_metrics.schema_url,
                                &resource_attrs,
                                &scope_metrics.schema_url,
                                scope_name,
                                scope_version,
                                &scope_attrs,
                                Some(sum.aggregation_temporality),
                                Some(sum.is_monotonic),
                            )?;
                        }
                    }
                    Some(metric::Data::Histogram(histogram_data)) => {
                        for point in &histogram_data.data_points {
                            let row = metric_common_row(
                                metric,
                                &service_name,
                                &resource_metrics.schema_url,
                                &resource_attrs,
                                &scope_metrics.schema_url,
                                scope_name,
                                scope_version,
                                &scope_attrs,
                                &point.attributes,
                                point.start_time_unix_nano,
                                point.time_unix_nano,
                                point.flags,
                                &point.exemplars,
                            );
                            push_json(
                                &mut by_datasource,
                                &datasources.metrics_histogram,
                                extend(
                                    row,
                                    &json!({
                                        "count": point.count,
                                        "sum": point.sum.unwrap_or(0.0),
                                        "bucket_counts": point.bucket_counts,
                                        "explicit_bounds": point.explicit_bounds,
                                        "min": point.min,
                                        "max": point.max,
                                        "aggregation_temporality": histogram_data.aggregation_temporality
                                    }),
                                ),
                            )?;
                        }
                    }
                    Some(metric::Data::ExponentialHistogram(exp)) => {
                        for point in &exp.data_points {
                            let row = metric_common_row(
                                metric,
                                &service_name,
                                &resource_metrics.schema_url,
                                &resource_attrs,
                                &scope_metrics.schema_url,
                                scope_name,
                                scope_version,
                                &scope_attrs,
                                &point.attributes,
                                point.start_time_unix_nano,
                                point.time_unix_nano,
                                point.flags,
                                &point.exemplars,
                            );
                            let positive = point.positive.as_ref();
                            let negative = point.negative.as_ref();
                            push_json(
                                &mut by_datasource,
                                &datasources.metrics_exponential_histogram,
                                extend(
                                    row,
                                    &json!({
                                        "count": point.count,
                                        "sum": point.sum.unwrap_or(0.0),
                                        "scale": point.scale,
                                        "zero_count": point.zero_count,
                                        "positive_offset": positive.map_or(0, |b| b.offset),
                                        "positive_bucket_counts": positive.map(|b| b.bucket_counts.clone()).unwrap_or_default(),
                                        "negative_offset": negative.map_or(0, |b| b.offset),
                                        "negative_bucket_counts": negative.map(|b| b.bucket_counts.clone()).unwrap_or_default(),
                                        "min": point.min,
                                        "max": point.max,
                                        "aggregation_temporality": exp.aggregation_temporality
                                    }),
                                ),
                            )?;
                        }
                    }
                    Some(metric::Data::Summary(_)) | None => {}
                }
            }
        }
    }

    let mut frames = Vec::with_capacity(by_datasource.len());
    for (datasource, rows) in by_datasource {
        frames.extend(rows_to_frames(org_id, routing_key, (), datasource, &rows));
    }

    Ok(frames)
}

fn push_metric_number_row(
    by_datasource: &mut BTreeMap<String, Vec<Vec<u8>>>,
    datasource: &str,
    point: &NumberDataPoint,
    metric: &opentelemetry_proto::tonic::metrics::v1::Metric,
    service_name: &str,
    resource_schema_url: &str,
    resource_attrs: &Map<String, Value>,
    scope_schema_url: &str,
    scope_name: &str,
    scope_version: &str,
    scope_attrs: &Map<String, Value>,
    aggregation_temporality: Option<i32>,
    is_monotonic: Option<bool>,
) -> Result<(), String> {
    let value = match point.value {
        Some(number_data_point::Value::AsDouble(value)) => value,
        #[expect(
            clippy::cast_precision_loss,
            reason = "the row carries one numeric column, so int points widen to f64 on the way in"
        )]
        Some(number_data_point::Value::AsInt(value)) => value as f64,
        None => 0.0,
    };
    let mut extra = json!({ "value": value });
    if let Some(aggregation_temporality) = aggregation_temporality {
        extra["aggregation_temporality"] = json!(aggregation_temporality);
    }
    if let Some(is_monotonic) = is_monotonic {
        extra["is_monotonic"] = json!(is_monotonic);
    }
    let row = metric_common_row(
        metric,
        service_name,
        resource_schema_url,
        resource_attrs,
        scope_schema_url,
        scope_name,
        scope_version,
        scope_attrs,
        &point.attributes,
        point.start_time_unix_nano,
        point.time_unix_nano,
        point.flags,
        &point.exemplars,
    );
    push_json(by_datasource, datasource, extend(row, &extra))
}

fn metric_common_row(
    metric: &opentelemetry_proto::tonic::metrics::v1::Metric,
    service_name: &str,
    resource_schema_url: &str,
    resource_attrs: &Map<String, Value>,
    scope_schema_url: &str,
    scope_name: &str,
    scope_version: &str,
    scope_attrs: &Map<String, Value>,
    attributes: &[KeyValue],
    start_time_unix_nano: u64,
    time_unix_nano: u64,
    flags: u32,
    exemplars: &[Exemplar],
) -> Value {
    let exemplars = encode_exemplars(exemplars);
    json!({
        "resource_attributes": resource_attrs,
        "resource_schema_url": resource_schema_url,
        "scope_name": scope_name,
        "scope_version": scope_version,
        "scope_attributes": scope_attrs,
        "scope_schema_url": scope_schema_url,
        "service_name": service_name,
        "metric_name": metric.name,
        "metric_description": metric.description,
        "metric_unit": metric.unit,
        "metric_attributes": attr_map(attributes),
        "start_timestamp": format_timestamp_nano(start_time_unix_nano),
        "timestamp": format_timestamp_nano(time_unix_nano),
        "flags": flags,
        "exemplars_trace_id": exemplars.trace_ids,
        "exemplars_span_id": exemplars.span_ids,
        "exemplars_timestamp": exemplars.timestamps,
        "exemplars_value": exemplars.values,
        "exemplars_filtered_attributes": exemplars.filtered_attributes
    })
}

struct EncodedExemplars {
    trace_ids: Vec<String>,
    span_ids: Vec<String>,
    timestamps: Vec<String>,
    values: Vec<f64>,
    filtered_attributes: Vec<Value>,
}

fn encode_exemplars(exemplars: &[Exemplar]) -> EncodedExemplars {
    let mut trace_ids = Vec::with_capacity(exemplars.len());
    let mut span_ids = Vec::with_capacity(exemplars.len());
    let mut timestamps = Vec::with_capacity(exemplars.len());
    let mut values = Vec::with_capacity(exemplars.len());
    let mut filtered_attributes = Vec::with_capacity(exemplars.len());
    for exemplar in exemplars {
        trace_ids.push(bytes_hex(&exemplar.trace_id));
        span_ids.push(bytes_hex(&exemplar.span_id));
        timestamps.push(format_timestamp_nano(exemplar.time_unix_nano));
        values.push(match exemplar.value {
            Some(opentelemetry_proto::tonic::metrics::v1::exemplar::Value::AsDouble(value)) => {
                value
            }
            #[expect(
                clippy::cast_precision_loss,
                reason = "exemplars share the f64 column of the point they annotate"
            )]
            Some(opentelemetry_proto::tonic::metrics::v1::exemplar::Value::AsInt(value)) => {
                value as f64
            }
            None => 0.0,
        });
        filtered_attributes.push(Value::Object(attr_map(&exemplar.filtered_attributes)));
    }
    EncodedExemplars {
        trace_ids,
        span_ids,
        timestamps,
        values,
        filtered_attributes,
    }
}

fn push_json(
    by_datasource: &mut BTreeMap<String, Vec<Vec<u8>>>,
    datasource: &str,
    value: Value,
) -> Result<(), String> {
    by_datasource
        .entry(datasource.to_owned())
        .or_default()
        .push(json_line(value)?);
    Ok(())
}

fn extend(mut base: Value, extra: &Value) -> Value {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

fn json_line<T: Serialize>(value: T) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&value).map_err(|error| error.to_string())
}

fn should_keep_trace(org_id: &str, trace_id: &str, span: &Span, policy: &SamplingPolicy) -> bool {
    let ratio = clamped_ratio(policy);
    if ratio >= 1.0 {
        return true;
    }
    if policy.always_keep_error_spans
        && span
            .status
            .as_ref()
            .is_some_and(|status| status.code == status::StatusCode::Error as i32)
    {
        return true;
    }
    if let Some(ms) = policy.always_keep_slow_spans_ms {
        let duration_ms = span
            .end_time_unix_nano
            .saturating_sub(span.start_time_unix_nano)
            / 1_000_000;
        if duration_ms >= ms {
            return true;
        }
    }
    let key = if trace_id.is_empty() {
        format!("{org_id}:{}", bytes_hex(&span.span_id))
    } else {
        format!("{org_id}:{trace_id}")
    };
    #[expect(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "float-to-int casts saturate, so ratios of 0.0 and 1.0 land exactly on 0 and \
                  u64::MAX; the mantissa loss in between moves the threshold by less than one trace"
    )]
    let threshold = (ratio * u64::MAX as f64) as u64;
    hash64(&key) <= threshold
}

fn format_sample_rate(sample_rate: f64) -> String {
    if sample_rate.fract() == 0.0 {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "the branch has already established an integral value, and saturation is the \
                      right answer for the out-of-range rates that never reach here"
        )]
        let whole = sample_rate as u64;
        format!("{whole}")
    } else {
        format!("{sample_rate:.6}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned()
    }
}

fn attr_map(attributes: &[KeyValue]) -> Map<String, Value> {
    let mut out = Map::with_capacity(attributes.len());
    for attribute in attributes {
        out.insert(
            attribute.key.clone(),
            json!(attribute
                .value
                .as_ref()
                .map(any_value_string)
                .unwrap_or_default()),
        );
    }
    out
}

fn any_value_string(value: &AnyValue) -> String {
    match value.value.as_ref() {
        Some(any_value::Value::StringValue(value)) => value.clone(),
        Some(any_value::Value::BoolValue(value)) => value.to_string(),
        Some(any_value::Value::IntValue(value)) => value.to_string(),
        Some(any_value::Value::DoubleValue(value)) => value.to_string(),
        // Text sent as bytes (LangSmith's prompt and completion) stays
        // readable. Binary is hex, including binary that happens to be valid
        // UTF-8: a control character other than whitespace marks it.
        Some(any_value::Value::BytesValue(value)) => match std::str::from_utf8(value) {
            Ok(text)
                if !text
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r')) =>
            {
                text.to_owned()
            }
            _ => bytes_hex(value),
        },
        Some(any_value::Value::ArrayValue(_) | any_value::Value::KvlistValue(_)) => {
            serde_json::to_string(&any_value_json(value)).unwrap_or_default()
        }
        // String-table references (OTLP 1.9 experimental encoding) cannot be resolved
        // without the sender's dictionary, which the gateway does not accept yet.
        Some(any_value::Value::StringValueStrindex(_)) | None => String::new(),
    }
}

fn any_value_json(value: &AnyValue) -> Value {
    match value.value.as_ref() {
        Some(any_value::Value::ArrayValue(array)) => {
            Value::Array(array.values.iter().map(any_value_json).collect())
        }
        Some(any_value::Value::KvlistValue(kvlist)) => Value::Object(
            kvlist
                .values
                .iter()
                .map(|kv| {
                    let value = kv.value.as_ref().map_or(Value::from(""), any_value_json);
                    (kv.key.clone(), value)
                })
                .collect(),
        ),
        _ => Value::String(any_value_string(value)),
    }
}

fn span_kind(kind: i32) -> &'static str {
    match kind {
        x if x == span::SpanKind::Internal as i32 => "Internal",
        x if x == span::SpanKind::Server as i32 => "Server",
        x if x == span::SpanKind::Client as i32 => "Client",
        x if x == span::SpanKind::Producer as i32 => "Producer",
        x if x == span::SpanKind::Consumer as i32 => "Consumer",
        _ => "Unspecified",
    }
}

fn status_code(code: i32) -> &'static str {
    match code {
        x if x == status::StatusCode::Ok as i32 => "Ok",
        x if x == status::StatusCode::Error as i32 => "Error",
        _ => "Unset",
    }
}

fn severity_number_to_text(n: i32) -> &'static str {
    match n {
        1..=4 => "TRACE",
        5..=8 => "DEBUG",
        9..=12 => "INFO",
        13..=16 => "WARN",
        17..=20 => "ERROR",
        21..=24 => "FATAL",
        _ => "",
    }
}

fn bytes_hex(bytes: &[u8]) -> String {
    if bytes.is_empty() || bytes.iter().all(|byte| *byte == 0) {
        return String::new();
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn format_timestamp_nano(unix_nano: u64) -> String {
    // DateTime64(9) is an Int64 of nanoseconds: anything past i64::MAX (year 2262+)
    // fails the whole insert with DECIMAL_OVERFLOW, so it maps to epoch like 0 does.
    let Ok(unix_nano) = i64::try_from(unix_nano) else {
        return "1970-01-01 00:00:00.000000000".to_owned();
    };
    if unix_nano == 0 {
        return "1970-01-01 00:00:00.000000000".to_owned();
    }
    let secs = unix_nano / 1_000_000_000;
    let nanos = u32::try_from(unix_nano % 1_000_000_000).unwrap_or_default();
    let Some(dt) = chrono::DateTime::from_timestamp(secs, nanos) else {
        return "1970-01-01 00:00:00.000000000".to_owned();
    };
    dt.format("%Y-%m-%d %H:%M:%S.%f").to_string()
}

fn hash64(value: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn apply_attribute_mappings(
    rules: &[AttributeMappingRule],
    resource_attrs: &Map<String, Value>,
    span_attrs: &mut Map<String, Value>,
) {
    for rule in rules {
        if span_attrs.contains_key(&rule.target_key) {
            continue;
        }
        match rule.source_context {
            MappingSourceContext::Span => {
                let Some(value) = span_attrs.get(&rule.source_key).cloned() else {
                    continue;
                };
                span_attrs.insert(rule.target_key.clone(), value);
                if rule.operation == MappingOperation::Move {
                    span_attrs.remove(&rule.source_key);
                }
            }
            MappingSourceContext::Resource => {
                if let Some(value) = resource_attrs.get(&rule.source_key) {
                    span_attrs.insert(rule.target_key.clone(), value.clone());
                }
            }
        }
    }
}
