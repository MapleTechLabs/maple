//! Cloudflare AI Gateway's OTLP export, restated as the `gen_ai.*` shapes
//! Agent Sessions reads.
//!
//! The gateway emits one `cf.aig.request` span per proxied call, under scope
//! `ai` (the Vercel AI SDK's scope name, which is why detection keys on the
//! span name) and `service.name=ai-gateway`. Its `gen_ai.input.messages` and
//! `gen_ai.output.messages` hold the provider's raw request and response
//! bodies rather than message lists, so a transcript would show one JSON blob
//! per call. This module rewrites the two keys into message lists and lifts
//! the request and response fields beside them (tools, max tokens, response
//! id and model, finish reasons) onto their own `gen_ai.*` keys. A body it
//! does not recognise is left exactly as sent.
//!
//! Caller metadata (`cf-aig-metadata`) arrives as bare span attributes, and
//! the gateway drops any key starting with `gen_ai.`, so a session id comes
//! from `session_id` or `conversation_id`. Embedding calls are reported as
//! `chat`; the response shape gives them away and the operation is corrected.

use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::trace::v1::Span;
use serde_json::{json, Map, Value};

pub(super) const VENDOR_ID: &str = "cloudflare_ai_gateway";
pub(super) const SPAN_NAME: &str = "cf.aig.request";
pub(super) const SESSION_KEYS: &[&str] =
    &["gen_ai.conversation.id", "session_id", "conversation_id"];

const INPUT: &str = "gen_ai.input.messages";
const OUTPUT: &str = "gen_ai.output.messages";
const OPERATION: &str = "gen_ai.operation.name";

/// Restate one `cf.aig.request` span's raw bodies as `gen_ai.*` keys.
pub(super) fn normalize(span: &mut Span) {
    let request = json_text(&span.attributes, INPUT);
    let response = json_text(&span.attributes, OUTPUT);
    let mut added: Vec<(&'static str, String)> = Vec::new();

    if let Some(Value::Object(request)) = &request {
        if let Some(messages) = request_messages(request) {
            replace(&mut span.attributes, INPUT, messages.to_string());
        }
        if let Some(system) = request.get("system").and_then(system_instructions) {
            added.push(("gen_ai.system_instructions", system.to_string()));
        }
        if let Some(tools) = request.get("tools").filter(|tools| non_empty_array(tools)) {
            added.push(("gen_ai.tool.definitions", tools.to_string()));
        }
        for (field, key) in [
            ("max_tokens", "gen_ai.request.max_tokens"),
            ("temperature", "gen_ai.request.temperature"),
            ("top_p", "gen_ai.request.top_p"),
            ("stream", "gen_ai.request.stream"),
        ] {
            if let Some(value) = request.get(field).and_then(scalar_text) {
                added.push((key, value));
            }
        }
    }

    if let Some(Value::Object(response)) = &response {
        if is_embedding(response) {
            replace(&mut span.attributes, OPERATION, "embeddings".to_owned());
        } else if let Some(reply) = response_reply(response) {
            replace(&mut span.attributes, OUTPUT, reply.messages.to_string());
            if !reply.finish_reasons.is_empty() {
                added.push((
                    "gen_ai.response.finish_reasons",
                    Value::from(reply.finish_reasons).to_string(),
                ));
            }
            if let Some(id) = reply.id {
                added.push(("gen_ai.response.id", id));
            }
            if let Some(model) = reply.model {
                added.push(("gen_ai.response.model", model));
            }
        }
    }

    for (key, value) in added {
        if !span.attributes.iter().any(|attr| attr.key == key) {
            span.attributes.push(owned(key, value));
        }
    }
}

/// The message list a request body carries: OpenAI and Anthropic `messages`,
/// or a Workers AI bare `prompt`.
fn request_messages(request: &Map<String, Value>) -> Option<Value> {
    match (request.get("messages"), request.get("prompt")) {
        (Some(messages @ Value::Array(_)), _) => Some(messages.clone()),
        (None, Some(Value::String(prompt))) => Some(json!([{ "role": "user", "content": prompt }])),
        _ => None,
    }
}

/// Anthropic's top-level `system`: a string or a list of text blocks.
fn system_instructions(system: &Value) -> Option<Value> {
    match system {
        Value::String(text) if !text.is_empty() => {
            Some(json!([{ "type": "text", "content": text }]))
        }
        Value::Array(blocks) if !blocks.is_empty() => Some(system.clone()),
        _ => None,
    }
}

/// Workers AI embeddings answer `{ data: [[f32...]] }`; OpenAI's answer
/// `{ object: "list", data: [{ embedding }] }`.
fn is_embedding(response: &Map<String, Value>) -> bool {
    let Some(Value::Array(data)) = response.get("data") else {
        return false;
    };
    !response.contains_key("choices")
        && data.first().is_some_and(|first| {
            first.is_array() || first.get("embedding").is_some_and(Value::is_array)
        })
}

struct Reply {
    messages: Value,
    finish_reasons: Vec<String>,
    id: Option<String>,
    model: Option<String>,
}

fn response_reply(response: &Map<String, Value>) -> Option<Reply> {
    if let Some(Value::Array(choices)) = response.get("choices") {
        if choices.iter().any(|choice| choice.get("delta").is_some()) {
            return Some(streamed_reply(response, choices));
        }
        let mut finish_reasons = Vec::new();
        let messages: Vec<Value> = choices
            .iter()
            .filter_map(|choice| {
                if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                    finish_reasons.push(reason.to_owned());
                }
                choice
                    .get("message")
                    .and_then(Value::as_object)
                    .map(message)
            })
            .collect();
        if messages.is_empty() {
            return None;
        }
        return Some(Reply {
            messages: Value::Array(messages),
            finish_reasons,
            id: string_field(response, "id"),
            model: string_field(response, "model"),
        });
    }
    // Anthropic Messages: the response is itself the assistant message.
    if let Some(Value::Array(_)) = response.get("content") {
        return Some(Reply {
            messages: json!([message(response)]),
            finish_reasons: string_field(response, "stop_reason").into_iter().collect(),
            id: string_field(response, "id"),
            model: string_field(response, "model"),
        });
    }
    None
}

/// The parts of a reply message a transcript shows; drops provider noise
/// (`annotations`, `audio`, `logprobs`, ...).
fn message(source: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    out.insert(
        "role".to_owned(),
        source
            .get("role")
            .cloned()
            .unwrap_or_else(|| json!("assistant")),
    );
    out.insert(
        "content".to_owned(),
        source.get("content").cloned().unwrap_or(Value::Null),
    );
    if let Some(calls) = source
        .get("tool_calls")
        .filter(|calls| non_empty_array(calls))
    {
        out.insert("tool_calls".to_owned(), calls.clone());
    }
    Value::Object(out)
}

/// A streamed reply arrives as every chunk the gateway relayed: bare deltas,
/// then whole `chat.completion.chunk` objects, then a usage trailer. The text
/// and tool-call fragments are joined back into the one message they made.
fn streamed_reply(response: &Map<String, Value>, choices: &[Value]) -> Reply {
    let mut text = String::new();
    let mut calls: Vec<Map<String, Value>> = Vec::new();
    let mut finish_reasons = Vec::new();
    let mut id = string_field(response, "id");
    let mut model = string_field(response, "model");

    let mut absorb = |choice: &Value| {
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            finish_reasons.push(reason.to_owned());
        }
        let Some(delta) = choice.get("delta") else {
            return;
        };
        if let Some(piece) = delta.get("content").and_then(Value::as_str) {
            text.push_str(piece);
        }
        for fragment in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            merge_tool_call(&mut calls, fragment);
        }
    };
    for entry in choices {
        absorb(entry);
        // A whole chunk object nests its own `choices`.
        for nested in entry
            .get("choices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            absorb(nested);
        }
        if let Some(chunk) = entry.as_object() {
            id = id.or_else(|| string_field(chunk, "id"));
            model = model.or_else(|| string_field(chunk, "model"));
        }
    }

    let mut out = Map::new();
    out.insert("role".to_owned(), json!("assistant"));
    out.insert(
        "content".to_owned(),
        if text.is_empty() {
            Value::Null
        } else {
            Value::String(text)
        },
    );
    if !calls.is_empty() {
        out.insert(
            "tool_calls".to_owned(),
            Value::Array(calls.into_iter().map(Value::Object).collect()),
        );
    }
    finish_reasons.dedup();
    Reply {
        messages: json!([Value::Object(out)]),
        finish_reasons,
        id,
        model,
    }
}

/// OpenAI streams a tool call as fragments sharing an `index`; the first holds
/// the id and name, every one adds to `function.arguments`.
fn merge_tool_call(calls: &mut Vec<Map<String, Value>>, fragment: &Value) {
    let index = fragment.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
    while calls.len() <= index {
        calls.push(Map::new());
    }
    let call = &mut calls[index];
    for field in ["id", "type"] {
        if let Some(value) = fragment.get(field).filter(|value| value.is_string()) {
            call.entry(field).or_insert_with(|| value.clone());
        }
    }
    let Some(function) = fragment.get("function") else {
        return;
    };
    let target = call
        .entry("function")
        .or_insert_with(|| json!({ "name": null, "arguments": "" }));
    if let Some(name) = function.get("name").filter(|name| name.is_string()) {
        target["name"] = name.clone();
    }
    if let Some(piece) = function.get("arguments").and_then(Value::as_str) {
        let joined = format!("{}{piece}", target["arguments"].as_str().unwrap_or(""));
        target["arguments"] = Value::String(joined);
    }
}

fn non_empty_array(value: &Value) -> bool {
    value.as_array().is_some_and(|items| !items.is_empty())
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// The string attribute under `key`, parsed as JSON.
fn json_text(attrs: &[KeyValue], key: &str) -> Option<Value> {
    let attr = attrs.iter().find(|attr| attr.key == key)?;
    match attr.value.as_ref()?.value.as_ref()? {
        any_value::Value::StringValue(text) => serde_json::from_str(text).ok(),
        _ => None,
    }
}

fn replace(attrs: &mut [KeyValue], key: &str, value: String) {
    if let Some(attr) = attrs.iter_mut().find(|attr| attr.key == key) {
        attr.value = Some(AnyValue {
            value: Some(any_value::Value::StringValue(value)),
        });
    }
}

fn owned(key: &str, value: String) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        key_strindex: 0,
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value)),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::super::stamp_trace_request;
    use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
    use opentelemetry_proto::tonic::common::v1::any_value;
    use serde_json::Value;
    use std::collections::HashMap;

    /// Captured verbatim from a gateway's OTLP/JSON exporter (Workers AI).
    fn stamped(fixture: &str) -> HashMap<String, String> {
        let mut json: Value = serde_json::from_str(fixture).unwrap();
        crate::otlp_json::normalize(&mut json, "resourceSpans");
        let mut request: ExportTraceServiceRequest = serde_json::from_value(json).unwrap();
        stamp_trace_request(&mut request);
        let span = &request.resource_spans[0].scope_spans[0].spans[0];
        span.attributes
            .iter()
            .filter_map(|attr| {
                let text = match attr.value.as_ref()?.value.as_ref()? {
                    any_value::Value::StringValue(text) => text.clone(),
                    any_value::Value::IntValue(int) => int.to_string(),
                    any_value::Value::DoubleValue(double) => double.to_string(),
                    any_value::Value::BoolValue(flag) => flag.to_string(),
                    _ => return None,
                };
                Some((attr.key.clone(), text))
            })
            .collect()
    }

    fn parsed(attrs: &HashMap<String, String>, key: &str) -> Value {
        serde_json::from_str(&attrs[key]).unwrap()
    }

    #[test]
    fn plain_chat_is_a_session_llm_call_with_message_lists() {
        let attrs = stamped(include_str!(
            "__fixtures__/cloudflare_ai_gateway/plain.json"
        ));
        assert_eq!(attrs["maple_ai.vendor.id"], "cloudflare_ai_gateway");
        assert_eq!(attrs["maple_ai.session.id"], "aig-capture-mv5u4jzp");
        assert_eq!(attrs["maple_ai.llm_call"], "1");
        assert_eq!(attrs["maple_ai.usage.input_tokens"], "41");
        assert_eq!(attrs["maple_ai.usage.output_tokens"], "4");
        assert_eq!(
            parsed(&attrs, "gen_ai.input.messages"),
            serde_json::json!([{ "role": "user", "content": "Say hi in three words." }])
        );
        assert_eq!(
            parsed(&attrs, "gen_ai.output.messages"),
            serde_json::json!([{ "role": "assistant", "content": "Hello to you" }])
        );
        assert_eq!(attrs["gen_ai.request.max_tokens"], "32");
        assert_eq!(attrs["gen_ai.response.finish_reasons"], r#"["stop"]"#);
        assert_eq!(
            attrs["gen_ai.response.id"],
            "chatcmpl-c0407e2e-ae4b-44a8-b9a2-173d8b7678b4"
        );
        assert_eq!(
            attrs["gen_ai.response.model"],
            "@cf/meta/llama-3.3-70b-instruct-sd"
        );
    }

    #[test]
    fn multi_turn_history_keeps_every_role() {
        let attrs = stamped(include_str!(
            "__fixtures__/cloudflare_ai_gateway/turn-2-same-session.json"
        ));
        let roles: Vec<String> = parsed(&attrs, "gen_ai.input.messages")
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["role"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(roles, ["system", "user", "assistant", "user"]);
        assert_eq!(attrs["maple_ai.session.id"], "aig-capture-mv5u4jzp");
    }

    #[test]
    fn streamed_chunks_join_into_one_reply() {
        let attrs = stamped(include_str!(
            "__fixtures__/cloudflare_ai_gateway/stream.json"
        ));
        assert_eq!(
            parsed(&attrs, "gen_ai.output.messages"),
            serde_json::json!([{ "role": "assistant", "content": "1, 2, 3, 4, 5." }])
        );
        assert_eq!(attrs["gen_ai.request.stream"], "true");
        assert_eq!(attrs["gen_ai.response.finish_reasons"], r#"["stop"]"#);
        assert_eq!(
            attrs["gen_ai.response.id"],
            "chatcmpl-d5e27b50-594e-482f-b9dc-8c199ec81b94"
        );
    }

    #[test]
    fn tool_call_reply_and_definitions_are_lifted() {
        let attrs = stamped(include_str!(
            "__fixtures__/cloudflare_ai_gateway/tool-call.json"
        ));
        let output = parsed(&attrs, "gen_ai.output.messages");
        assert_eq!(output[0]["content"], Value::Null);
        assert_eq!(
            output[0]["tool_calls"][0]["function"]["name"],
            "get_weather"
        );
        assert_eq!(
            output[0]["tool_calls"][0]["function"]["arguments"],
            r#"{"city": "Paris"}"#
        );
        assert_eq!(
            parsed(&attrs, "gen_ai.tool.definitions")[0]["name"],
            "get_weather"
        );
        assert_eq!(attrs["gen_ai.response.finish_reasons"], r#"["tool_calls"]"#);
    }

    #[test]
    fn embeddings_are_not_chat() {
        let attrs = stamped(include_str!(
            "__fixtures__/cloudflare_ai_gateway/embedding.json"
        ));
        assert_eq!(attrs["gen_ai.operation.name"], "embeddings");
        assert_eq!(attrs["maple_ai.vendor.id"], "cloudflare_ai_gateway");
        // The vectors stay as sent; there is no reply to restate.
        assert!(attrs["gen_ai.output.messages"].starts_with(r#"{"data":[["#));
    }
}
