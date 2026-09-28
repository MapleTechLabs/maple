//! Transcript content an emitter records as span events, restated as the
//! `gen_ai.*` attributes Agent Sessions reads.
//!
//! Every session read goes through `trace_detail_spans`, which carries no span
//! events, so — as with Claude Code's `tool.output` (`claude_code.rs`) — the
//! restatement happens here, where the span is still whole. Additive only: a
//! key is written when the span does not already carry it.
//!
//! The per-message events of the OTel GenAI conventions before v1.37
//! (`gen_ai.{system,user,assistant,tool}.message`, `gen_ai.choice`) are what
//! Strands emits by default. Content recorded as OTLP log records (Semantic
//! Kernel, Google ADK, Claude Code's replies) is another signal, in another
//! request, and is not joined here.

use opentelemetry_proto::tonic::trace::v1::Span;
use serde_json::{json, Value};

use super::claude_code::{has, owned, text};

/// Restate one stamped span's content events as `gen_ai.*` attributes.
pub(super) fn restate(span: &mut Span) {
    if span.events.is_empty() {
        return;
    }
    // On a tool span the events hold the call, not a conversation: the
    // `gen_ai.tool.message` is its arguments and the `gen_ai.choice` its result.
    let tool_call =
        text(&span.attributes, "gen_ai.operation.name").as_deref() == Some("execute_tool");
    let mut system = None;
    let mut input = Vec::new();
    let mut output = Vec::new();
    let mut arguments = None;
    let mut result = None;
    for event in &span.events {
        let attrs = &event.attributes;
        match (event.name.as_str(), tool_call) {
            ("gen_ai.tool.message", true) => arguments = text(attrs, "content"),
            ("gen_ai.choice", true) => result = text(attrs, "message"),
            ("gen_ai.system.message", _) => system = text(attrs, "content").map(|c| parts(&c)),
            ("gen_ai.user.message", _) => input.extend(message("user", text(attrs, "content"))),
            ("gen_ai.assistant.message", _) => {
                input.extend(message("assistant", text(attrs, "content")));
            }
            ("gen_ai.tool.message", _) => input.extend(message("tool", text(attrs, "content"))),
            // Strands' event-loop cycle recaps its call's reply together with the
            // tool results (`tool.result`); both are already on the child spans.
            ("gen_ai.choice", _) if !has(attrs, "tool.result") => {
                if let Some(mut entry) = message("assistant", text(attrs, "message")) {
                    if let Some(reason) = text(attrs, "finish_reason") {
                        entry["finish_reason"] = reason.into();
                    }
                    output.push(entry);
                }
            }
            _ => {}
        }
    }
    let json_array =
        |values: Vec<Value>| (!values.is_empty()).then(|| Value::Array(values).to_string());
    let mut added = Vec::new();
    for (key, value) in [
        ("gen_ai.system_instructions", system.and_then(json_array)),
        ("gen_ai.input.messages", json_array(input)),
        ("gen_ai.output.messages", json_array(output)),
        ("gen_ai.tool.call.arguments", arguments),
        ("gen_ai.tool.call.result", result),
    ] {
        if let Some(value) = value {
            if !has(&span.attributes, key) {
                added.push(owned(key, value));
            }
        }
    }
    span.attributes.extend(added);
}

fn message(role: &str, content: Option<String>) -> Option<Value> {
    content.map(|content| json!({ "role": role, "parts": parts(&content) }))
}

/// A message's `content` as GenAI parts. Strands records Bedrock content blocks
/// (`[{"text"}, {"toolUse"}, {"toolResult"}]`), mapped as its own
/// latest-conventions mode maps them; any other content is one text part.
fn parts(content: &str) -> Vec<Value> {
    match serde_json::from_str::<Vec<serde_json::Map<String, Value>>>(content) {
        Ok(blocks) => blocks.into_iter().flatten().map(block_part).collect(),
        Err(_) => vec![json!({ "type": "text", "content": content })],
    }
}

/// One content block: a single-key object naming its kind.
fn block_part((kind, value): (String, Value)) -> Value {
    match kind.as_str() {
        "text" => json!({ "type": "text", "content": value }),
        "toolUse" => json!({
            "type": "tool_call",
            "id": value["toolUseId"],
            "name": value["name"],
            "arguments": value["input"],
        }),
        "toolResult" => json!({
            "type": "tool_call_response",
            "id": value["toolUseId"],
            "response": value["content"],
        }),
        _ => json!({ "type": kind, "content": value }),
    }
}

#[cfg(test)]
mod tests {
    use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
    use opentelemetry_proto::tonic::common::v1::{
        any_value, AnyValue, InstrumentationScope, KeyValue,
    };
    use opentelemetry_proto::tonic::trace::v1::span::Event;
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};

    use crate::ai_session::stamp_trace_request;

    fn attrs(pairs: &[(&str, &str)]) -> Vec<KeyValue> {
        pairs
            .iter()
            .map(|(key, value)| KeyValue {
                key: (*key).to_owned(),
                key_strindex: 0,
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValue((*value).to_owned())),
                }),
            })
            .collect()
    }

    fn span(name: &str, pairs: &[(&str, &str)], events: &[(&str, &[(&str, &str)])]) -> Span {
        Span {
            name: name.to_owned(),
            attributes: attrs(pairs),
            events: events
                .iter()
                .map(|(name, pairs)| Event {
                    name: (*name).to_owned(),
                    attributes: attrs(pairs),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    fn stamped(scope: &str, spans: Vec<Span>) -> Vec<Span> {
        let mut request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                scope_spans: vec![ScopeSpans {
                    scope: Some(InstrumentationScope {
                        name: scope.to_owned(),
                        ..Default::default()
                    }),
                    spans,
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };
        stamp_trace_request(&mut request);
        request.resource_spans.remove(0).scope_spans.remove(0).spans
    }

    fn value<'a>(span: &'a Span, key: &str) -> Option<&'a str> {
        span.attributes
            .iter()
            .find(|attr| attr.key == key)
            .and_then(|attr| match attr.value.as_ref()?.value.as_ref()? {
                any_value::Value::StringValue(text) => Some(text.as_str()),
                _ => None,
            })
    }

    // Strands 1.x default mode (legacy conventions), trimmed from the
    // `strands_agents` / `strands_user` captures.
    #[test]
    fn strands_legacy_message_events_become_gen_ai_messages() {
        let spans = stamped(
            "strands.telemetry.tracer",
            vec![
                span(
                    "chat",
                    &[
                        ("gen_ai.operation.name", "chat"),
                        ("gen_ai.system", "strands-agents"),
                    ],
                    &[
                        (
                            "gen_ai.system.message",
                            &[("content", r#"[{"text": "You are weather_worker."}]"#)],
                        ),
                        (
                            "gen_ai.user.message",
                            &[(
                                "content",
                                r#"[{"text": "Original Task: weather"}, {"text": "\nInputs from previous nodes:"}]"#,
                            )],
                        ),
                        (
                            "gen_ai.assistant.message",
                            &[(
                                "content",
                                r#"[{"toolUse": {"toolUseId": "call_rQ", "name": "get_weather", "input": {"city": "Amsterdam"}}}]"#,
                            )],
                        ),
                        (
                            "gen_ai.tool.message",
                            &[(
                                "content",
                                r#"[{"toolResult": {"toolUseId": "call_rQ", "status": "success", "content": [{"text": "{\"temperature_c\": 21}"}]}}]"#,
                            )],
                        ),
                        (
                            "gen_ai.choice",
                            &[
                                ("finish_reason", "end_turn"),
                                ("message", r#"[{"text": "It is partly cloudy."}]"#),
                            ],
                        ),
                    ],
                ),
                span(
                    "execute_tool get_weather",
                    &[
                        ("gen_ai.operation.name", "execute_tool"),
                        ("gen_ai.tool.call.id", "call_rQ"),
                    ],
                    &[
                        (
                            "gen_ai.tool.message",
                            &[
                                ("role", "tool"),
                                ("content", r#"{"city": "Amsterdam"}"#),
                                ("id", "call_rQ"),
                            ],
                        ),
                        (
                            "gen_ai.choice",
                            &[
                                ("message", r#"[{"text": "{\"temperature_c\": 21}"}]"#),
                                ("id", "call_rQ"),
                            ],
                        ),
                    ],
                ),
                span(
                    "invoke_agent orchestrator",
                    &[("gen_ai.operation.name", "invoke_agent")],
                    &[
                        (
                            "gen_ai.user.message",
                            &[("content", r#"[{"text": "Produce a briefing"}]"#)],
                        ),
                        (
                            "gen_ai.choice",
                            &[
                                ("message", "Task: Create a briefing"),
                                ("finish_reason", "end_turn"),
                            ],
                        ),
                    ],
                ),
                span(
                    "execute_event_loop_cycle",
                    &[("gen_ai.operation.name", "execute_event_loop_cycle")],
                    &[
                        ("gen_ai.user.message", &[("content", "Produce a briefing")]),
                        (
                            "gen_ai.choice",
                            &[
                                ("message", r#"[{"toolUse": {}}]"#),
                                ("tool.result", r#"[{"toolResult": {}}]"#),
                            ],
                        ),
                    ],
                ),
            ],
        );

        let chat = &spans[0];
        assert_eq!(
            value(chat, "gen_ai.system_instructions"),
            Some(r#"[{"content":"You are weather_worker.","type":"text"}]"#)
        );
        assert_eq!(
            value(chat, "gen_ai.input.messages"),
            Some(concat!(
                r#"[{"parts":[{"content":"Original Task: weather","type":"text"},{"content":"\nInputs from previous nodes:","type":"text"}],"role":"user"},"#,
                r#"{"parts":[{"arguments":{"city":"Amsterdam"},"id":"call_rQ","name":"get_weather","type":"tool_call"}],"role":"assistant"},"#,
                r#"{"parts":[{"id":"call_rQ","response":[{"text":"{\"temperature_c\": 21}"}],"type":"tool_call_response"}],"role":"tool"}]"#,
            ))
        );
        assert_eq!(
            value(chat, "gen_ai.output.messages"),
            Some(
                r#"[{"finish_reason":"end_turn","parts":[{"content":"It is partly cloudy.","type":"text"}],"role":"assistant"}]"#
            )
        );

        let tool = &spans[1];
        assert_eq!(
            value(tool, "gen_ai.tool.call.arguments"),
            Some(r#"{"city": "Amsterdam"}"#)
        );
        assert_eq!(
            value(tool, "gen_ai.tool.call.result"),
            Some(r#"[{"text": "{\"temperature_c\": 21}"}]"#)
        );
        assert_eq!(value(tool, "gen_ai.input.messages"), None);

        // The agent's reply is plain text, not content blocks.
        assert_eq!(
            value(&spans[2], "gen_ai.output.messages"),
            Some(
                r#"[{"finish_reason":"end_turn","parts":[{"content":"Task: Create a briefing","type":"text"}],"role":"assistant"}]"#
            )
        );

        let cycle = &spans[3];
        assert_eq!(
            value(cycle, "gen_ai.input.messages"),
            Some(r#"[{"parts":[{"content":"Produce a briefing","type":"text"}],"role":"user"}]"#)
        );
        assert_eq!(value(cycle, "gen_ai.output.messages"), None);
    }

    #[test]
    fn attributes_the_span_already_carries_win() {
        let spans = stamped(
            "strands.telemetry.tracer",
            vec![span(
                "chat",
                &[
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.input.messages", "[]"),
                ],
                &[("gen_ai.user.message", &[("content", "hi")])],
            )],
        );
        let inputs: Vec<_> = spans[0]
            .attributes
            .iter()
            .filter(|attr| attr.key == "gen_ai.input.messages")
            .collect();
        assert_eq!(inputs.len(), 1);
        assert_eq!(value(&spans[0], "gen_ai.input.messages"), Some("[]"));
    }
}
