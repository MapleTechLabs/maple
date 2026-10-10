//! Cloud Logging `LogEntry` (delivered by an unwrapped Pub/Sub push, one entry
//! per request) to an OTLP logs request.

use chrono::DateTime;
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use serde_json::{Map as JsonMap, Value as JsonValue};

pub const INGEST_SOURCE: &str = "gcp-logpush";

// What a connector's `last_error` holds. The customer reads it on the
// connection: one sentence of cause, one of what to do.

/// A push body that is not a `LogEntry`.
pub const NOT_A_LOG_ENTRY: &str = "The Pub/Sub subscription wraps each entry in an envelope \
    Maple can't read. Run the setup script again: it resets the subscription. Entries sent \
    meanwhile are lost.";

/// An entry Maple accepted but could not hand to the pipeline.
pub const ENTRY_NOT_STORED: &str = "Maple could not store an entry just now. Pub/Sub retries it \
    for up to a day. Nothing to do.";

/// An entry refused because the organization is over its plan limit.
pub const OVER_PLAN_LIMIT: &str = "This Maple organization is over its plan limit, so Maple \
    refuses new logs. Pub/Sub retries for up to a day. See Settings, Billing.";

/// The log a setup script names in the entry that reports what it applied.
const SETUP_REPORT_LOG: &str = "/logs/maple-setup";

/// What a run of the setup or cleanup script applied in Google Cloud. `None`
/// for a capability the reporting section did not touch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SetupReport {
    pub logs: Option<bool>,
    pub metrics: Option<bool>,
}

type JsonObject = JsonMap<String, JsonValue>;

/// The connector a push authenticated as.
#[derive(Debug)]
pub struct Connector<'a> {
    pub id: &'a str,
    pub org_id: &'a str,
}

const HTTP_REQUEST_ATTRIBUTES: &[(&str, &str)] = &[
    ("requestMethod", "http.request.method"),
    ("requestUrl", "url.full"),
    ("status", "http.response.status_code"),
    ("requestSize", "http.request.size"),
    ("responseSize", "http.response.size"),
    ("userAgent", "user_agent.original"),
    ("remoteIp", "client.address"),
    ("serverIp", "server.address"),
    ("referer", "http.request.header.referer"),
];

const SOURCE_LOCATION_ATTRIBUTES: &[(&str, &str)] = &[
    ("file", "code.file.path"),
    ("line", "code.line.number"),
    ("function", "code.function.name"),
];

/// Every `LogEntry` carries `logName`. Anything without it (not JSON, or the
/// wrapped Pub/Sub envelope) is not one and will never become one on retry.
pub fn parse_log_entry(payload: &[u8]) -> Option<JsonObject> {
    let entry: JsonObject = serde_json::from_slice(payload).ok()?;
    let is_log_entry = entry.get("logName").is_some_and(JsonValue::is_string);
    is_log_entry.then_some(entry)
}

/// A setup report is a `LogEntry` on the `maple-setup` log whose payload says
/// what the run applied. The script publishes it through the sink's topic, or
/// posts it here when there is no topic.
pub fn parse_setup_report(payload: &[u8]) -> Option<SetupReport> {
    // Asked of every pushed log line, so the bytes are searched before
    // anything is parsed.
    let marker = SETUP_REPORT_LOG.as_bytes();
    if !payload.windows(marker.len()).any(|window| window == marker) {
        return None;
    }
    let entry = parse_log_entry(payload)?;
    if !text(&entry, "logName")?.ends_with(SETUP_REPORT_LOG) {
        return None;
    }
    let applied = object(&entry, "jsonPayload")?;
    let flag = |key: &str| applied.get(key).and_then(JsonValue::as_bool);
    let report = SetupReport {
        logs: flag("logs"),
        metrics: flag("metrics"),
    };
    (report.logs.is_some() || report.metrics.is_some()).then_some(report)
}

pub fn build_logs_request(
    entry: &JsonObject,
    connector: &Connector<'_>,
    now_unix_nano: u64,
) -> ExportLogsServiceRequest {
    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(Resource {
                attributes: resource_attributes(entry, connector),
                ..Default::default()
            }),
            scope_logs: vec![ScopeLogs {
                scope: Some(InstrumentationScope {
                    name: "gcp.logging".to_owned(),
                    ..Default::default()
                }),
                log_records: vec![log_record(entry, now_unix_nano)],
                schema_url: String::new(),
            }],
            schema_url: String::new(),
        }],
    }
}

fn resource_attributes(entry: &JsonObject, connector: &Connector<'_>) -> Vec<KeyValue> {
    let resource = object(entry, "resource");
    let resource_type = resource
        .and_then(|resource| text(resource, "type"))
        .unwrap_or("unknown");
    let labels = resource.and_then(|resource| object(resource, "labels"));
    let label = |key: &str| labels.and_then(|labels| text(labels, key));

    let mut attributes = vec![
        attribute("maple_org_id", connector.org_id),
        attribute("maple_ingest_source", INGEST_SOURCE),
        attribute("maple_ingest_key_type", "connector"),
        attribute("maple_gcp_connector_id", connector.id),
        attribute("cloud.provider", "gcp"),
        attribute("gcp.resource.type", resource_type),
    ];
    // An aggregated sink delivers entries from many projects, so the project
    // is the entry's own. Entries logged against an organization, folder or
    // billing account have none.
    let project = label("project_id").or_else(|| {
        let (project, _) = text(entry, "logName")?
            .strip_prefix("projects/")?
            .split_once("/logs/")?;
        Some(project)
    });
    push(&mut attributes, "cloud.account.id", project);
    push(
        &mut attributes,
        "cloud.platform",
        cloud_platform(resource_type),
    );

    // `location` names a zone for zonal resources and a region otherwise.
    let location = label("zone")
        .or_else(|| label("location"))
        .or_else(|| label("region"));
    match location.and_then(|location| location.rsplit_once('-')) {
        Some((region, suffix)) if matches!(suffix.as_bytes(), [b'a'..=b'z']) => {
            push(&mut attributes, "cloud.region", Some(region));
            push(&mut attributes, "cloud.availability_zone", location);
        }
        _ => push(&mut attributes, "cloud.region", location),
    }

    // Compute workloads take the bare workload name so their logs join the
    // traced service of the same name; everything else is `gcp/<resource type>`.
    let workload = match resource_type {
        "cloud_run_revision" => {
            // A revision's own system events carry an empty `service_name`. A service's
            // configuration has the service's name.
            let service = label("service_name").or_else(|| label("configuration_name"));
            push(&mut attributes, "faas.name", service);
            push(&mut attributes, "faas.version", label("revision_name"));
            service
        }
        "cloud_run_job" => label("job_name"),
        "cloud_function" => {
            push(&mut attributes, "faas.name", label("function_name"));
            label("function_name")
        }
        "k8s_container" => {
            push(&mut attributes, "k8s.cluster.name", label("cluster_name"));
            push(
                &mut attributes,
                "k8s.namespace.name",
                label("namespace_name"),
            );
            push(&mut attributes, "k8s.pod.name", label("pod_name"));
            push(
                &mut attributes,
                "k8s.container.name",
                label("container_name"),
            );
            label("container_name")
        }
        "gce_instance" => {
            let name = object(entry, "labels")
                .and_then(|labels| text(labels, "compute.googleapis.com/resource_name"));
            push(&mut attributes, "host.id", label("instance_id"));
            push(&mut attributes, "host.name", name);
            name
        }
        "gae_app" => label("module_id"),
        _ => None,
    };
    let service_name = workload.map_or_else(|| format!("gcp/{resource_type}"), str::to_owned);
    attributes.push(attribute("service.name", &service_name));

    if let Some(labels) = labels {
        push_fields(&mut attributes, labels, &[], "gcp.resource.labels.");
    }
    attributes
}

fn cloud_platform(resource_type: &str) -> Option<&'static str> {
    match resource_type {
        "cloud_run_revision" | "cloud_run_job" => Some("gcp_cloud_run"),
        "cloud_function" => Some("gcp_cloud_functions"),
        "gce_instance" => Some("gcp_compute_engine"),
        "gae_app" => Some("gcp_app_engine"),
        other if other.starts_with("k8s_") => Some("gcp_kubernetes_engine"),
        _ => None,
    }
}

fn log_record(entry: &JsonObject, now_unix_nano: u64) -> LogRecord {
    let timestamp = |key: &str| text(entry, key).and_then(parse_timestamp);
    let observed = timestamp("receiveTimestamp").unwrap_or(now_unix_nano);
    let (severity_text, severity_number) = severity(text(entry, "severity").unwrap_or_default());

    // Payload fields first, so the entry's own metadata wins a key collision.
    let mut attributes = Vec::new();
    let body = body(entry, &mut attributes);
    if let Some(request) = object(entry, "httpRequest") {
        push_fields(
            &mut attributes,
            request,
            HTTP_REQUEST_ATTRIBUTES,
            "gcp.http_request.",
        );
    }
    if let Some(location) = object(entry, "sourceLocation") {
        push_fields(
            &mut attributes,
            location,
            SOURCE_LOCATION_ATTRIBUTES,
            "gcp.source_location.",
        );
    }
    if let Some(labels) = object(entry, "labels") {
        push_fields(&mut attributes, labels, &[], "gcp.labels.");
    }
    push(&mut attributes, "log.record.uid", text(entry, "insertId"));
    push(&mut attributes, "gcp.log_name", text(entry, "logName"));

    LogRecord {
        time_unix_nano: timestamp("timestamp").unwrap_or(observed),
        observed_time_unix_nano: observed,
        severity_number,
        severity_text: severity_text.to_owned(),
        body: Some(AnyValue {
            value: Some(any_value::Value::StringValue(body)),
        }),
        attributes,
        flags: u32::from(entry.get("traceSampled") == Some(&JsonValue::Bool(true))),
        // `trace` is `projects/<project>/traces/<32 hex>`, or the bare id.
        trace_id: text(entry, "trace").map_or_else(Vec::new, |trace| {
            hex_bytes(trace.rsplit_once('/').map_or(trace, |(_, id)| id), 16)
        }),
        span_id: text(entry, "spanId").map_or_else(Vec::new, |span_id| hex_bytes(span_id, 8)),
        ..Default::default()
    }
}

/// The body of whichever payload the entry carries; the payload's structured
/// fields are pushed onto `attributes`.
fn body(entry: &JsonObject, attributes: &mut Vec<KeyValue>) -> String {
    if let Some(text_payload) = text(entry, "textPayload") {
        return text_payload.to_owned();
    }

    if let Some(payload) = object(entry, "jsonPayload") {
        let message = ["message", "msg"]
            .into_iter()
            .find_map(|key| Some((key, text(payload, key)?)));
        attributes.extend(
            payload
                .iter()
                .filter(|(key, _)| {
                    message.is_none_or(|(message_key, _)| message_key != key.as_str())
                })
                .filter_map(|(key, value)| json_attribute(key, value)),
        );
        return message.map_or_else(|| compact_json(payload), |(_, message)| message.to_owned());
    }

    // Audit logs.
    if let Some(payload) = object(entry, "protoPayload") {
        let method = text(payload, "methodName");
        let status = object(payload, "status");
        push(
            attributes,
            "gcp.audit.service.name",
            text(payload, "serviceName"),
        );
        push(attributes, "gcp.audit.method.name", method);
        push(
            attributes,
            "gcp.audit.resource.name",
            text(payload, "resourceName"),
        );
        push(
            attributes,
            "user.email",
            object(payload, "authenticationInfo").and_then(|info| text(info, "principalEmail")),
        );
        attributes.extend(
            status
                .and_then(|status| status.get("code"))
                .and_then(|code| json_attribute("rpc.response.status_code", code)),
        );
        return match (method, status.and_then(|status| text(status, "message"))) {
            (Some(method), Some(message)) => format!("{method}: {message}"),
            (Some(method), None) => method.to_owned(),
            (None, _) => compact_json(payload),
        };
    }

    // Request logs (Cloud Run, load balancers) carry only `httpRequest`.
    object(entry, "httpRequest").map_or_else(String::new, |request| {
        format!(
            "{} {} -> {}",
            text(request, "requestMethod").unwrap_or("UNKNOWN"),
            text(request, "requestUrl").unwrap_or("-"),
            request
                .get("status")
                .and_then(JsonValue::as_u64)
                .unwrap_or(0),
        )
    })
}

/// Cloud Logging severity to the OTel severity name and number. The numbers
/// are the OpenTelemetry Collector's Cloud Logging mapping; `DEFAULT` is
/// unspecified.
fn severity(name: &str) -> (&'static str, i32) {
    match name {
        "DEBUG" => ("DEBUG", 5),
        "INFO" => ("INFO", 9),
        "NOTICE" => ("INFO", 10),
        "WARNING" => ("WARN", 13),
        "ERROR" => ("ERROR", 17),
        "CRITICAL" => ("FATAL", 21),
        "ALERT" => ("FATAL", 22),
        "EMERGENCY" => ("FATAL", 24),
        _ => ("", 0),
    }
}

fn parse_timestamp(value: &str) -> Option<u64> {
    let nanos = DateTime::parse_from_rfc3339(value)
        .ok()?
        .timestamp_nanos_opt()?;
    u64::try_from(nanos).ok()
}

/// `len` bytes from exactly `2 * len` hex digits, empty for anything else.
fn hex_bytes(hex: &str, len: usize) -> Vec<u8> {
    if hex.len() != len * 2 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Vec::new();
    }
    (0..len)
        .filter_map(|index| u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok())
        .collect()
}

fn object<'a>(parent: &'a JsonObject, key: &str) -> Option<&'a JsonObject> {
    parent.get(key)?.as_object()
}

fn text<'a>(parent: &'a JsonObject, key: &str) -> Option<&'a str> {
    parent.get(key)?.as_str().filter(|value| !value.is_empty())
}

fn compact_json(object: &JsonObject) -> String {
    serde_json::to_string(object).unwrap_or_default()
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

/// Scalars as strings, nested values as compact JSON; null is dropped.
fn json_attribute(key: &str, value: &JsonValue) -> Option<KeyValue> {
    match value {
        JsonValue::Null => None,
        JsonValue::String(value) => Some(attribute(key, value)),
        other => Some(attribute(key, &other.to_string())),
    }
}

fn push(attributes: &mut Vec<KeyValue>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        attributes.push(attribute(key, value));
    }
}

/// Every field of `fields` as an attribute: under its `renames` key when it
/// has one, under `prefix` + its own name otherwise.
fn push_fields(
    attributes: &mut Vec<KeyValue>,
    fields: &JsonObject,
    renames: &[(&str, &str)],
    prefix: &str,
) {
    for (field, value) in fields {
        let key = renames
            .iter()
            .find(|(name, _)| *name == field.as_str())
            .map_or_else(|| format!("{prefix}{field}"), |(_, key)| (*key).to_owned());
        attributes.extend(json_attribute(&key, value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    const NOW: u64 = 1_800_000_000_000_000_000;
    const CONNECTOR: Connector<'static> = Connector {
        id: "gcp_conn_1",
        org_id: "org_1",
    };

    fn convert(entry: JsonValue) -> (HashMap<String, String>, LogRecord) {
        let entry = parse_log_entry(entry.to_string().as_bytes()).expect("a LogEntry");
        let mut request = build_logs_request(&entry, &CONNECTOR, NOW);
        let mut resource_logs = request.resource_logs.remove(0);
        let record = resource_logs.scope_logs.remove(0).log_records.remove(0);
        (strings(&resource_logs.resource.unwrap().attributes), record)
    }

    fn strings(attributes: &[KeyValue]) -> HashMap<String, String> {
        attributes
            .iter()
            .filter_map(
                |attribute| match attribute.value.as_ref()?.value.as_ref()? {
                    any_value::Value::StringValue(value) => {
                        Some((attribute.key.clone(), value.clone()))
                    }
                    _ => None,
                },
            )
            .collect()
    }

    fn body_of(record: &LogRecord) -> &str {
        match record.body.as_ref().and_then(|body| body.value.as_ref()) {
            Some(any_value::Value::StringValue(value)) => value,
            _ => panic!("expected a string body"),
        }
    }

    #[test]
    fn cloud_run_revision_event_without_a_service_name_is_named_by_its_configuration() {
        let (resource, _) = convert(json!({
            "logName": "projects/my-project/logs/cloudaudit.googleapis.com%2Fsystem_event",
            "resource": {
                "type": "cloud_run_revision",
                "labels": {
                    "project_id": "my-project",
                    "service_name": "",
                    "revision_name": "checkout-00042-abc",
                    "location": "europe-west4",
                    "configuration_name": "checkout"
                }
            }
        }));

        assert_eq!(resource["service.name"], "checkout");
        assert_eq!(resource["faas.name"], "checkout");
    }

    #[test]
    fn cloud_run_entry_maps_resource_trace_time_and_severity() {
        let (resource, record) = convert(json!({
            "logName": "projects/my-project/logs/run.googleapis.com%2Fstdout",
            "insertId": "insert-1",
            "timestamp": "2025-03-07T12:34:56.123456789Z",
            "receiveTimestamp": "2025-03-07T12:34:57Z",
            "severity": "WARNING",
            "textPayload": "cache miss",
            "trace": "projects/my-project/traces/0af7651916cd43dd8448eb211c80319c",
            "spanId": "b7ad6b7169203331",
            "traceSampled": true,
            "labels": { "instanceId": "abc" },
            "sourceLocation": { "file": "main.go", "line": "42", "function": "main.handle" },
            "resource": {
                "type": "cloud_run_revision",
                "labels": {
                    "project_id": "my-project",
                    "service_name": "checkout",
                    "revision_name": "checkout-00042-abc",
                    "location": "europe-west4",
                    "configuration_name": "checkout"
                }
            }
        }));

        assert_eq!(resource["service.name"], "checkout");
        assert_eq!(resource["faas.name"], "checkout");
        assert_eq!(resource["faas.version"], "checkout-00042-abc");
        assert_eq!(resource["cloud.provider"], "gcp");
        assert_eq!(resource["cloud.platform"], "gcp_cloud_run");
        assert_eq!(resource["cloud.account.id"], "my-project");
        assert_eq!(resource["cloud.region"], "europe-west4");
        assert!(!resource.contains_key("cloud.availability_zone"));
        assert_eq!(resource["gcp.resource.type"], "cloud_run_revision");
        assert_eq!(
            resource["gcp.resource.labels.configuration_name"],
            "checkout"
        );
        assert_eq!(resource["maple_org_id"], "org_1");
        assert_eq!(resource["maple_ingest_source"], INGEST_SOURCE);
        assert_eq!(resource["maple_ingest_key_type"], "connector");
        assert_eq!(resource["maple_gcp_connector_id"], "gcp_conn_1");

        assert_eq!(body_of(&record), "cache miss");
        assert_eq!(record.time_unix_nano, 1_741_350_896_123_456_789);
        assert_eq!(record.observed_time_unix_nano, 1_741_350_897_000_000_000);
        assert_eq!(
            (record.severity_text.as_str(), record.severity_number),
            ("WARN", 13)
        );
        assert_eq!(
            record.trace_id,
            [
                0x0a, 0xf7, 0x65, 0x19, 0x16, 0xcd, 0x43, 0xdd, 0x84, 0x48, 0xeb, 0x21, 0x1c, 0x80,
                0x31, 0x9c
            ]
        );
        assert_eq!(
            record.span_id,
            [0xb7, 0xad, 0x6b, 0x71, 0x69, 0x20, 0x33, 0x31]
        );
        assert_eq!(record.flags, 1);

        let attributes = strings(&record.attributes);
        assert_eq!(attributes["log.record.uid"], "insert-1");
        assert_eq!(
            attributes["gcp.log_name"],
            "projects/my-project/logs/run.googleapis.com%2Fstdout"
        );
        assert_eq!(attributes["gcp.labels.instanceId"], "abc");
        assert_eq!(attributes["code.file.path"], "main.go");
        assert_eq!(attributes["code.line.number"], "42");
        assert_eq!(attributes["code.function.name"], "main.handle");
    }

    #[test]
    fn gke_container_json_payload_becomes_body_and_attributes() {
        let (resource, record) = convert(json!({
            "logName": "projects/my-project/logs/stdout",
            "severity": "ERROR",
            "jsonPayload": {
                "message": "payment failed",
                "order_id": 1234,
                "retry": false,
                "customer": { "tier": "pro" },
                "ignored": null
            },
            "resource": {
                "type": "k8s_container",
                "labels": {
                    "project_id": "my-project",
                    "location": "us-central1-a",
                    "cluster_name": "prod",
                    "namespace_name": "payments",
                    "pod_name": "api-7d9f-xk2",
                    "container_name": "api"
                }
            }
        }));

        assert_eq!(resource["service.name"], "api");
        assert_eq!(resource["cloud.platform"], "gcp_kubernetes_engine");
        assert_eq!(resource["cloud.region"], "us-central1");
        assert_eq!(resource["cloud.availability_zone"], "us-central1-a");
        assert_eq!(resource["k8s.cluster.name"], "prod");
        assert_eq!(resource["k8s.namespace.name"], "payments");
        assert_eq!(resource["k8s.pod.name"], "api-7d9f-xk2");
        assert_eq!(resource["k8s.container.name"], "api");

        assert_eq!(body_of(&record), "payment failed");
        assert_eq!(
            (record.severity_text.as_str(), record.severity_number),
            ("ERROR", 17)
        );
        let attributes = strings(&record.attributes);
        assert_eq!(attributes["order_id"], "1234");
        assert_eq!(attributes["retry"], "false");
        assert_eq!(attributes["customer"], r#"{"tier":"pro"}"#);
        assert!(!attributes.contains_key("message"));
        assert!(!attributes.contains_key("ignored"));
    }

    #[test]
    fn json_payload_without_a_message_is_the_body_as_compact_json() {
        let (_, record) = convert(json!({
            "logName": "projects/my-project/logs/stdout",
            "jsonPayload": { "event": "tick" }
        }));

        assert_eq!(body_of(&record), r#"{"event":"tick"}"#);
        assert_eq!(strings(&record.attributes)["event"], "tick");
    }

    #[test]
    fn gce_instance_is_named_by_its_resource_name_label() {
        let entry = |labels: JsonValue| {
            json!({
                "logName": "projects/my-project/logs/syslog",
                "textPayload": "started",
                "labels": labels,
                "resource": {
                    "type": "gce_instance",
                    "labels": {
                        "project_id": "my-project",
                        "instance_id": "8123456789",
                        "zone": "europe-west1-b"
                    }
                }
            })
        };

        let (named, _) = convert(entry(
            json!({ "compute.googleapis.com/resource_name": "web-1" }),
        ));
        assert_eq!(named["service.name"], "web-1");
        assert_eq!(named["host.name"], "web-1");
        assert_eq!(named["host.id"], "8123456789");
        assert_eq!(named["cloud.platform"], "gcp_compute_engine");
        assert_eq!(named["cloud.region"], "europe-west1");
        assert_eq!(named["cloud.availability_zone"], "europe-west1-b");

        let (unnamed, _) = convert(entry(json!({})));
        assert_eq!(unnamed["service.name"], "gcp/gce_instance");
        assert_eq!(unnamed["host.id"], "8123456789");
        assert!(!unnamed.contains_key("host.name"));
    }

    #[test]
    fn audit_log_proto_payload_maps_method_status_and_principal() {
        let (resource, record) = convert(json!({
            "logName": "projects/my-project/logs/cloudaudit.googleapis.com%2Factivity",
            "severity": "NOTICE",
            "protoPayload": {
                "@type": "type.googleapis.com/google.cloud.audit.AuditLog",
                "serviceName": "run.googleapis.com",
                "methodName": "google.cloud.run.v1.Services.ReplaceService",
                "resourceName": "namespaces/my-project/services/checkout",
                "authenticationInfo": { "principalEmail": "deployer@example.com" },
                "status": { "code": 7, "message": "Permission denied" }
            },
            "resource": {
                "type": "audited_resource",
                "labels": { "project_id": "my-project", "service": "run.googleapis.com" }
            }
        }));

        assert_eq!(resource["service.name"], "gcp/audited_resource");
        assert!(!resource.contains_key("cloud.platform"));
        assert_eq!(
            body_of(&record),
            "google.cloud.run.v1.Services.ReplaceService: Permission denied"
        );
        assert_eq!(
            (record.severity_text.as_str(), record.severity_number),
            ("INFO", 10)
        );
        let attributes = strings(&record.attributes);
        assert_eq!(attributes["gcp.audit.service.name"], "run.googleapis.com");
        assert_eq!(
            attributes["gcp.audit.method.name"],
            "google.cloud.run.v1.Services.ReplaceService"
        );
        assert_eq!(
            attributes["gcp.audit.resource.name"],
            "namespaces/my-project/services/checkout"
        );
        assert_eq!(attributes["user.email"], "deployer@example.com");
        assert_eq!(attributes["rpc.response.status_code"], "7");
    }

    #[test]
    fn managed_service_request_log_gets_prefixed_service_and_http_attributes() {
        let (resource, record) = convert(json!({
            "logName": "projects/my-project/logs/requests",
            "severity": "INFO",
            "httpRequest": {
                "requestMethod": "GET",
                "requestUrl": "https://example.com/health",
                "status": 502,
                "responseSize": "512",
                "userAgent": "curl/8.0",
                "remoteIp": "203.0.113.7",
                "latency": "0.250s"
            },
            "resource": {
                "type": "http_load_balancer",
                "labels": {
                    "project_id": "my-project",
                    "forwarding_rule_name": "edge",
                    "zone": "global"
                }
            }
        }));

        assert_eq!(resource["service.name"], "gcp/http_load_balancer");
        assert_eq!(resource["cloud.region"], "global");
        assert_eq!(resource["gcp.resource.labels.forwarding_rule_name"], "edge");

        assert_eq!(body_of(&record), "GET https://example.com/health -> 502");
        let attributes = strings(&record.attributes);
        assert_eq!(attributes["http.request.method"], "GET");
        assert_eq!(attributes["url.full"], "https://example.com/health");
        assert_eq!(attributes["http.response.status_code"], "502");
        assert_eq!(attributes["http.response.size"], "512");
        assert_eq!(attributes["user_agent.original"], "curl/8.0");
        assert_eq!(attributes["client.address"], "203.0.113.7");
        assert_eq!(attributes["gcp.http_request.latency"], "0.250s");
    }

    #[test]
    fn malformed_trace_and_timestamps_are_left_empty() {
        let (resource, record) = convert(json!({
            "logName": "projects/my-project/logs/stdout",
            "timestamp": "yesterday",
            "severity": "DEFAULT",
            "textPayload": "hello",
            "trace": "projects/my-project/traces/not-a-trace-id",
            "spanId": "+7ad6b7169203331",
            "traceSampled": "yes"
        }));

        assert_eq!(record.time_unix_nano, NOW);
        assert_eq!(record.observed_time_unix_nano, NOW);
        assert!(record.trace_id.is_empty());
        assert!(record.span_id.is_empty());
        assert_eq!(record.flags, 0);
        assert_eq!(
            (record.severity_text.as_str(), record.severity_number),
            ("", 0)
        );
        // No `resource` at all: the project comes from `logName`.
        assert_eq!(resource["cloud.account.id"], "my-project");
        assert_eq!(resource["service.name"], "gcp/unknown");
    }

    #[test]
    fn cloud_account_id_is_the_entry_project_when_it_has_one() {
        // A child project's entry, delivered through an aggregated sink.
        let (child, _) = convert(json!({
            "logName": "projects/child-project/logs/stdout",
            "textPayload": "hello",
            "resource": {
                "type": "cloud_run_revision",
                "labels": { "project_id": "child-project", "service_name": "api" }
            }
        }));
        assert_eq!(child["cloud.account.id"], "child-project");

        let (log_name_only, _) = convert(json!({
            "logName": "projects/other-project/logs/cloudaudit.googleapis.com%2Factivity",
            "textPayload": "hello",
            "resource": { "type": "global", "labels": {} }
        }));
        assert_eq!(log_name_only["cloud.account.id"], "other-project");

        let (organization, record) = convert(json!({
            "logName": "organizations/123456789/logs/cloudaudit.googleapis.com%2Factivity",
            "severity": "NOTICE",
            "protoPayload": {
                "@type": "type.googleapis.com/google.cloud.audit.AuditLog",
                "serviceName": "cloudresourcemanager.googleapis.com",
                "methodName": "SetIamPolicy"
            },
            "resource": {
                "type": "organization",
                "labels": { "organization_id": "123456789" }
            }
        }));
        assert!(!organization.contains_key("cloud.account.id"));
        assert_eq!(organization["service.name"], "gcp/organization");
        assert_eq!(
            organization["gcp.resource.labels.organization_id"],
            "123456789"
        );
        assert_eq!(body_of(&record), "SetIamPolicy");
    }

    #[test]
    fn only_a_log_entry_parses() {
        assert!(parse_log_entry(br#"{"logName":"projects/p/logs/l"}"#).is_some());
        assert!(parse_log_entry(b"not json").is_none());
        assert!(parse_log_entry(b"[]").is_none());
        // The wrapped Pub/Sub envelope, which this receiver does not accept.
        assert!(parse_log_entry(
            br#"{"message":{"data":"e30=","messageId":"1"},"subscription":"projects/p/subscriptions/s"}"#
        )
        .is_none());
    }

    #[test]
    fn only_an_entry_on_the_setup_log_with_a_flag_is_a_setup_report() {
        let report = |payload: JsonValue| {
            parse_setup_report(
                json!({ "logName": "projects/p/logs/maple-setup", "jsonPayload": payload })
                    .to_string()
                    .as_bytes(),
            )
        };
        assert_eq!(
            report(json!({ "logs": true })),
            Some(SetupReport {
                logs: Some(true),
                metrics: None
            })
        );
        assert_eq!(
            report(json!({ "logs": false, "metrics": false })),
            Some(SetupReport {
                logs: Some(false),
                metrics: Some(false)
            })
        );
        // Nothing a script sends: no flag, or a flag that is not a boolean.
        assert_eq!(report(json!({})), None);
        assert_eq!(report(json!({ "logs": "true" })), None);

        // A customer's own entry that mentions the log, on another log.
        let elsewhere = json!({
            "logName": "projects/p/logs/app",
            "textPayload": "wrote projects/p/logs/maple-setup",
            "jsonPayload": { "logs": true }
        });
        assert_eq!(parse_setup_report(elsewhere.to_string().as_bytes()), None);
        assert_eq!(parse_setup_report(b"not json /logs/maple-setup"), None);
    }
}
