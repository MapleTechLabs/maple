//! Every fact Agent Sessions aggregates or filters on, decided here for each
//! stamped span and written as a `maple_ai.*` stamp, so `ai_trace_index_mv`
//! is a plain projection of these keys and the detail page reads the same
//! verdicts the list sums.
//!
//! - `maple_ai.llm_call` and the usage buckets: see `usage.rs`
//! - `maple_ai.tool_call`: `1` on a tool call, `0` on the copy a call paused
//!   for a human's approval leaves (see [`paused`]): that copy is no call
//! - `maple_ai.error`: `1` on a span that failed, by its status or by
//!   attribute (`error.type`, a failed `gen_ai.response.status`), unless it
//!   is such a paused copy
//! - `maple_ai.model`, `maple_ai.agent.name`, `maple_ai.tool.name`,
//!   `maple_ai.response.id`: each fact's first non-empty value across the
//!   dialects' keys (and OpenAI Agents' agent from its graph node, see
//!   [`agent_name`])
//! - `maple_ai.tool.description`, cut to [`TOOL_DESCRIPTION_MAX`] characters,
//!   on a tool call
//! - `maple_ai.tool.error_result`: a failed tool call's result, cut to
//!   [`TOOL_ERROR_RESULT_MAX`], where several frameworks put the only account
//!   of the failure
//!
//! A flag is written only when it holds (`maple_ai.tool_call`'s `0` aside)
//! and a value only when there is one:
//! `maple_ai.llm_call`, present on every stamped span, is what tells a reader
//! the rest were decided. The keys must match `MAPLE_AI_STAMP_ATTRS` in
//! `packages/domain/src/gen-ai.ts`.
//!
//! Performance: the span's attributes are read in one pass, each key looked
//! up once in a table of every key any fact reads, instead of one scan of
//! the attributes per key. Only stamped spans get here.

use std::sync::LazyLock;

use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::trace::v1::status::StatusCode;
use opentelemetry_proto::tonic::trace::v1::Span;

use super::{owned_string_attribute, usage};
use crate::telemetry::any_value_string;

const TOOL_CALL_ATTR: &str = "maple_ai.tool_call";
const ERROR_ATTR: &str = "maple_ai.error";
const MODEL_ATTR: &str = "maple_ai.model";
const AGENT_NAME_ATTR: &str = "maple_ai.agent.name";
const TOOL_NAME_ATTR: &str = "maple_ai.tool.name";
const TOOL_DESCRIPTION_ATTR: &str = "maple_ai.tool.description";
const TOOL_ERROR_RESULT_ATTR: &str = "maple_ai.tool.error_result";
const RESPONSE_ID_ATTR: &str = "maple_ai.response.id";

/// A description is a sentence meant for a model, but a framework can inline
/// a schema or a whole prompt there; the tool page shows it as prose.
const TOOL_DESCRIPTION_MAX: usize = 2_000;
/// An explanation of a failure is its opening; the rest of a result is payload.
const TOOL_ERROR_RESULT_MAX: usize = 1_000;
/// The response Google ADK records on a tool call it paused to ask a human
/// for confirmation. The call runs again under the same call id once approved.
const CONFIRMATION_REQUEST: &str = "This tool call requires confirmation";
/// OpenAI Agents SDK up to 0.22.0 records a call awaiting approval as the
/// repr of its result, whose run item is a `ToolApprovalItem`; later versions
/// record no output there, and so no mark.
const APPROVAL_ITEM: &str = "type='tool_approval_item'";
/// The status message LlamaIndex's own tracer ends a workflow step with when
/// the step suspends to wait for an event, such as a human's response; the
/// step runs again once it arrives.
const WAITING_FOR_EVENT: &str = "Waiting for event";

// Each fact's keys, canonical first: the first non-empty value wins.

/// Response model first: an alias in the request resolves to a dated
/// snapshot in the response.
const MODEL_KEYS: &[&str] = &[
    "gen_ai.response.model",
    "gen_ai.request.model",
    "ai.response.model",
    "ai.model.id",
    "llm.model_name",
];
/// `ai.telemetry.functionId` is the name an app gave a traced Vercel AI SDK
/// call, the only agent identity an older-SDK span has.
const AGENT_NAME_KEYS: &[&str] = &["gen_ai.agent.name", "ai.telemetry.functionId"];
const TOOL_NAME_KEYS: &[&str] = &["gen_ai.tool.name", "ai.toolCall.name", "tool.name"];
const TOOL_DESCRIPTION_KEYS: &[&str] = &["gen_ai.tool.description", "tool.description"];
const TOOL_RESULT_KEYS: &[&str] = &["gen_ai.tool.call.result", "ai.toolCall.result"];
const RESPONSE_ID_KEYS: &[&str] = &["gen_ai.response.id", "ai.response.id"];

/// Text facts, by slot.
const OPERATION: usize = 0;
const SPAN_KIND: usize = 1;
const MODEL: usize = 2;
const AGENT_NAME: usize = 3;
const TOOL_NAME: usize = 4;
const TOOL_DESCRIPTION: usize = 5;
const TOOL_RESULT: usize = 6;
const RESPONSE_ID: usize = 7;
const ERROR_TYPE: usize = 8;
const RESPONSE_STATUS: usize = 9;
const GRAPH_NODE_ID: usize = 10;
const ADK_TOOL_RESPONSE: usize = 11;
const OUTPUT_VALUE: usize = 12;
const DEFERRAL: usize = 13;
const TEXT_KEYS: [&[&str]; 14] = [
    &["gen_ai.operation.name"],
    &["openinference.span.kind"],
    MODEL_KEYS,
    AGENT_NAME_KEYS,
    TOOL_NAME_KEYS,
    TOOL_DESCRIPTION_KEYS,
    TOOL_RESULT_KEYS,
    RESPONSE_ID_KEYS,
    &["error.type"],
    &["gen_ai.response.status"],
    &["graph.node.id"],
    // Every ADK version writes its tool's response here; 2.6 writes no
    // `gen_ai.tool.call.result`.
    &["gcp.vertex.agent.tool_response"],
    &["output.value"],
    &["pydantic_ai.tool.deferral.name"],
];

/// Number facts, by slot: the first key whose value is a finite,
/// non-negative number wins.
pub(super) const INPUT: usize = 0;
pub(super) const CACHE_READ: usize = 1;
pub(super) const CACHE_WRITE: usize = 2;
pub(super) const OUTPUT: usize = 3;
pub(super) const REASONING: usize = 4;
pub(super) const UNCACHED_INPUT: usize = 5;
pub(super) const VISIBLE_OUTPUT: usize = 6;
pub(super) const COST: usize = 7;
const NUMBER_KEYS: [&[&str]; 8] = [
    usage::INPUT_KEYS,
    usage::CACHE_READ_KEYS,
    usage::CACHE_WRITE_KEYS,
    usage::OUTPUT_KEYS,
    usage::REASONING_KEYS,
    usage::UNCACHED_INPUT_KEYS,
    usage::VISIBLE_OUTPUT_KEYS,
    usage::COST_KEYS,
];

#[derive(Clone, Copy)]
enum Slot {
    Text(usize),
    Number(usize),
}

/// A key, the fact it feeds, and its rank in that fact's list.
type Key = (&'static str, Slot, u8);

/// Every key above as `(key, slot, rank)`, bucketed by the key's length;
/// `rank` is the key's place in its fact's list. A span's key is compared
/// only against the few keys of its own length, and their last byte first, so
/// the common miss costs an index and a short loop, rarely a string compare.
static KEY_TABLE: LazyLock<Vec<Vec<Key>>> = LazyLock::new(|| {
    let mut table: Vec<Vec<Key>> = Vec::new();
    let lists = TEXT_KEYS
        .iter()
        .enumerate()
        .map(|(index, keys)| (Slot::Text(index), *keys))
        .chain(
            NUMBER_KEYS
                .iter()
                .enumerate()
                .map(|(index, keys)| (Slot::Number(index), *keys)),
        );
    for (slot, keys) in lists {
        for (key, rank) in keys.iter().zip(0u8..) {
            if table.len() <= key.len() {
                table.resize_with(key.len() + 1, Vec::new);
            }
            table[key.len()].push((key, slot, rank));
        }
    }
    table
});

/// One span's facts, borrowed from its attributes. A text fact is any value
/// the warehouse Map would hold as a non-empty string: a structured tool result
/// counts, as it did when the view read the Map.
pub(super) struct Facts<'a> {
    text: [Option<&'a AnyValue>; TEXT_KEYS.len()],
    text_rank: [u8; TEXT_KEYS.len()],
    number: [Option<f64>; NUMBER_KEYS.len()],
    number_rank: [u8; NUMBER_KEYS.len()],
}

impl<'a> Facts<'a> {
    pub(super) fn read(attrs: &'a [KeyValue]) -> Self {
        let mut facts = Self {
            text: [None; TEXT_KEYS.len()],
            text_rank: [u8::MAX; TEXT_KEYS.len()],
            number: [None; NUMBER_KEYS.len()],
            number_rank: [u8::MAX; NUMBER_KEYS.len()],
        };
        let table = &*KEY_TABLE;
        for attr in attrs {
            let Some(&found) = table.get(attr.key.len()).and_then(|keys| {
                keys.iter().find(|(key, ..)| {
                    key.as_bytes().last() == attr.key.as_bytes().last() && *key == attr.key
                })
            }) else {
                continue;
            };
            match found {
                (_, Slot::Text(slot), rank) if rank < facts.text_rank[slot] => {
                    if let Some(value) = attr.value.as_ref().filter(|value| present(value)) {
                        facts.text[slot] = Some(value);
                        facts.text_rank[slot] = rank;
                    }
                }
                (_, Slot::Number(slot), rank) if rank < facts.number_rank[slot] => {
                    if let Some(value) = number(attr) {
                        facts.number[slot] = Some(value);
                        facts.number_rank[slot] = rank;
                    }
                }
                _ => {}
            }
        }
        facts
    }

    pub(super) fn number(&self, slot: usize) -> Option<f64> {
        self.number[slot]
    }

    /// A text fact's value if it is a string, else `""`: what the rules that
    /// compare a fact to a known literal read.
    fn str(&self, slot: usize) -> &'a str {
        match self.text[slot].and_then(|value| value.value.as_ref()) {
            Some(any_value::Value::StringValue(text)) => text,
            _ => "",
        }
    }

    /// A text fact as the stamp writes it, stringified the way the row encoder
    /// writes the Map.
    fn owned(&self, slot: usize) -> Option<String> {
        self.text[slot].map(any_value_string)
    }

    pub(super) fn model(&self) -> &'a str {
        self.str(MODEL)
    }

    pub(super) fn has_tool_name(&self) -> bool {
        self.text[TOOL_NAME].is_some()
    }

    /// `gen_ai.operation.name`, else the OpenInference span kind translated.
    pub(super) fn operation(&self) -> &'a str {
        let op = self.str(OPERATION);
        if !op.is_empty() {
            return op;
        }
        match self.str(SPAN_KIND) {
            "LLM" => "chat",
            "TOOL" => "execute_tool",
            "AGENT" => "invoke_agent",
            "EMBEDDING" => "embeddings",
            "RETRIEVER" => "retrieval",
            _ => "",
        }
    }
}

#[expect(
    clippy::cast_precision_loss,
    reason = "token counts and costs stay far below 2^53"
)]
fn number(attr: &KeyValue) -> Option<f64> {
    let value = match attr.value.as_ref()?.value.as_ref()? {
        any_value::Value::IntValue(int) => *int as f64,
        any_value::Value::DoubleValue(double) => *double,
        any_value::Value::StringValue(text) => text.trim().parse().ok()?,
        _ => return None,
    };
    (value.is_finite() && value >= 0.0).then_some(value)
}

/// Does `name` contain `needle` (lowercase ASCII), ignoring ASCII case?
pub(super) fn name_has(name: &str, needle: &str) -> bool {
    name.as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

/// Would the warehouse Map hold this value as a non-empty string?
fn present(value: &AnyValue) -> bool {
    match value.value.as_ref() {
        Some(any_value::Value::StringValue(text)) => !text.is_empty(),
        Some(any_value::Value::BytesValue(bytes)) => !bytes.is_empty(),
        Some(any_value::Value::StringValueStrindex(_)) | None => false,
        Some(_) => true,
    }
}

/// `text` cut to `max` characters.
fn truncate(mut text: String, max: usize) -> String {
    if let Some((end, _)) = text.char_indices().nth(max) {
        text.truncate(end);
    }
    text
}

/// Decide every fact of one stamped span, as the stamps to write on it.
pub(super) fn stamps(span: &Span, vendor: &str) -> Vec<KeyValue> {
    let failed_status = span
        .status
        .as_ref()
        .is_some_and(|status| status.code == StatusCode::Error as i32);
    let mut stamps = Vec::with_capacity(12);
    let facts = Facts::read(&span.attributes);
    let llm_call = usage::stamp(span, vendor, &facts, &mut stamps);
    let tool_call = !llm_call && is_tool_call(&facts, &span.name);
    let paused = tool_call && paused(span, &facts, vendor);
    let failed = !paused
        && (failed_status
            || facts.text[ERROR_TYPE].is_some()
            || ["failed", "error"]
                .iter()
                .any(|status| facts.str(RESPONSE_STATUS).eq_ignore_ascii_case(status)));
    let mut text = |key: &str, value: Option<String>| {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            stamps.push(owned_string_attribute(key, value));
        }
    };
    text(MODEL_ATTR, facts.owned(MODEL));
    text(AGENT_NAME_ATTR, agent_name(&facts, vendor, &span.name));
    text(TOOL_NAME_ATTR, facts.owned(TOOL_NAME));
    if llm_call {
        text(RESPONSE_ID_ATTR, facts.owned(RESPONSE_ID));
    }
    if tool_call {
        text(
            TOOL_DESCRIPTION_ATTR,
            facts
                .owned(TOOL_DESCRIPTION)
                .map(|text| truncate(text, TOOL_DESCRIPTION_MAX)),
        );
        if failed {
            text(
                TOOL_ERROR_RESULT_ATTR,
                facts
                    .owned(TOOL_RESULT)
                    .map(|text| truncate(text, TOOL_ERROR_RESULT_MAX)),
            );
        }
    }
    if tool_call {
        let call = if paused { "0" } else { "1" };
        stamps.push(owned_string_attribute(TOOL_CALL_ATTR, call.to_owned()));
    }
    if failed {
        stamps.push(owned_string_attribute(ERROR_ATTR, "1".to_owned()));
    }
    stamps
}

/// Is this tool call the copy a call paused for a human's approval leaves,
/// by its framework's explicit mark? Such a copy is neither a call nor a
/// failure, though some frameworks end it in error. Never by a missing
/// result: an app that does not capture content, or a tool that returns
/// nothing, records none.
fn paused(span: &Span, facts: &Facts, vendor: &str) -> bool {
    match vendor {
        "google_adk" => facts.str(ADK_TOOL_RESPONSE).contains(CONFIRMATION_REQUEST),
        "openai_agents_sdk" => facts.str(OUTPUT_VALUE).contains(APPROVAL_ITEM),
        // A tool that raised `ApprovalRequired`.
        "pydantic_ai" => facts.str(DEFERRAL) == "ApprovalRequired",
        "llamaindex" => span
            .status
            .as_ref()
            .is_some_and(|status| status.message.starts_with(WAITING_FOR_EVENT)),
        _ => false,
    }
}

/// The agent that owns the span. OpenAI Agents' OpenInference instrumentor
/// names an agent only in `graph.node.id` on its AGENT span, where it equals
/// the span name ("Triage Agent"); the run's root AGENT span has no node id,
/// and agno's node id is a hash that never equals the span name.
fn agent_name(facts: &Facts, vendor: &str, span_name: &str) -> Option<String> {
    if facts.text[AGENT_NAME].is_some() {
        return facts.owned(AGENT_NAME);
    }
    let node = facts.str(GRAPH_NODE_ID);
    (matches!(vendor, "openai_agents_sdk" | "unknown:openinference")
        && facts.str(SPAN_KIND) == "AGENT"
        && node == span_name)
        .then(|| node.to_owned())
}

/// A tool call: the convention's tool operation, or, under an operation the
/// convention does not name, a tool name. A span name saying "tool" counts
/// only when no operation is named: one that names its own (LangSmith's
/// `chain` over LangGraph's `tools` node, a Mastra `scorer_step`) has said
/// what it is.
fn is_tool_call(facts: &Facts, span_name: &str) -> bool {
    let op = facts.operation();
    op == "execute_tool"
        || (!usage::KNOWN_OPS.contains(&op)
            && (facts.has_tool_name() || (op.is_empty() && name_has(span_name, "tool"))))
}

/// Mark a stamped tool call as failed after the fact: Claude Code records a
/// tool run's failure on a phase span that can arrive after its call's
/// (`claude_code::fold_tool_failures`).
pub(super) fn mark_tool_failed(span: &mut Span) {
    let has = |key: &str| span.attributes.iter().any(|attr| attr.key == key);
    let result = (!has(TOOL_ERROR_RESULT_ATTR))
        .then(|| Facts::read(&span.attributes).owned(TOOL_RESULT))
        .flatten()
        .filter(|result| !result.is_empty())
        .map(|result| truncate(result, TOOL_ERROR_RESULT_MAX));
    let error = !has(ERROR_ATTR);
    if let Some(result) = result {
        span.attributes
            .push(owned_string_attribute(TOOL_ERROR_RESULT_ATTR, result));
    }
    if error {
        span.attributes
            .push(owned_string_attribute(ERROR_ATTR, "1".to_owned()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_session::{stamp_trace_request, value_str};
    use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
    use opentelemetry_proto::tonic::common::v1::InstrumentationScope;
    use opentelemetry_proto::tonic::resource::v1::Resource;
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Status};

    type Attrs<'a> = &'a [(&'a str, &'a str)];
    type Stamps = Vec<(String, String)>;

    fn span(name: &str, attrs: Attrs) -> Span {
        Span {
            name: name.to_owned(),
            attributes: attrs
                .iter()
                .map(|(key, value)| owned_string_attribute(key, (*value).to_owned()))
                .collect(),
            ..Default::default()
        }
    }

    /// One scope's spans through the gateway's stamping pass: each span's
    /// `maple_ai.*` stamps, less the vendor, session and usage ones.
    fn stamps(scope: &str, spans: Vec<Span>) -> Vec<Stamps> {
        let mut request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource::default()),
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
        request.resource_spans[0].scope_spans[0]
            .spans
            .iter()
            .map(|span| {
                span.attributes
                    .iter()
                    .filter(|attr| {
                        attr.key.starts_with("maple_ai.")
                            && !attr.key.starts_with("maple_ai.vendor.")
                            && !attr.key.starts_with("maple_ai.usage.")
                            && attr.key != "maple_ai.session.id"
                    })
                    .map(|attr| (attr.key.clone(), value_str(attr).to_owned()))
                    .collect()
            })
            .collect()
    }

    fn pairs(expected: Attrs) -> Stamps {
        expected
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn has(stamps: &Stamps, key: &str) -> bool {
        stamps.iter().any(|(stamp, _)| stamp == key)
    }

    /// `captures/docs_vercel-ai-sdk_b`: the agent, its model call and a tool
    /// call.
    #[test]
    fn vercel_v7_agent_call_and_tool() {
        let got = stamps(
            "gen_ai",
            vec![
                span(
                    "invoke_agent support",
                    &[
                        ("gen_ai.operation.name", "invoke_agent"),
                        ("gen_ai.agent.name", "support"),
                        ("gen_ai.request.model", "openai/gpt-4o-mini"),
                    ],
                ),
                span(
                    "chat openai/gpt-4o-mini",
                    &[
                        ("gen_ai.operation.name", "chat"),
                        ("gen_ai.request.model", "openai/gpt-4o-mini"),
                        ("gen_ai.response.model", "openai/gpt-4o-mini-2024-07-18"),
                        ("gen_ai.response.id", "gen-1"),
                    ],
                ),
                span(
                    "execute_tool search_docs",
                    &[
                        ("gen_ai.operation.name", "execute_tool"),
                        ("gen_ai.tool.name", "search_docs"),
                        ("gen_ai.tool.call.id", "call_1"),
                        ("gen_ai.tool.description", "Search the docs."),
                        ("gen_ai.tool.call.result", "{\"hits\":3}"),
                    ],
                ),
            ],
        );
        assert_eq!(
            got,
            [
                pairs(&[
                    ("maple_ai.llm_call", "0"),
                    (MODEL_ATTR, "openai/gpt-4o-mini"),
                    (AGENT_NAME_ATTR, "support"),
                ]),
                pairs(&[
                    ("maple_ai.llm_call", "1"),
                    (MODEL_ATTR, "openai/gpt-4o-mini-2024-07-18"),
                    (RESPONSE_ID_ATTR, "gen-1"),
                ]),
                pairs(&[
                    ("maple_ai.llm_call", "0"),
                    (TOOL_NAME_ATTR, "search_docs"),
                    (TOOL_DESCRIPTION_ATTR, "Search the docs."),
                    (TOOL_CALL_ATTR, "1"),
                ]),
            ]
        );
    }

    /// The legacy `ai` scope names no operation: its tool call is found by
    /// name, its agent by the telemetry function id.
    #[test]
    fn vercel_legacy_dialect_keys() {
        let got = stamps(
            "ai",
            vec![
                span(
                    "ai.generateText",
                    &[
                        ("ai.telemetry.functionId", "support"),
                        ("ai.model.id", "gpt-5"),
                    ],
                ),
                span(
                    "ai.toolCall",
                    &[
                        ("ai.toolCall.name", "search_docs"),
                        ("ai.toolCall.id", "call_2"),
                        ("ai.toolCall.result", "[]"),
                    ],
                ),
            ],
        );
        assert_eq!(
            got,
            [
                pairs(&[
                    ("maple_ai.llm_call", "0"),
                    (MODEL_ATTR, "gpt-5"),
                    (AGENT_NAME_ATTR, "support"),
                ]),
                pairs(&[
                    ("maple_ai.llm_call", "0"),
                    (TOOL_NAME_ATTR, "search_docs"),
                    (TOOL_CALL_ATTR, "1"),
                ]),
            ]
        );
    }

    /// A failure by status, by `error.type` and by response status; a failed
    /// tool call carries its result, cut.
    #[test]
    fn failures_and_the_failed_tool_result() {
        let mut errored = span("chat gpt-5", &[("gen_ai.operation.name", "chat")]);
        errored.status = Some(Status {
            code: StatusCode::Error as i32,
            ..Default::default()
        });
        let long = "x".repeat(TOOL_ERROR_RESULT_MAX + 50);
        let got = stamps(
            "support-agent",
            vec![
                errored,
                span(
                    "chat gpt-5",
                    &[
                        ("gen_ai.operation.name", "chat"),
                        ("gen_ai.response.status", "Failed"),
                    ],
                ),
                span(
                    "execute_tool fetch",
                    &[
                        ("gen_ai.operation.name", "execute_tool"),
                        ("gen_ai.tool.name", "fetch"),
                        ("error.type", "TimeoutError"),
                        ("gen_ai.tool.call.result", &long),
                    ],
                ),
                span(
                    "execute_tool fetch",
                    &[
                        ("gen_ai.operation.name", "execute_tool"),
                        ("error.type", ""),
                    ],
                ),
            ],
        );
        let failed_call = pairs(&[("maple_ai.llm_call", "1"), (ERROR_ATTR, "1")]);
        assert_eq!(got[0], failed_call);
        assert_eq!(got[1], failed_call);
        assert_eq!(
            got[2],
            pairs(&[
                ("maple_ai.llm_call", "0"),
                (TOOL_NAME_ATTR, "fetch"),
                (TOOL_ERROR_RESULT_ATTR, &long[..TOOL_ERROR_RESULT_MAX]),
                (TOOL_CALL_ATTR, "1"),
                (ERROR_ATTR, "1"),
            ])
        );
        // An empty `error.type` is no failure, and a call that recorded no
        // result is still a call: only a framework's explicit mark pauses one.
        assert_eq!(
            got[3],
            pairs(&[("maple_ai.llm_call", "0"), (TOOL_CALL_ATTR, "1")])
        );
    }

    /// `captures/google_adk_hitl_probe` (ADK 2.6): the paused copy's response
    /// is the confirmation request, and is no call; the approved run under the
    /// same id is one.
    #[test]
    fn a_confirmation_request_is_no_tool_call() {
        let tool = |response: &str| {
            span(
                "execute_tool delete_file",
                &[
                    ("gen_ai.operation.name", "execute_tool"),
                    ("gen_ai.tool.name", "delete_file"),
                    ("gen_ai.tool.call.id", "adk-1"),
                    ("gcp.vertex.agent.tool_response", response),
                ],
            )
        };
        let got = stamps(
            "gcp.vertex.agent",
            vec![
                tool("{\"error\": \"This tool call requires confirmation, please approve or reject.\"}"),
                tool("{\"deleted\": true}"),
            ],
        );
        let call = |flag: &str| {
            pairs(&[
                ("maple_ai.llm_call", "0"),
                (TOOL_NAME_ATTR, "delete_file"),
                (TOOL_CALL_ATTR, flag),
            ])
        };
        assert_eq!(got, [call("0"), call("1")]);
    }

    /// `captures/openai_agents_sdk_user` (SDK 0.19.4, OpenInference 1.6.2):
    /// the copy awaiting approval records its result's repr, a
    /// `ToolApprovalItem`, and is no call; the approved run's copy is one.
    #[test]
    fn an_openai_agents_approval_item_is_no_tool_call() {
        let tool = |output: &str| {
            span(
                "delete_file",
                &[
                    ("openinference.span.kind", "TOOL"),
                    ("tool.name", "delete_file"),
                    ("output.value", output),
                ],
            )
        };
        let got = stamps(
            "openinference.instrumentation.openai_agents",
            vec![
                tool("FunctionToolResult(tool=FunctionTool(name='delete_file'), output=None, run_item=ToolApprovalItem(agent=Agent(name='assistant'), type='tool_approval_item'))"),
                tool("deleted /tmp/scratch-notes.txt"),
            ],
        );
        let call = |flag: &str| {
            pairs(&[
                ("maple_ai.llm_call", "0"),
                (TOOL_NAME_ATTR, "delete_file"),
                (TOOL_CALL_ATTR, flag),
            ])
        };
        assert_eq!(got, [call("0"), call("1")]);
    }

    /// pydantic-ai (source: `_run_tool_span` in its instrumentation) marks a
    /// tool that raised `ApprovalRequired`, in error before instrumentation
    /// v5; a deferral to run the tool elsewhere is no pause. LlamaIndex's own
    /// tracer (`captures/llamaindex_user`) ends a step waiting for a human's
    /// response in error. Neither copy is a call or a failure.
    #[test]
    fn pydantic_ai_and_llamaindex_pauses_are_no_tool_call_nor_failure() {
        let failed = |mut span: Span, message: &str| {
            span.status = Some(Status {
                code: StatusCode::Error as i32,
                message: message.to_owned(),
            });
            span
        };
        let deferred = |name: &str| {
            span(
                "execute_tool delete_file",
                &[
                    ("gen_ai.operation.name", "execute_tool"),
                    ("pydantic_ai.tool.deferral.name", name),
                ],
            )
        };
        let pydantic = stamps(
            "pydantic-ai",
            vec![
                failed(deferred("ApprovalRequired"), "ApprovalRequired"),
                deferred("CallDeferred"),
            ],
        );
        let call = |flag: &str| pairs(&[("maple_ai.llm_call", "0"), (TOOL_CALL_ATTR, flag)]);
        assert_eq!(pydantic, [call("0"), call("1")]);
        let step = || span("FunctionTool.acall", &[("llamaindex.run_id", "r-1")]);
        let llamaindex = stamps(
            "llamaindex.opentelemetry.tracer",
            vec![
                failed(
                    step(),
                    "Waiting for event <class 'workflows.events.HumanResponseEvent'>",
                ),
                failed(step(), "boom"),
            ],
        );
        assert_eq!(llamaindex[0], call("0"));
        assert_eq!(
            llamaindex[1],
            pairs(&[
                ("maple_ai.llm_call", "0"),
                (TOOL_CALL_ATTR, "1"),
                (ERROR_ATTR, "1"),
            ])
        );
    }

    /// PROD `cs-demo-004` (OpenAI Agents TS through OpenInference): an agent
    /// is named only by `graph.node.id` on its AGENT span, equal to the span
    /// name; the run's root AGENT span has no node id.
    #[test]
    fn openai_agents_name_the_agent_by_its_graph_node() {
        let agent = |name: &str, node: Option<&str>| {
            let mut attrs = vec![("openinference.span.kind", "AGENT")];
            attrs.extend(node.map(|node| ("graph.node.id", node)));
            span(name, &attrs)
        };
        let got = stamps(
            "@arizeai/openinference-instrumentation-openai-agents",
            vec![
                agent("Customer service", None),
                agent("Triage Agent", Some("Triage Agent")),
                span(
                    "search_faq",
                    &[
                        ("openinference.span.kind", "TOOL"),
                        ("tool.name", "search_faq"),
                        ("graph.node.id", "search_faq"),
                    ],
                ),
            ],
        );
        assert_eq!(got[0], pairs(&[("maple_ai.llm_call", "0")]));
        assert_eq!(
            got[1],
            pairs(&[
                ("maple_ai.llm_call", "0"),
                (AGENT_NAME_ATTR, "Triage Agent")
            ])
        );
        assert!(!has(&got[2], AGENT_NAME_ATTR) && has(&got[2], TOOL_CALL_ATTR));
        // agno's node id is a hash: never the span name, never an agent.
        let agno = stamps(
            "openinference.instrumentation.agno",
            vec![agent("Agent.run", Some("5f2c1e0a"))],
        );
        assert_eq!(agno[0], pairs(&[("maple_ai.llm_call", "0")]));
    }

    /// Outside the convention's operations a tool name makes a tool call, and
    /// a span name saying "tool" does only when no operation is named (the
    /// Mastra scorer and LangSmith `chain` wrappers name one); a memory
    /// operation never does.
    #[test]
    fn tool_calls_by_name_under_unknown_operations() {
        let got = stamps(
            "support-agent",
            vec![
                span("run_tools", &[("traceloop.span.kind", "task")]),
                span(
                    "mcp_tool_call search",
                    &[
                        ("gen_ai.operation.name", "mcp_tool_call"),
                        ("gen_ai.tool.name", "search"),
                    ],
                ),
                span(
                    "scorer_step code-tool-call-accuracy-scorer",
                    &[("gen_ai.operation.name", "scorer_step")],
                ),
                span("tools", &[("gen_ai.operation.name", "chain")]),
                span(
                    "search_memory notes",
                    &[
                        ("gen_ai.operation.name", "search_memory"),
                        ("gen_ai.tool.name", "notes"),
                    ],
                ),
            ],
        );
        let tool_calls: Vec<bool> = got.iter().map(|span| has(span, TOOL_CALL_ATTR)).collect();
        assert_eq!(tool_calls, [true, true, false, false, false]);
    }

    /// A value the warehouse Map holds as a string counts whatever its OTLP
    /// type: a structured tool result, a boolean `error.type`.
    #[test]
    fn non_string_values_count_as_the_map_holds_them() {
        let typed = |key: &str, value: any_value::Value| KeyValue {
            key: key.to_owned(),
            key_strindex: 0,
            value: Some(AnyValue { value: Some(value) }),
        };
        let result =
            any_value::Value::ArrayValue(opentelemetry_proto::tonic::common::v1::ArrayValue {
                values: vec![AnyValue {
                    value: Some(any_value::Value::StringValue("boom".to_owned())),
                }],
            });
        let mut tool = span(
            "execute_tool fetch",
            &[("gen_ai.operation.name", "execute_tool")],
        );
        tool.attributes.extend([
            typed("gen_ai.tool.call.result", result),
            typed("error.type", any_value::Value::BoolValue(true)),
        ]);
        let got = stamps("support-agent", vec![tool]);
        assert_eq!(
            got[0],
            pairs(&[
                ("maple_ai.llm_call", "0"),
                (TOOL_ERROR_RESULT_ATTR, "[\"boom\"]"),
                (TOOL_CALL_ATTR, "1"),
                (ERROR_ATTR, "1"),
            ])
        );
    }

    #[test]
    fn a_long_description_is_cut() {
        let long = "d".repeat(TOOL_DESCRIPTION_MAX + 1);
        let got = stamps(
            "support-agent",
            vec![span(
                "execute_tool fetch",
                &[
                    ("gen_ai.operation.name", "execute_tool"),
                    ("gen_ai.tool.description", &long),
                    ("gen_ai.tool.call.result", "ok"),
                ],
            )],
        );
        let cut = (
            TOOL_DESCRIPTION_ATTR.to_owned(),
            long[..TOOL_DESCRIPTION_MAX].to_owned(),
        );
        assert!(got[0].contains(&cut));
    }

    #[test]
    fn every_key_reads_one_fact() {
        let mut keys: Vec<&str> = KEY_TABLE.iter().flatten().map(|(key, ..)| *key).collect();
        let count = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), count, "a key in two lists");
    }

    #[test]
    fn truncation_counts_characters() {
        assert_eq!(truncate("héllo".to_owned(), 2), "hé");
        assert_eq!(truncate("héllo".to_owned(), 9), "héllo");
    }

    #[test]
    fn name_has_ignores_case() {
        assert!(name_has("ai.toolCall", "tool"));
        assert!(name_has("ChatOpenAI", "chat"));
        assert!(!name_has("to", "tool"));
    }
}
