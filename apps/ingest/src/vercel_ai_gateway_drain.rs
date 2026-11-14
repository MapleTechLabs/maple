//! A Vercel AI Gateway drain delivery (a JSON array or NDJSON of
//! `vercel.ai_gateway.v1` events) to an OTLP traces request.
//!
//! The gateway's usage reaches Maple only through a drain of the AI Gateway
//! data type, never through a trace drain. It sends two events:
//!
//! - `request`, one per gateway call: model, provider, tokens, cost, timing.
//!   It becomes the server span `<operation> <model>` on resource
//!   `service.name=ai-gateway`, `service.namespace=vercel`, the span the AI
//!   Gateway views and Agent Sessions read.
//! - `provider_attempt`, one per upstream try. It becomes a client span
//!   `<model> (<provider>)` under the request span, so failovers show.
//!
//! The events carry no trace context. Both kinds name the call's
//! `generationId`, so the trace id is derived from it and a request and its
//! attempts land in one trace even when they arrive in different deliveries.

use crate::vercel_logs::{attribute, key_value, push, text, timestamp_nanos};
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{
    any_value, AnyValue, ArrayValue, InstrumentationScope, KeyValue,
};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{
    span::SpanKind, status::StatusCode, ResourceSpans, ScopeSpans, Span, Status,
};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};

/// The `maple_ingest_source` the gateway stamps on a drain's resources.
pub const INGEST_SOURCE: &str = "vercel_ai_gateway_drain";

type JsonObject = JsonMap<String, JsonValue>;

/// Every event of the delivery as a span under one `ai-gateway` resource.
/// Events of another type, or without a `generationId`, are skipped.
pub fn build_traces_request(events: &[JsonObject]) -> ExportTraceServiceRequest {
    let spans: Vec<Span> = events
        .iter()
        .filter_map(|event| match text(event, "eventType")? {
            "request" => request_span(event),
            "provider_attempt" => attempt_span(event),
            _ => None,
        })
        .collect();
    if spans.is_empty() {
        return ExportTraceServiceRequest::default();
    }
    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(Resource {
                attributes: vec![
                    attribute("service.name", "ai-gateway"),
                    attribute("service.namespace", "vercel"),
                    attribute("cloud.provider", "vercel"),
                ],
                ..Default::default()
            }),
            scope_spans: vec![ScopeSpans {
                scope: Some(InstrumentationScope {
                    name: "vercel.ai_gateway_drain".to_owned(),
                    ..Default::default()
                }),
                spans,
                schema_url: String::new(),
            }],
            schema_url: String::new(),
        }],
    }
}

fn request_span(event: &JsonObject) -> Option<Span> {
    let generation_id = text(event, "generationId")?;
    let model = text(event, "model").or_else(|| text(event, "requestedModelSlug"));
    let operation = match text(event, "modelType") {
        None | Some("language") => "chat",
        Some("embedding") => "embeddings",
        Some(other) => other,
    };
    // `gatewayTimestamp` is when the gateway logged the finished request.
    let end = millis(event, "gatewayTimestamp").or_else(|| millis(event, "timestamp"))?;
    let duration = duration_nanos(event, "requestDurationMs");
    let status_code = int(event, "responseStatusCode");

    let mut attributes = vec![attribute("gen_ai.operation.name", operation)];
    push(
        &mut attributes,
        "gen_ai.provider.name",
        text(event, "provider"),
    );
    push(
        &mut attributes,
        "gen_ai.request.model",
        text(event, "requestedModelSlug").or(model),
    );
    push(&mut attributes, "gen_ai.response.model", model);
    push_usage(&mut attributes, event);
    if let Some(reason) = text(event, "finishReason") {
        attributes.push(key_value(
            "gen_ai.response.finish_reasons",
            any_value::Value::ArrayValue(ArrayValue {
                values: vec![AnyValue {
                    value: Some(any_value::Value::StringValue(reason.to_owned())),
                }],
            }),
        ));
    }
    if let Some(ttft) = event.get("timeToFirstTokenMs").and_then(JsonValue::as_f64) {
        attributes.push(key_value(
            "gen_ai.response.time_to_first_chunk",
            any_value::Value::DoubleValue(ttft / 1000.0),
        ));
    }
    if let Some(streaming) = event.get("isStreaming").and_then(JsonValue::as_bool) {
        attributes.push(key_value(
            "gen_ai.request.stream",
            any_value::Value::BoolValue(streaming),
        ));
    }
    if let Some(status) = status_code {
        push_int(&mut attributes, "http.response.status_code", status);
    }
    for (field, key) in [
        ("cost", "vercel.ai_gateway.cost.total"),
        ("costCurrency", "vercel.ai_gateway.cost.currency"),
        ("marketCost", "vercel.ai_gateway.market_cost.total"),
        ("provider", "vercel.ai_gateway.provider"),
        ("gatewayRequestId", "vercel.ai_gateway.request.id"),
        ("generationId", "vercel.ai_gateway.generation.id"),
        ("requestApiFormat", "vercel.ai_gateway.api_format"),
        ("projectId", "vercel.project.id"),
        ("deploymentId", "vercel.deployment.id"),
        ("environment", "deployment.environment.name"),
        ("region", "cloud.region"),
        ("userAgent", "user_agent.original"),
    ] {
        push(&mut attributes, key, text(event, field));
    }
    if let Some(byok) = event.get("isByok").and_then(JsonValue::as_bool) {
        attributes.push(attribute(
            "vercel.ai_gateway.credential.type",
            if byok { "byok" } else { "system" },
        ));
    }

    Some(Span {
        trace_id: id_bytes(generation_id, "trace", 16),
        span_id: id_bytes(generation_id, "request", 8),
        name: model.map_or_else(
            || operation.to_owned(),
            |model| format!("{operation} {model}"),
        ),
        kind: SpanKind::Server as i32,
        start_time_unix_nano: end.saturating_sub(duration),
        end_time_unix_nano: end,
        attributes,
        // A server span is an error only for a 5xx.
        status: status_code
            .filter(|status| *status >= 500)
            .map(|status| Status {
                message: format!("AI Gateway responded {status}"),
                code: StatusCode::Error as i32,
            }),
        ..Default::default()
    })
}

/// Token counts. The event's `inputTokens` leaves out cached tokens; OTel's
/// input count includes them.
fn push_usage(attributes: &mut Vec<KeyValue>, event: &JsonObject) {
    let cached = int(event, "cachedInputTokens").unwrap_or(0);
    let cache_creation = int(event, "cacheCreationInputTokens").unwrap_or(0);
    if let Some(input) = int(event, "inputTokens") {
        push_int(
            attributes,
            "gen_ai.usage.input_tokens",
            input + cached + cache_creation,
        );
    }
    if cached > 0 {
        push_int(attributes, "gen_ai.usage.cache_read.input_tokens", cached);
    }
    if cache_creation > 0 {
        push_int(
            attributes,
            "gen_ai.usage.cache_creation.input_tokens",
            cache_creation,
        );
    }
    if let Some(output) = int(event, "outputTokens") {
        push_int(attributes, "gen_ai.usage.output_tokens", output);
    }
    if let Some(reasoning) = int(event, "reasoningTokens").filter(|tokens| *tokens > 0) {
        push_int(
            attributes,
            "gen_ai.usage.reasoning.output_tokens",
            reasoning,
        );
    }
}

fn attempt_span(event: &JsonObject) -> Option<Span> {
    let generation_id = text(event, "generationId")?;
    let attempt_id = text(event, "providerAttemptId")?;
    let end = millis(event, "timestamp")?;
    let duration = duration_nanos(event, "responseTimeMs");
    let model = text(event, "canonicalSlug");
    let provider = text(event, "provider");
    let status_code = int(event, "statusCode");

    let mut attributes = Vec::new();
    push(&mut attributes, "gen_ai.provider.name", provider);
    push(&mut attributes, "gen_ai.request.model", model);
    push(
        &mut attributes,
        "gen_ai.response.id",
        text(event, "providerResponseId"),
    );
    if let Some(status) = status_code {
        push_int(&mut attributes, "http.response.status_code", status);
    }
    if let Some(attempt) = int(event, "attemptNumber") {
        push_int(&mut attributes, "vercel.ai_gateway.attempt.number", attempt);
    }
    for (field, key) in [
        ("credentialType", "vercel.ai_gateway.credential.type"),
        ("providerRequestId", "vercel.ai_gateway.provider_request.id"),
        ("projectId", "vercel.project.id"),
        ("region", "cloud.region"),
    ] {
        push(&mut attributes, key, text(event, field));
    }
    let failed = event.get("success").and_then(JsonValue::as_bool) == Some(false);
    let short_model = model.map(|slug| slug.rsplit('/').next().unwrap_or(slug));

    Some(Span {
        trace_id: id_bytes(generation_id, "trace", 16),
        span_id: id_bytes(attempt_id, "attempt", 8),
        parent_span_id: id_bytes(generation_id, "request", 8),
        name: match (short_model, provider) {
            (Some(model), Some(provider)) => format!("{model} ({provider})"),
            (Some(name), None) | (None, Some(name)) => name.to_owned(),
            (None, None) => "provider attempt".to_owned(),
        },
        kind: SpanKind::Client as i32,
        start_time_unix_nano: end.saturating_sub(duration),
        end_time_unix_nano: end,
        attributes,
        status: failed.then(|| Status {
            message: status_code.map_or_else(
                || "Provider attempt failed".to_owned(),
                |status| format!("Provider responded {status}"),
            ),
            code: StatusCode::Error as i32,
        }),
        ..Default::default()
    })
}

/// A stable id from a gateway id, so every delivery that names it agrees.
fn id_bytes(source: &str, purpose: &str, len: usize) -> Vec<u8> {
    let digest = Sha256::new()
        .chain_update(purpose.as_bytes())
        .chain_update([0])
        .chain_update(source.as_bytes())
        .finalize();
    digest[..len].to_vec()
}

fn millis(event: &JsonObject, key: &str) -> Option<u64> {
    event.get(key).and_then(timestamp_nanos)
}

fn int(event: &JsonObject, key: &str) -> Option<i64> {
    event.get(key)?.as_i64()
}

/// A whole-millisecond duration as nanoseconds; absent or negative is zero.
fn duration_nanos(event: &JsonObject, key: &str) -> u64 {
    event
        .get(key)
        .and_then(JsonValue::as_u64)
        .map_or(0, |ms| ms.saturating_mul(1_000_000))
}

fn push_int(attributes: &mut Vec<KeyValue>, key: &str, value: i64) {
    attributes.push(key_value(key, any_value::Value::IntValue(value)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vercel_logs::parse;
    use std::collections::HashMap;

    // A delivery as Vercel sent it (2026-11-10), one request and its attempt.
    const DELIVERY: &str = r#"[
      {"schema":"vercel.ai_gateway.v1","eventType":"provider_attempt","timestamp":1794307649655,"ownerId":"team_1","projectId":"prj_1","generationId":"gen_1","gatewayRequestId":"iad1::a","providerAttemptId":"gen_1:0:1","modelAttemptIndex":0,"canonicalSlug":"openai/gpt-4o-mini","attemptNumber":1,"provider":"openai","credentialType":"system","success":true,"statusCode":200,"responseTimeMs":1231,"providerRequestId":"req_1","providerResponseId":"resp_1","region":"iad1"},
      {"schema":"vercel.ai_gateway.v1","eventType":"request","ownerId":"team_1","projectId":"prj_1","deploymentId":"dpl_1","gatewayRequestId":"iad1::a","generationId":"gen_1","cost":"0.00022785","costCurrency":"USD","gatewayTimestamp":1794307651806,"timeToFirstTokenMs":853,"requestDurationMs":1315,"responseStatusCode":200,"isByok":false,"isStreaming":true,"finishReason":"tool-calls","provider":"openai","model":"openai/gpt-4o-mini","requestedModelSlug":"openai/gpt-4o-mini","modelType":"language","inputTokens":107,"cachedInputTokens":2560,"cacheCreationInputTokens":0,"outputTokens":33,"reasoningTokens":0,"region":"iad1","environment":"production"}
    ]"#;

    fn spans(payload: &str) -> Vec<Span> {
        let request = build_traces_request(&parse(payload.as_bytes()).unwrap().entries);
        request
            .resource_spans
            .into_iter()
            .flat_map(|resource| resource.scope_spans)
            .flat_map(|scope| scope.spans)
            .collect()
    }

    fn values(span: &Span) -> HashMap<&str, any_value::Value> {
        span.attributes
            .iter()
            .filter_map(|attr| Some((attr.key.as_str(), attr.value.clone()?.value?)))
            .collect()
    }

    fn string(value: &str) -> any_value::Value {
        any_value::Value::StringValue(value.to_owned())
    }

    #[test]
    fn a_request_and_its_attempt_become_one_trace() {
        let spans = spans(DELIVERY);
        let [attempt, request] = spans.as_slice() else {
            panic!("two spans, got {}", spans.len());
        };
        assert_eq!(request.name, "chat openai/gpt-4o-mini");
        assert_eq!(request.kind, SpanKind::Server as i32);
        assert_eq!(attempt.name, "gpt-4o-mini (openai)");
        assert_eq!(attempt.kind, SpanKind::Client as i32);
        assert_eq!(attempt.trace_id, request.trace_id);
        assert_eq!(attempt.parent_span_id, request.span_id);
        assert_eq!(request.end_time_unix_nano, 1_794_307_651_806_000_000);
        assert_eq!(
            request.end_time_unix_nano - request.start_time_unix_nano,
            1_315_000_000
        );
        assert_eq!(request.status, None);
    }

    #[test]
    fn the_request_span_carries_usage_and_cost() {
        let spans = spans(DELIVERY);
        let request = values(&spans[1]);
        assert_eq!(
            request["vercel.ai_gateway.cost.total"],
            string("0.00022785")
        );
        assert_eq!(request["vercel.ai_gateway.cost.currency"], string("USD"));
        assert_eq!(request["vercel.project.id"], string("prj_1"));
        assert_eq!(request["gen_ai.provider.name"], string("openai"));
        // Cached tokens count toward the input, as OTel defines it.
        assert_eq!(
            request["gen_ai.usage.input_tokens"],
            any_value::Value::IntValue(2667)
        );
        assert_eq!(
            request["gen_ai.usage.cache_read.input_tokens"],
            any_value::Value::IntValue(2560)
        );
        assert_eq!(
            request["gen_ai.usage.output_tokens"],
            any_value::Value::IntValue(33)
        );
        assert_eq!(
            request["gen_ai.response.time_to_first_chunk"],
            any_value::Value::DoubleValue(0.853)
        );
        assert!(!request.contains_key("gen_ai.usage.reasoning.output_tokens"));
        assert_eq!(values(&spans[0])["gen_ai.response.id"], string("resp_1"));
    }

    #[test]
    fn a_failed_request_is_an_error_only_for_a_5xx() {
        let request = |status: i64| {
            format!(
                r#"[{{"eventType":"request","generationId":"gen_{status}","gatewayTimestamp":1794307651806,"responseStatusCode":{status},"model":"openai/gpt-4o-mini"}}]"#
            )
        };
        assert_eq!(spans(&request(429))[0].status, None);
        assert_eq!(
            spans(&request(502))[0]
                .status
                .as_ref()
                .map(|status| status.code),
            Some(StatusCode::Error as i32)
        );
    }

    #[test]
    fn unknown_events_and_the_test_delivery_are_no_spans() {
        assert!(build_traces_request(&parse(b"[]").unwrap().entries)
            .resource_spans
            .is_empty());
        assert!(spans(r#"[{"eventType":"something_new","generationId":"gen_1"}]"#).is_empty());
        assert!(spans(r#"[{"eventType":"request","gatewayTimestamp":1}]"#).is_empty());
    }
}
