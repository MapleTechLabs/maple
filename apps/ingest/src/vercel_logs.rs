//! A Vercel log drain delivery (a JSON array or NDJSON of log objects) to an
//! OTLP logs request, one `ResourceLogs` per project, deployment and
//! environment in the batch.
//!
//! Field reference: <https://vercel.com/docs/drains/reference/logs>. A request
//! log carries a `proxy` object; its fields become the HTTP attributes the
//! Vercel dashboards count requests by (`http.request.method`).

use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use serde_json::{Map as JsonMap, Value as JsonValue};

pub const INGEST_SOURCE: &str = "vercel_log_drain";

type JsonObject = JsonMap<String, JsonValue>;

/// Top-level string fields copied verbatim.
const LOG_ATTRIBUTES: &[(&str, &str)] = &[
    ("source", "vercel.source"),
    ("type", "vercel.log.type"),
    ("requestId", "vercel.request.id"),
    ("entrypoint", "vercel.entrypoint"),
    ("path", "vercel.path"),
    ("host", "vercel.host"),
    ("buildId", "vercel.build.id"),
    ("edgeType", "vercel.edge_type"),
    ("executionRegion", "vercel.execution_region"),
    ("destination", "vercel.destination"),
    ("id", "vercel.log.id"),
];

/// `proxy` string fields copied verbatim.
const PROXY_ATTRIBUTES: &[(&str, &str)] = &[
    ("method", "http.request.method"),
    ("host", "server.address"),
    ("path", "url.path"),
    ("scheme", "url.scheme"),
    ("region", "vercel.proxy.region"),
    ("clientIp", "client.address"),
    ("referer", "http.request.header.referer"),
    ("vercelCache", "vercel.cache"),
    ("pathType", "vercel.path_type"),
    ("lambdaRegion", "vercel.lambda_region"),
    ("wafAction", "vercel.waf.action"),
    ("wafRuleId", "vercel.waf.rule_id"),
    ("vercelId", "vercel.proxy.id"),
];

/// The log objects in a delivery. A JSON array or NDJSON; an empty body or
/// array (the drain's test delivery) is no logs. Entries that are not objects
/// are skipped.
pub fn parse(payload: &[u8]) -> Result<Vec<JsonObject>, serde_json::Error> {
    let starts_array = payload
        .iter()
        .find(|byte| !byte.is_ascii_whitespace())
        .is_some_and(|byte| *byte == b'[');
    let values: Vec<JsonValue> = if starts_array {
        serde_json::from_slice(payload)?
    } else {
        serde_json::Deserializer::from_slice(payload)
            .into_iter()
            .collect::<Result<_, _>>()?
    };
    Ok(values
        .into_iter()
        .filter_map(|value| match value {
            JsonValue::Object(entry) => Some(entry),
            _ => None,
        })
        .collect())
}

/// Every entry with a `projectId` (which every Vercel log has) as a record,
/// grouped under its resource.
pub fn build_logs_request(entries: &[JsonObject], now_unix_nano: u64) -> ExportLogsServiceRequest {
    let mut groups: Vec<(Vec<KeyValue>, Vec<LogRecord>)> = Vec::new();
    for entry in entries {
        let Some(resource) = resource_attributes(entry) else {
            continue;
        };
        let record = log_record(entry, now_unix_nano);
        match groups
            .iter_mut()
            .find(|(attributes, _)| *attributes == resource)
        {
            Some((_, records)) => records.push(record),
            None => groups.push((resource, vec![record])),
        }
    }
    ExportLogsServiceRequest {
        resource_logs: groups
            .into_iter()
            .map(|(attributes, log_records)| ResourceLogs {
                resource: Some(Resource {
                    attributes,
                    ..Default::default()
                }),
                scope_logs: vec![ScopeLogs {
                    scope: Some(InstrumentationScope {
                        name: "vercel.log_drain".to_owned(),
                        ..Default::default()
                    }),
                    log_records,
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            })
            .collect(),
    }
}

fn resource_attributes(entry: &JsonObject) -> Option<Vec<KeyValue>> {
    let project_id = text(entry, "projectId")?;
    let project_name = text(entry, "projectName");
    let service_name = project_name.map_or_else(|| format!("vercel/{project_id}"), str::to_owned);
    let mut attributes = vec![
        attribute("service.name", &service_name),
        attribute("cloud.provider", "vercel"),
        attribute("cloud.platform", "vercel"),
        attribute("vercel.project.id", project_id),
        attribute("maple.ingest.source", INGEST_SOURCE),
    ];
    push(&mut attributes, "vercel.project.name", project_name);
    push(
        &mut attributes,
        "vercel.deployment.id",
        text(entry, "deploymentId"),
    );
    push(
        &mut attributes,
        "deployment.environment.name",
        text(entry, "customEnvironment").or_else(|| text(entry, "environment")),
    );
    push(&mut attributes, "vcs.ref.head.name", text(entry, "branch"));
    Some(attributes)
}

fn log_record(entry: &JsonObject, now_unix_nano: u64) -> LogRecord {
    let level = text(entry, "level").unwrap_or_default();
    let (severity_text, severity_number) = match level {
        "info" => ("INFO".to_owned(), 9),
        "warning" => ("WARN".to_owned(), 13),
        "error" => ("ERROR".to_owned(), 17),
        "fatal" => ("FATAL".to_owned(), 21),
        other => (other.to_ascii_uppercase(), 0),
    };

    let mut attributes = Vec::new();
    for (field, key) in LOG_ATTRIBUTES {
        push(&mut attributes, key, text(entry, field));
    }
    let proxy = entry.get("proxy").and_then(JsonValue::as_object);
    // The proxy's status is the one the client got; `-1` there means the
    // response came from cache while the page revalidated in the background.
    let status = match proxy.and_then(|proxy| proxy.get("statusCode")?.as_i64()) {
        Some(-1) => {
            attributes.push(key_value(
                "vercel.revalidation",
                any_value::Value::BoolValue(true),
            ));
            None
        }
        Some(status) => Some(status),
        None => match entry.get("statusCode").and_then(JsonValue::as_i64) {
            // No response: the function crashed.
            Some(-1) => {
                attributes.push(key_value(
                    "vercel.function.crashed",
                    any_value::Value::BoolValue(true),
                ));
                None
            }
            status => status,
        },
    };
    if let Some(status) = status {
        attributes.push(key_value(
            "http.response.status_code",
            any_value::Value::IntValue(status),
        ));
    }
    if let Some(proxy) = proxy {
        for (field, key) in PROXY_ATTRIBUTES {
            push(&mut attributes, key, text(proxy, field));
        }
        let user_agent = proxy
            .get("userAgent")
            .and_then(JsonValue::as_array)
            .map(|agents| {
                agents
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|agent| !agent.is_empty());
        push(
            &mut attributes,
            "user_agent.original",
            user_agent.as_deref(),
        );
        if let Some(size) = proxy.get("responseByteSize").and_then(JsonValue::as_i64) {
            attributes.push(key_value(
                "http.response.body.size",
                any_value::Value::IntValue(size),
            ));
        }
    }

    let id = |camel: &str, dotted: &str, len: usize| {
        text(entry, camel)
            .or_else(|| text(entry, dotted))
            .map_or_else(Vec::new, |hex| hex_bytes(hex, len))
    };
    LogRecord {
        time_unix_nano: entry
            .get("timestamp")
            .and_then(JsonValue::as_u64)
            .and_then(|millis| millis.checked_mul(1_000_000))
            .unwrap_or(now_unix_nano),
        observed_time_unix_nano: now_unix_nano,
        severity_number,
        severity_text,
        body: Some(AnyValue {
            value: Some(any_value::Value::StringValue(
                text(entry, "message").unwrap_or_default().to_owned(),
            )),
        }),
        attributes,
        trace_id: id("traceId", "trace.id", 16),
        span_id: id("spanId", "span.id", 8),
        ..Default::default()
    }
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

fn text<'a>(parent: &'a JsonObject, key: &str) -> Option<&'a str> {
    parent.get(key)?.as_str().filter(|value| !value.is_empty())
}

fn key_value(key: &str, value: any_value::Value) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        key_strindex: 0,
        value: Some(AnyValue { value: Some(value) }),
    }
}

fn attribute(key: &str, value: &str) -> KeyValue {
    key_value(key, any_value::Value::StringValue(value.to_owned()))
}

fn push(attributes: &mut Vec<KeyValue>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        attributes.push(attribute(key, value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    const NOW: u64 = 1_800_000_000_000_000_000;

    fn build(payload: &str) -> ExportLogsServiceRequest {
        build_logs_request(&parse(payload.as_bytes()).expect("valid drain body"), NOW)
    }

    fn values(attributes: &[KeyValue]) -> HashMap<String, any_value::Value> {
        attributes
            .iter()
            .filter_map(|attribute| {
                Some((
                    attribute.key.clone(),
                    attribute.value.as_ref()?.value.clone()?,
                ))
            })
            .collect()
    }

    fn string(value: &str) -> any_value::Value {
        any_value::Value::StringValue(value.to_owned())
    }

    fn only_record(
        request: &ExportLogsServiceRequest,
    ) -> (HashMap<String, any_value::Value>, &LogRecord) {
        assert_eq!(request.resource_logs.len(), 1);
        let resource_logs = &request.resource_logs[0];
        let records = &resource_logs.scope_logs[0].log_records;
        assert_eq!(records.len(), 1);
        (
            values(&resource_logs.resource.as_ref().unwrap().attributes),
            &records[0],
        )
    }

    // The two entries of the reference's JSON example.
    const BUILD_LOG: &str = r#"{ "id": "1573817187330377061717300000", "deploymentId": "dpl_233NRGRjVZX1caZrXWtz5g1TAksD", "source": "build", "host": "my-app-abc123.vercel.app", "timestamp": 1573817187330, "projectId": "gdufoJxB6b9b1fEqr1jUtFkyavUU", "level": "info", "message": "Build completed successfully", "buildId": "bld_cotnkcr76", "type": "stdout", "projectName": "my-app" }"#;
    const REQUEST_LOG: &str = r#"{ "id": "1573817250283254651097202070", "deploymentId": "dpl_233NRGRjVZX1caZrXWtz5g1TAksD", "source": "lambda", "host": "my-app-abc123.vercel.app", "timestamp": 1573817250283, "projectId": "gdufoJxB6b9b1fEqr1jUtFkyavUU", "level": "info", "message": "API request processed", "entrypoint": "api/index.js", "requestId": "643af4e3-975a-4cc7-9e7a-1eda11539d90", "statusCode": 200, "path": "/api/users", "executionRegion": "sfo1", "environment": "production", "traceId": "1b02cd14bb8642fd092bc23f54c7ffcd", "spanId": "f24e8631bd11faa7", "trace.id": "1b02cd14bb8642fd092bc23f54c7ffcd", "span.id": "f24e8631bd11faa7", "proxy": { "timestamp": 1573817250172, "method": "GET", "host": "my-app.vercel.app", "path": "/api/users?page=1", "userAgent": ["Mozilla/5.0..."], "referer": "https://my-app.vercel.app", "region": "sfo1", "statusCode": 200, "clientIp": "120.75.16.101", "scheme": "https", "vercelCache": "MISS" } }"#;

    #[test]
    fn build_log_maps_resource_body_and_build_attributes() {
        let request = build(BUILD_LOG);
        let (resource, record) = only_record(&request);
        assert_eq!(resource["service.name"], string("my-app"));
        assert_eq!(resource["cloud.provider"], string("vercel"));
        assert_eq!(resource["cloud.platform"], string("vercel"));
        assert_eq!(
            resource["vercel.project.id"],
            string("gdufoJxB6b9b1fEqr1jUtFkyavUU")
        );
        assert_eq!(resource["vercel.project.name"], string("my-app"));
        assert_eq!(
            resource["vercel.deployment.id"],
            string("dpl_233NRGRjVZX1caZrXWtz5g1TAksD")
        );
        assert_eq!(resource["maple.ingest.source"], string("vercel_log_drain"));
        assert!(!resource.contains_key("deployment.environment.name"));

        assert_eq!(record.time_unix_nano, 1_573_817_187_330_000_000);
        assert_eq!(record.observed_time_unix_nano, NOW);
        assert_eq!(
            (record.severity_text.as_str(), record.severity_number),
            ("INFO", 9)
        );
        assert_eq!(
            record.body.as_ref().unwrap().value,
            Some(string("Build completed successfully"))
        );
        assert!(record.trace_id.is_empty());
        let attributes = values(&record.attributes);
        assert_eq!(attributes["vercel.source"], string("build"));
        assert_eq!(attributes["vercel.log.type"], string("stdout"));
        assert_eq!(attributes["vercel.build.id"], string("bld_cotnkcr76"));
        assert_eq!(
            attributes["vercel.host"],
            string("my-app-abc123.vercel.app")
        );
        assert_eq!(
            attributes["vercel.log.id"],
            string("1573817187330377061717300000")
        );
        assert!(!attributes.contains_key("http.request.method"));
    }

    #[test]
    fn request_log_maps_proxy_trace_and_status() {
        let request = build(REQUEST_LOG);
        let (resource, record) = only_record(&request);
        assert_eq!(
            resource["deployment.environment.name"],
            string("production")
        );

        assert_eq!(
            record.trace_id,
            [
                0x1b, 0x02, 0xcd, 0x14, 0xbb, 0x86, 0x42, 0xfd, 0x09, 0x2b, 0xc2, 0x3f, 0x54, 0xc7,
                0xff, 0xcd
            ]
        );
        assert_eq!(
            record.span_id,
            [0xf2, 0x4e, 0x86, 0x31, 0xbd, 0x11, 0xfa, 0xa7]
        );
        let attributes = values(&record.attributes);
        assert_eq!(attributes["http.request.method"], string("GET"));
        assert_eq!(attributes["server.address"], string("my-app.vercel.app"));
        assert_eq!(attributes["url.path"], string("/api/users?page=1"));
        assert_eq!(attributes["url.scheme"], string("https"));
        assert_eq!(attributes["user_agent.original"], string("Mozilla/5.0..."));
        assert_eq!(attributes["vercel.proxy.region"], string("sfo1"));
        assert_eq!(attributes["client.address"], string("120.75.16.101"));
        assert_eq!(
            attributes["http.request.header.referer"],
            string("https://my-app.vercel.app")
        );
        assert_eq!(attributes["vercel.cache"], string("MISS"));
        assert_eq!(
            attributes["http.response.status_code"],
            any_value::Value::IntValue(200)
        );
        assert_eq!(
            attributes["vercel.request.id"],
            string("643af4e3-975a-4cc7-9e7a-1eda11539d90")
        );
        assert_eq!(attributes["vercel.entrypoint"], string("api/index.js"));
        assert_eq!(attributes["vercel.path"], string("/api/users"));
        assert_eq!(attributes["vercel.execution_region"], string("sfo1"));
    }

    #[test]
    fn function_stdout_takes_dotted_trace_ids_and_custom_environment() {
        let request = build(
            &json!({
                "id": "1", "deploymentId": "dpl_1", "projectId": "prj_1", "source": "lambda",
                "level": "error", "type": "stderr", "message": "boom",
                "environment": "preview", "customEnvironment": "staging", "branch": "feat/x",
                "trace.id": "1b02cd14bb8642fd092bc23f54c7ffcd", "span.id": "f24e8631bd11faa7",
            })
            .to_string(),
        );
        let (resource, record) = only_record(&request);
        assert_eq!(resource["service.name"], string("vercel/prj_1"));
        assert_eq!(resource["deployment.environment.name"], string("staging"));
        assert_eq!(resource["vcs.ref.head.name"], string("feat/x"));
        assert_eq!(
            (record.severity_text.as_str(), record.severity_number),
            ("ERROR", 17)
        );
        assert_eq!(record.trace_id.len(), 16);
        assert_eq!(record.span_id.len(), 8);
        // No timestamp: the record is stamped when it arrived.
        assert_eq!(record.time_unix_nano, NOW);
    }

    #[test]
    fn status_minus_one_is_a_crash_or_a_revalidation_not_a_status() {
        let crashed =
            build(&json!({ "projectId": "prj_1", "level": "fatal", "statusCode": -1 }).to_string());
        let (_, record) = only_record(&crashed);
        let attributes = values(&record.attributes);
        assert_eq!(
            attributes["vercel.function.crashed"],
            any_value::Value::BoolValue(true)
        );
        assert!(!attributes.contains_key("http.response.status_code"));
        assert_eq!(record.severity_number, 21);

        let revalidated = build(
            &json!({
                "projectId": "prj_1", "level": "info", "statusCode": 200,
                "proxy": { "method": "GET", "statusCode": -1, "responseByteSize": 512 },
            })
            .to_string(),
        );
        let (_, record) = only_record(&revalidated);
        let attributes = values(&record.attributes);
        assert_eq!(
            attributes["vercel.revalidation"],
            any_value::Value::BoolValue(true)
        );
        assert!(!attributes.contains_key("http.response.status_code"));
        assert!(!attributes.contains_key("vercel.function.crashed"));
        assert_eq!(
            attributes["http.response.body.size"],
            any_value::Value::IntValue(512)
        );

        // The proxy's status wins over the function's.
        let proxied = build(
            &json!({ "projectId": "prj_1", "statusCode": 200, "proxy": { "statusCode": 304 } })
                .to_string(),
        );
        let (_, record) = only_record(&proxied);
        assert_eq!(
            values(&record.attributes)["http.response.status_code"],
            any_value::Value::IntValue(304)
        );
    }

    #[test]
    fn ndjson_and_array_deliveries_group_by_resource() {
        let other_project = r#"{"projectId":"prj_2","projectName":"docs","deploymentId":"dpl_9","level":"warning","message":"slow"}"#;
        let ndjson = format!("{BUILD_LOG}\n{REQUEST_LOG}\n\n{other_project}\n");
        let array = format!("[{BUILD_LOG},{REQUEST_LOG},{other_project}]");
        for payload in [ndjson, array] {
            let request = build(&payload);
            // The build and request logs differ in environment.
            assert_eq!(request.resource_logs.len(), 3);
            let docs = &request.resource_logs[2];
            assert_eq!(
                values(&docs.resource.as_ref().unwrap().attributes)["service.name"],
                string("docs")
            );
            let record = &docs.scope_logs[0].log_records[0];
            assert_eq!(
                (record.severity_text.as_str(), record.severity_number),
                ("WARN", 13)
            );
        }

        let same_resource = format!("{BUILD_LOG}\n{BUILD_LOG}");
        let request = build(&same_resource);
        assert_eq!(request.resource_logs.len(), 1);
        assert_eq!(request.resource_logs[0].scope_logs[0].log_records.len(), 2);
    }

    #[test]
    fn test_deliveries_are_no_logs_and_malformed_json_is_an_error() {
        for payload in ["", "[]", " \n", "{}", "[{}]"] {
            assert!(build(payload).resource_logs.is_empty(), "{payload:?}");
        }
        assert!(parse(b"[{\"projectId\":").is_err());
        assert!(parse(b"{\"projectId\":\"a\"}\nnot json").is_err());
    }
}
