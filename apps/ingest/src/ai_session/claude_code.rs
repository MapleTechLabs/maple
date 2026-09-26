//! Claude Code's native span dialect, restated as the `gen_ai.*` keys Agent
//! Sessions reads.
//!
//! Claude Code (`com.anthropic.claude_code.tracing`) names its facts in its own
//! vocabulary — `input_tokens`, `tool_name`, `user_prompt` — and puts a tool's
//! output in a `tool.output` span event. Every reader of an agent span keys on
//! `gen_ai.*`: the `ai_trace_index` materialized view settles usage and kind at
//! insert from fixed key lists, and the read side never sees span events. So the
//! restatement happens here, once, where the span is still whole, rather than as
//! a dialect every reader (the view, the integrations layer, a BYO-ClickHouse
//! schema) has to learn — and an index row materialized without it could never
//! be corrected.
//!
//! Additive only: a key is written when the span does not already carry it, so
//! a Claude Code release that starts emitting canonical `gen_ai.*` wins, and
//! nothing the emitter wrote is removed or rewritten.
//!
//! Three spans are the agent's work: `claude_code.interaction` (one user turn),
//! `claude_code.llm_request` (one Messages API call) and `claude_code.tool` (one
//! tool call). `claude_code.tool.execution` and `claude_code.tool.blocked_on_user`
//! are PHASES of that tool call — the run and the permission wait — and carry no
//! identity of their own, so they are not stamped: stamped, each would count as
//! another tool call (every call counted three times). A failed run is the one
//! fact a phase holds that its call does not, so it is folded onto the call's
//! span in the same request ([`fold_tool_failures`]).

use std::collections::HashMap;

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::trace::v1::Span;

pub(super) const VENDOR_ID: &str = "claude_agent_sdk";

const INTERACTION: &str = "claude_code.interaction";
const LLM_REQUEST: &str = "claude_code.llm_request";
const TOOL: &str = "claude_code.tool";
const TOOL_EXECUTION: &str = "claude_code.tool.execution";
const TOOL_BLOCKED_ON_USER: &str = "claude_code.tool.blocked_on_user";

/// What Claude Code writes in place of a prompt unless `OTEL_LOG_USER_PROMPTS=1`.
const REDACTED: &str = "<REDACTED>";

/// A phase of a tool call rather than a call: never stamped as agent work.
pub(super) fn is_phase(span_name: &str) -> bool {
    span_name == TOOL_EXECUTION || span_name == TOOL_BLOCKED_ON_USER
}

/// A tool run that failed, keyed by the `tool_use_id` of the call it belongs to.
pub(super) type ToolFailures = HashMap<String, ToolFailure>;

pub(super) struct ToolFailure {
    error_class: Option<String>,
    error: Option<String>,
}

/// Record the failure a `claude_code.tool.execution` span holds, if it holds one.
pub(super) fn note_tool_failure(span: &Span, failures: &mut ToolFailures) {
    if span.name != TOOL_EXECUTION || text(&span.attributes, "success").as_deref() != Some("false")
    {
        return;
    }
    let Some(id) = text(&span.attributes, "tool_use_id") else {
        return;
    };
    failures.insert(
        id,
        ToolFailure {
            error_class: text(&span.attributes, "error_class"),
            error: text(&span.attributes, "error"),
        },
    );
}

/// Restate one stamped Claude Code span's native keys as `gen_ai.*`.
pub(super) fn normalize(span: &mut Span) {
    let mut added = Vec::new();
    {
        let attrs = &span.attributes;
        let mut add = |key: &'static str, value: Option<String>| {
            if let Some(value) = value {
                if !has(attrs, key) {
                    added.push(owned(key, value));
                }
            }
        };
        match span.name.as_str() {
            INTERACTION => {
                add("gen_ai.operation.name", Some("invoke_agent".to_owned()));
                add(
                    "gen_ai.input.messages",
                    text(attrs, "user_prompt")
                        .filter(|prompt| prompt != REDACTED)
                        .map(|prompt| {
                            serde_json::json!([{
                                "role": "user",
                                "parts": [{ "type": "text", "content": prompt }],
                            }])
                            .to_string()
                        }),
                );
            }
            LLM_REQUEST => {
                add("gen_ai.operation.name", Some("chat".to_owned()));
                // Anthropic's convention: `input_tokens` excludes both cache
                // buckets. `gen_ai.system=anthropic` on the same span is what
                // tells every reader so (`GENAI_PROVIDER_USAGE_CONVENTIONS`).
                add("gen_ai.usage.input_tokens", text(attrs, "input_tokens"));
                add("gen_ai.usage.output_tokens", text(attrs, "output_tokens"));
                add(
                    "gen_ai.usage.cache_read.input_tokens",
                    text(attrs, "cache_read_tokens"),
                );
                add(
                    "gen_ai.usage.cache_creation.input_tokens",
                    text(attrs, "cache_creation_tokens"),
                );
                add(
                    "gen_ai.response.time_to_first_chunk",
                    text(attrs, "ttft_ms")
                        .and_then(|ms| ms.parse::<f64>().ok())
                        .map(|ms| (ms / 1000.0).to_string()),
                );
                // A failed request stays `Unset` and says so in `success`.
                if text(attrs, "success").as_deref() == Some("false") {
                    add("gen_ai.response.status", Some("failed".to_owned()));
                }
            }
            TOOL => {
                add("gen_ai.operation.name", Some("execute_tool".to_owned()));
                add("gen_ai.tool.name", text(attrs, "tool_name"));
                add("gen_ai.tool.call.arguments", tool_arguments(attrs));
                add(
                    "gen_ai.tool.call.result",
                    span.events
                        .iter()
                        .find(|event| event.name == "tool.output")
                        .and_then(|event| json_object(&event.attributes, &[])),
                );
            }
            _ => {}
        }
    }
    span.attributes.extend(added);
}

/// The call's input as far as the span records it: the Bash command and the
/// file a file tool touched. The full input is only on the `tool_result` log
/// event, which is not this span's to read.
fn tool_arguments(attrs: &[KeyValue]) -> Option<String> {
    json_object(
        attrs,
        &[("full_command", "command"), ("file_path", "file_path")],
    )
}

/// Mark every `claude_code.tool` span whose run failed, from the failures the
/// request's own phase spans recorded. A phase exported in a different request
/// from its call is missed; the batch processor ends both within milliseconds,
/// so that is a batch boundary, not the common case.
pub(super) fn fold_tool_failures(request: &mut ExportTraceServiceRequest, failures: &ToolFailures) {
    let spans = request
        .resource_spans
        .iter_mut()
        .flat_map(|resource| resource.scope_spans.iter_mut())
        .flat_map(|scope| scope.spans.iter_mut())
        .filter(|span| span.name == TOOL);
    for span in spans {
        let Some(id) = text(&span.attributes, "tool_use_id") else {
            continue;
        };
        let Some(failure) = failures.get(&id) else {
            continue;
        };
        if !has(&span.attributes, "error.type") {
            // `_OTHER` is semconv's fallback for a failure with no class.
            let class = failure
                .error_class
                .clone()
                .unwrap_or_else(|| "_OTHER".to_owned());
            span.attributes.push(owned("error.type", class));
        }
        if let Some(error) = &failure.error {
            if !has(&span.attributes, "gen_ai.tool.call.result") {
                let result = serde_json::json!({ "error": error }).to_string();
                span.attributes
                    .push(owned("gen_ai.tool.call.result", result));
            }
        }
    }
}

/// A JSON object of the listed keys (renamed), or of every key when `keys` is
/// empty; `None` when none of them is present.
fn json_object(attrs: &[KeyValue], keys: &[(&str, &str)]) -> Option<String> {
    let mut object = serde_json::Map::new();
    for attr in attrs {
        let name = if keys.is_empty() {
            Some(attr.key.as_str())
        } else {
            keys.iter()
                .find(|(from, _)| *from == attr.key)
                .map(|(_, to)| *to)
        };
        if let (Some(name), Some(value)) = (name, scalar(attr)) {
            object.insert(name.to_owned(), serde_json::Value::String(value));
        }
    }
    (!object.is_empty()).then(|| serde_json::Value::Object(object).to_string())
}

fn has(attrs: &[KeyValue], key: &str) -> bool {
    attrs.iter().any(|attr| attr.key == key)
}

/// The first non-empty scalar value under `key`, as text: token counts arrive
/// as ints, and the warehouse Map stores every value as a string anyway.
fn text(attrs: &[KeyValue], key: &str) -> Option<String> {
    attrs.iter().filter(|attr| attr.key == key).find_map(scalar)
}

fn scalar(attr: &KeyValue) -> Option<String> {
    let text = match attr.value.as_ref()?.value.as_ref()? {
        any_value::Value::StringValue(text) => text.clone(),
        any_value::Value::IntValue(int) => int.to_string(),
        any_value::Value::DoubleValue(double) => double.to_string(),
        any_value::Value::BoolValue(flag) => flag.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
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
