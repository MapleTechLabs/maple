//! Vercel's Speed Insights, Web Analytics and Audit Log drains (each a JSON
//! array or NDJSON of events) to OTLP logs, one `ResourceLogs` per resource in
//! the batch.
//!
//! Field references: <https://vercel.com/docs/drains/reference/speed-insights>,
//! `/analytics` and `/audit-logs`. Each kind has its own `service.name`, so its
//! events stay apart from the projects' own logs.

use crate::vercel_logs::{
    grouped_logs_request, key_value, push, text, timestamp_nanos, ResourceAttributes,
};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::logs::v1::LogRecord;
use serde_json::{Map as JsonMap, Value as JsonValue};

type JsonObject = JsonMap<String, JsonValue>;

/// The drains whose events become logs here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventDrain {
    SpeedInsights,
    WebAnalytics,
    AuditLog,
}

impl EventDrain {
    /// The kind a `/v1/vercel/<segment>` route takes.
    pub fn from_path(segment: &str) -> Option<Self> {
        match segment {
            "speed-insights" => Some(Self::SpeedInsights),
            "web-analytics" => Some(Self::WebAnalytics),
            "audit-log" => Some(Self::AuditLog),
            _ => None,
        }
    }

    pub fn route(self) -> &'static str {
        match self {
            Self::SpeedInsights => "/v1/vercel/speed-insights",
            Self::WebAnalytics => "/v1/vercel/web-analytics",
            Self::AuditLog => "/v1/vercel/audit-log",
        }
    }

    /// The `maple_ingest_source` the gateway stamps on the drain's resources.
    pub fn ingest_source(self) -> &'static str {
        match self {
            Self::SpeedInsights => "vercel_speed_insights_drain",
            Self::WebAnalytics => "vercel_web_analytics_drain",
            Self::AuditLog => "vercel_audit_log_drain",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::SpeedInsights => "Speed Insights",
            Self::WebAnalytics => "Web Analytics",
            Self::AuditLog => "Audit Log",
        }
    }

    fn service_name(self) -> &'static str {
        match self {
            Self::SpeedInsights => "vercel-speed-insights",
            Self::WebAnalytics => "vercel-web-analytics",
            Self::AuditLog => "vercel-audit-log",
        }
    }
}

/// Visitor fields Speed Insights and Web Analytics events share.
const CLIENT_ATTRIBUTES: &[(&str, &str)] = &[
    ("path", "url.path"),
    ("route", "vercel.route"),
    ("origin", "vercel.origin"),
    ("vercelUrl", "vercel.url"),
    ("country", "geo.country.iso_code"),
    ("region", "geo.region.iso_code"),
    ("city", "geo.locality.name"),
    ("clientName", "user_agent.name"),
    ("clientVersion", "user_agent.version"),
    ("clientType", "vercel.client.type"),
    ("osName", "user_agent.os.name"),
    ("osVersion", "user_agent.os.version"),
    ("deviceType", "vercel.device.type"),
    ("deviceBrand", "device.manufacturer"),
    ("deviceModel", "device.model.name"),
    ("browserEngine", "vercel.browser_engine.name"),
    ("browserEngineVersion", "vercel.browser_engine.version"),
    ("sdkName", "vercel.sdk.name"),
    ("sdkVersion", "vercel.sdk.version"),
];

/// Every event of the delivery as an INFO record, grouped under its resource.
pub fn build_logs_request(
    drain: EventDrain,
    events: &[JsonObject],
    now_unix_nano: u64,
) -> ExportLogsServiceRequest {
    grouped_logs_request(
        match drain {
            EventDrain::SpeedInsights => "vercel.speed_insights_drain",
            EventDrain::WebAnalytics => "vercel.web_analytics_drain",
            EventDrain::AuditLog => "vercel.audit_log_drain",
        },
        events.iter().map(|event| {
            let (time, body, attributes) = match drain {
                EventDrain::SpeedInsights => speed_insight(event),
                EventDrain::WebAnalytics => web_analytics(event),
                EventDrain::AuditLog => audit_log(event),
            };
            let record = LogRecord {
                time_unix_nano: time.unwrap_or(now_unix_nano),
                observed_time_unix_nano: now_unix_nano,
                severity_number: 9,
                severity_text: "INFO".to_owned(),
                body: Some(AnyValue {
                    value: Some(any_value::Value::StringValue(body)),
                }),
                attributes,
                ..Default::default()
            };
            (resource_attributes(drain, event), record)
        }),
    )
}

fn resource_attributes(drain: EventDrain, event: &JsonObject) -> ResourceAttributes {
    let (team, deployment) = match drain {
        EventDrain::SpeedInsights => ("ownerId", "deploymentId"),
        EventDrain::WebAnalytics => ("ownerId", "deployment"),
        EventDrain::AuditLog => ("teamId", "deploymentId"),
    };
    let optional = [
        ("vercel.team.id", text(event, team)),
        ("vercel.project.id", text(event, "projectId")),
        ("vercel.deployment.id", text(event, deployment)),
        (
            "deployment.environment.name",
            text(event, "vercelEnvironment"),
        ),
    ];
    let mut attributes = vec![
        ("service.name", drain.service_name().to_owned()),
        ("cloud.provider", "vercel".to_owned()),
    ];
    attributes.extend(
        optional
            .into_iter()
            .filter_map(|(key, value)| Some((key, value?.to_owned()))),
    );
    attributes
}

type Mapped = (Option<u64>, String, Vec<KeyValue>);

/// `LCP 2.41s /dashboard`. The timestamp is an ISO string here, unlike the
/// other drains' epoch milliseconds.
fn speed_insight(event: &JsonObject) -> Mapped {
    let mut attributes = client_attributes(event, "vercel.speed_insights.device_id");
    let metric = text(event, "metricType");
    let value = event.get("value").and_then(JsonValue::as_f64);
    push(&mut attributes, "vercel.speed_insights.metric", metric);
    if let Some(value) = value {
        attributes.push(key_value(
            "vercel.speed_insights.value",
            any_value::Value::DoubleValue(value),
        ));
    }
    for (field, key) in [
        ("connectionSpeed", "vercel.speed_insights.connection_speed"),
        ("scriptVersion", "vercel.speed_insights.script_version"),
    ] {
        push(&mut attributes, key, text(event, field));
    }
    push_json(
        &mut attributes,
        "vercel.speed_insights.attribution",
        event,
        "attribution",
    );

    let time = text(event, "timestamp")
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .and_then(|time| u64::try_from(time.timestamp_nanos_opt()?).ok());
    let reading = value.map(|value| match metric {
        // Layout shift is a score; the others are milliseconds.
        Some("CLS") => format!("{value:.3}"),
        _ if value >= 1000.0 => format!("{:.2}s", value / 1000.0),
        _ => format!("{value:.0}ms"),
    });
    let body = [metric, reading.as_deref(), page(event)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    (time, body, attributes)
}

/// `pageview /pricing`, or `event Signup /pricing` for a custom event.
fn web_analytics(event: &JsonObject) -> Mapped {
    let mut attributes = client_attributes(event, "vercel.web_analytics.device_id");
    let event_type = text(event, "eventType");
    let event_name = text(event, "eventName");
    for (field, key) in [
        ("eventType", "vercel.web_analytics.event.type"),
        ("eventName", "vercel.web_analytics.event.name"),
        ("referrer", "http.request.header.referer"),
        ("queryParams", "url.query"),
    ] {
        push(&mut attributes, key, text(event, field));
    }
    push_json(
        &mut attributes,
        "vercel.web_analytics.event.data",
        event,
        "eventData",
    );
    push_json(
        &mut attributes,
        "vercel.web_analytics.flags",
        event,
        "flags",
    );

    let time = event.get("timestamp").and_then(timestamp_nanos);
    let body = [event_type, event_name, page(event)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    (time, body, attributes)
}

/// `drain-created by Test User`.
fn audit_log(event: &JsonObject) -> Mapped {
    let mut attributes = Vec::new();
    let action = text(event, "action");
    for (field, key) in [
        ("id", "vercel.audit.id"),
        ("action", "vercel.audit.action"),
        ("requestId", "vercel.request.id"),
        ("userAgent", "user_agent.original"),
        ("ipAddress", "client.address"),
        ("tokenId", "vercel.audit.token_id"),
    ] {
        push(&mut attributes, key, text(event, field));
    }
    let actor = event.get("actor").and_then(JsonValue::as_object);
    if let Some(actor) = actor {
        for (field, key) in [
            ("type", "vercel.audit.actor.type"),
            ("id", "vercel.audit.actor.id"),
            ("name", "vercel.audit.actor.name"),
            ("email", "vercel.audit.actor.email"),
        ] {
            push(&mut attributes, key, text(actor, field));
        }
    }
    push_json(&mut attributes, "vercel.audit.via", event, "via");
    push_json(&mut attributes, "vercel.audit.payload", event, "payload");

    let time = event.get("timestamp").and_then(timestamp_nanos);
    let who = actor.and_then(|actor| text(actor, "name").or_else(|| text(actor, "id")));
    let body = match (action, who) {
        (Some(action), Some(who)) => format!("{action} by {who}"),
        (Some(name), None) | (None, Some(name)) => name.to_owned(),
        (None, None) => "audit event".to_owned(),
    };
    (time, body, attributes)
}

fn client_attributes(event: &JsonObject, device_id_key: &str) -> Vec<KeyValue> {
    let mut attributes = Vec::new();
    for (field, key) in CLIENT_ATTRIBUTES {
        push(&mut attributes, key, text(event, field));
    }
    if let Some(device_id) = event.get("deviceId").and_then(JsonValue::as_i64) {
        attributes.push(key_value(
            device_id_key,
            any_value::Value::IntValue(device_id),
        ));
    }
    attributes
}

fn page(event: &JsonObject) -> Option<&str> {
    text(event, "path").or_else(|| text(event, "route"))
}

/// A field as a string attribute: a string as sent, any other value as JSON.
fn push_json(attributes: &mut Vec<KeyValue>, key: &str, event: &JsonObject, field: &str) {
    let value = match event.get(field) {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(value)) => Some(value.clone()),
        Some(value) => Some(value.to_string()),
    };
    push(attributes, key, value.as_deref().filter(|v| !v.is_empty()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vercel_logs::parse;
    use std::collections::HashMap;

    const NOW: u64 = 1_800_000_000_000_000_000;

    // Events with the fields the references list (2026-11-10).
    const SPEED_INSIGHT: &str = r#"{"schema":"vercel.speed_insights.v1","timestamp":"2023-09-14T15:30:00.000Z","projectId":"Qmc52npNy86S8VV4Mt8a8dP1LEkRNbgosW3pBCQytkcgf2","ownerId":"team_nLlpyC6REAqxydlFKbrMDlud","deviceId":12345,"metricType":"CLS","value":0.1,"origin":"https://example.com","path":"/dashboard/[id]","route":"/dashboard/[id]","country":"US","region":"CA","city":"San Francisco","osName":"Mac OS","osVersion":"10.15.7","clientName":"Chrome","clientType":"browser","clientVersion":"120.0.0","deviceType":"desktop","deviceBrand":"Apple","connectionSpeed":"4g","browserEngine":"Blink","browserEngineVersion":"120.0.0","scriptVersion":"1.0.0","sdkVersion":"1.1.0","sdkName":"@vercel/speed-insights","vercelEnvironment":"production","vercelUrl":"my-app-abc123.vercel.app","deploymentId":"dpl_2T8Uh5nRmTQ5gsSxKY7ySSzQFgsB","attribution":"div.hero > img"}"#;
    const PAGEVIEW: &str = r#"{"schema":"vercel.analytics.v2","eventType":"pageview","eventName":"","eventData":"","timestamp":1694723400000,"projectId":"prj_1","ownerId":"team_1","deviceId":12345,"origin":"https://example.com","path":"/pricing","referrer":"https://google.com","queryParams":"utm_source=google","route":"/pricing","country":"US","region":"CA","city":"San Francisco","osName":"Mac OS","osVersion":"10.15.7","clientName":"Chrome","clientType":"browser","clientVersion":"120.0.0","deviceType":"desktop","deviceBrand":"Apple","deviceModel":"Macintosh","browserEngine":"Blink","browserEngineVersion":"120.0.0","sdkVersion":"1.1.0","sdkName":"@vercel/analytics","sdkVersionFull":"1.1.0","vercelEnvironment":"production","vercelUrl":"my-app-abc123.vercel.app","flags":"{}","deployment":"dpl_1"}"#;
    const CUSTOM_EVENT: &str = r#"{"schema":"vercel.analytics.v2","eventType":"event","eventName":"Signup","eventData":"{\"plan\":\"pro\"}","timestamp":1694723400000,"projectId":"prj_1","path":"/pricing"}"#;
    const AUDIT_EVENT: &str = r#"{"schema":"vercel.audit_log.v1","id":"evt_1","teamId":"team_1","action":"drain-created","timestamp":1694723400000,"actor":{"type":"user","id":"usr_1","name":"Test User","email":"test@example.com"},"via":[{"type":"app","id":"app_1","name":"Maple"}],"requestId":"req_1","userAgent":"vercel-cli/32","ipAddress":"203.0.113.7","tokenId":"tok_1","payload":{"drainId":"drn_1","name":"Maple logs"}}"#;

    fn only_record(
        drain: EventDrain,
        payload: &str,
    ) -> (HashMap<String, any_value::Value>, LogRecord) {
        let request = build_logs_request(drain, &parse(payload.as_bytes()).unwrap().entries, NOW);
        let [resource_logs] = request.resource_logs.as_slice() else {
            panic!("one resource, got {}", request.resource_logs.len());
        };
        let [record] = resource_logs.scope_logs[0].log_records.as_slice() else {
            panic!("one record");
        };
        (
            values(&resource_logs.resource.as_ref().unwrap().attributes),
            record.clone(),
        )
    }

    fn values(attributes: &[KeyValue]) -> HashMap<String, any_value::Value> {
        attributes
            .iter()
            .filter_map(|attr| Some((attr.key.clone(), attr.value.clone()?.value?)))
            .collect()
    }

    fn string(value: &str) -> any_value::Value {
        any_value::Value::StringValue(value.to_owned())
    }

    fn body(record: &LogRecord) -> any_value::Value {
        record.body.clone().unwrap().value.unwrap()
    }

    #[test]
    fn each_drain_is_served_at_its_route() {
        for drain in [
            EventDrain::SpeedInsights,
            EventDrain::WebAnalytics,
            EventDrain::AuditLog,
        ] {
            let segment = drain.route().strip_prefix("/v1/vercel/").unwrap();
            assert_eq!(EventDrain::from_path(segment), Some(drain));
        }
        assert_eq!(EventDrain::from_path("ai-gateway"), None);
    }

    #[test]
    fn a_speed_insight_is_a_metric_reading_of_its_page() {
        let (resource, record) = only_record(EventDrain::SpeedInsights, SPEED_INSIGHT);
        assert_eq!(resource["service.name"], string("vercel-speed-insights"));
        assert_eq!(resource["cloud.provider"], string("vercel"));
        assert_eq!(
            resource["vercel.project.id"],
            string("Qmc52npNy86S8VV4Mt8a8dP1LEkRNbgosW3pBCQytkcgf2")
        );
        assert_eq!(
            resource["vercel.deployment.id"],
            string("dpl_2T8Uh5nRmTQ5gsSxKY7ySSzQFgsB")
        );
        assert_eq!(
            resource["deployment.environment.name"],
            string("production")
        );
        assert_eq!(record.time_unix_nano, 1_694_705_400_000_000_000);
        assert_eq!(body(&record), string("CLS 0.100 /dashboard/[id]"));
        let attributes = values(&record.attributes);
        assert_eq!(attributes["vercel.speed_insights.metric"], string("CLS"));
        assert_eq!(
            attributes["vercel.speed_insights.value"],
            any_value::Value::DoubleValue(0.1)
        );
        assert_eq!(
            attributes["vercel.speed_insights.device_id"],
            any_value::Value::IntValue(12345)
        );
        assert_eq!(attributes["url.path"], string("/dashboard/[id]"));
        assert_eq!(attributes["geo.country.iso_code"], string("US"));
        assert_eq!(attributes["user_agent.name"], string("Chrome"));
        assert_eq!(
            attributes["vercel.speed_insights.attribution"],
            string("div.hero > img")
        );
    }

    #[test]
    fn timings_read_in_seconds_or_milliseconds() {
        let reading = |metric: &str, value: f64| {
            let event = format!(r#"{{"metricType":"{metric}","value":{value},"path":"/a"}}"#);
            body(&only_record(EventDrain::SpeedInsights, &event).1)
        };
        assert_eq!(reading("LCP", 2410.0), string("LCP 2.41s /a"));
        assert_eq!(reading("TTFB", 182.4), string("TTFB 182ms /a"));
    }

    #[test]
    fn a_pageview_and_a_custom_event_keep_their_fields() {
        let (resource, record) = only_record(EventDrain::WebAnalytics, PAGEVIEW);
        assert_eq!(resource["service.name"], string("vercel-web-analytics"));
        assert_eq!(resource["vercel.deployment.id"], string("dpl_1"));
        assert_eq!(resource["vercel.team.id"], string("team_1"));
        assert_eq!(record.time_unix_nano, 1_694_723_400_000_000_000);
        assert_eq!(body(&record), string("pageview /pricing"));
        let attributes = values(&record.attributes);
        assert_eq!(
            attributes["vercel.web_analytics.event.type"],
            string("pageview")
        );
        assert_eq!(
            attributes["http.request.header.referer"],
            string("https://google.com")
        );
        assert_eq!(attributes["url.query"], string("utm_source=google"));
        assert_eq!(attributes["device.model.name"], string("Macintosh"));
        assert_eq!(
            attributes["vercel.web_analytics.device_id"],
            any_value::Value::IntValue(12345)
        );
        assert!(!attributes.contains_key("vercel.web_analytics.event.name"));

        let (_, record) = only_record(EventDrain::WebAnalytics, CUSTOM_EVENT);
        assert_eq!(body(&record), string("event Signup /pricing"));
        assert_eq!(
            values(&record.attributes)["vercel.web_analytics.event.data"],
            string(r#"{"plan":"pro"}"#)
        );
    }

    #[test]
    fn an_audit_event_names_its_action_and_actor() {
        let (resource, record) = only_record(EventDrain::AuditLog, AUDIT_EVENT);
        assert_eq!(resource["service.name"], string("vercel-audit-log"));
        assert_eq!(resource["vercel.team.id"], string("team_1"));
        assert!(!resource.contains_key("vercel.project.id"));
        assert_eq!(record.time_unix_nano, 1_694_723_400_000_000_000);
        assert_eq!(record.severity_text, "INFO");
        assert_eq!(body(&record), string("drain-created by Test User"));
        let attributes = values(&record.attributes);
        assert_eq!(attributes["vercel.audit.action"], string("drain-created"));
        assert_eq!(attributes["vercel.audit.actor.type"], string("user"));
        assert_eq!(
            attributes["vercel.audit.actor.email"],
            string("test@example.com")
        );
        assert_eq!(attributes["client.address"], string("203.0.113.7"));
        assert_eq!(attributes["user_agent.original"], string("vercel-cli/32"));
        assert_eq!(
            attributes["vercel.audit.via"],
            string(r#"[{"id":"app_1","name":"Maple","type":"app"}]"#)
        );
        assert_eq!(
            attributes["vercel.audit.payload"],
            string(r#"{"drainId":"drn_1","name":"Maple logs"}"#)
        );
    }

    #[test]
    fn events_group_by_resource_in_one_delivery() {
        let delivery = format!(
            "{PAGEVIEW}\n{PAGEVIEW}\n{}",
            PAGEVIEW.replace("prj_1", "prj_2")
        );
        let request = build_logs_request(
            EventDrain::WebAnalytics,
            &parse(delivery.as_bytes()).unwrap().entries,
            NOW,
        );
        let records: Vec<usize> = request
            .resource_logs
            .iter()
            .map(|resource| resource.scope_logs[0].log_records.len())
            .collect();
        assert_eq!(records, [2, 1]);
        assert!(build_logs_request(EventDrain::AuditLog, &[], NOW)
            .resource_logs
            .is_empty());
    }
}
