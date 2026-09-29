//! Every fact Agent Sessions aggregates or filters on, decided here for each
//! stamped span and written as a `maple_ai.*` stamp, so `ai_trace_index_mv`
//! is a plain projection of these keys and the detail page reads the same
//! verdicts the list sums.
//!
//! - `maple_ai.llm_call` and the usage buckets: see `usage.rs`
//! - `maple_ai.tool_call`: `1` on a tool call
//! - `maple_ai.error`: `1` on a span that failed, by its status or by
//!   attribute (`error.type`, a failed `gen_ai.response.status`)
//! - `maple_ai.model`, `maple_ai.agent.name`, `maple_ai.tool.name`,
//!   `maple_ai.tool.call_id`, `maple_ai.response.id`: each fact's first
//!   non-empty value across the dialects' keys (and OpenAI Agents' agent from
//!   its graph node, see [`agent_name`])
//! - `maple_ai.tool.description`, cut to [`TOOL_DESCRIPTION_MAX`] characters,
//!   on a tool call
//! - `maple_ai.tool.error_result`: a failed tool call's result, cut to
//!   [`TOOL_ERROR_RESULT_MAX`], where several frameworks put the only account
//!   of the failure
//! - `maple_ai.tool.paused`: `1` on a tool call's copy that recorded no
//!   outcome, the copy a call paused for a human's approval leaves behind
//!
//! A flag is written only when it holds and a value only when there is one:
//! `maple_ai.llm_call`, present on every stamped span, is what tells a reader
//! the rest were decided.
//!
//! Performance: the span's attributes are read in one pass, each key looked
//! up once in a table of every key any fact reads, instead of one scan of
//! the attributes per key. Only stamped spans get here.

use std::sync::LazyLock;

use opentelemetry_proto::tonic::common::v1::{any_value, KeyValue};
use opentelemetry_proto::tonic::trace::v1::status::StatusCode;
use opentelemetry_proto::tonic::trace::v1::Span;

use super::{owned_string_attribute, usage, value_str};

const TOOL_CALL_ATTR: &str = "maple_ai.tool_call";
const ERROR_ATTR: &str = "maple_ai.error";
const MODEL_ATTR: &str = "maple_ai.model";
const AGENT_NAME_ATTR: &str = "maple_ai.agent.name";
const TOOL_NAME_ATTR: &str = "maple_ai.tool.name";
const TOOL_CALL_ID_ATTR: &str = "maple_ai.tool.call_id";
const TOOL_DESCRIPTION_ATTR: &str = "maple_ai.tool.description";
const TOOL_ERROR_RESULT_ATTR: &str = "maple_ai.tool.error_result";
const TOOL_PAUSED_ATTR: &str = "maple_ai.tool.paused";
const RESPONSE_ID_ATTR: &str = "maple_ai.response.id";

/// A description is a sentence meant for a model, but a framework can inline
/// a schema or a whole prompt there; the tool page shows it as prose.
const TOOL_DESCRIPTION_MAX: usize = 2_000;
/// An explanation of a failure is its opening; the rest of a result is payload.
const TOOL_ERROR_RESULT_MAX: usize = 1_000;
/// The result Google ADK records on a tool call it paused to ask a human for
/// confirmation. The call runs again under the same call id once approved.
const CONFIRMATION_REQUEST: &str = "This tool call requires confirmation";

// Each fact's keys, canonical first: the first non-empty value wins.

/// Response model first: an alias in the request resolves to a dated
/// snapshot in the response.
pub(super) const MODEL_KEYS: &[&str] = &[
    "gen_ai.response.model",
    "gen_ai.request.model",
    "ai.response.model",
    "ai.model.id",
    "llm.model_name",
];
/// `ai.telemetry.functionId` is the name an app gave a traced Vercel AI SDK
/// call, the only agent identity an older-SDK span has.
const AGENT_NAME_KEYS: &[&str] = &["gen_ai.agent.name", "ai.telemetry.functionId"];
pub(super) const TOOL_NAME_KEYS: &[&str] = &["gen_ai.tool.name", "ai.toolCall.name", "tool.name"];
const TOOL_CALL_ID_KEYS: &[&str] = &["gen_ai.tool.call.id", "ai.toolCall.id"];
const TOOL_DESCRIPTION_KEYS: &[&str] = &["gen_ai.tool.description", "tool.description"];
const TOOL_RESULT_KEYS: &[&str] = &["gen_ai.tool.call.result", "ai.toolCall.result"];
const RESPONSE_ID_KEYS: &[&str] = &["gen_ai.response.id", "ai.response.id"];

/// Text facts, by slot.
const OPERATION: usize = 0;
const SPAN_KIND: usize = 1;
const MODEL: usize = 2;
const AGENT_NAME: usize = 3;
const TOOL_NAME: usize = 4;
const TOOL_CALL_ID: usize = 5;
const TOOL_DESCRIPTION: usize = 6;
const TOOL_RESULT: usize = 7;
const RESPONSE_ID: usize = 8;
const ERROR_TYPE: usize = 9;
const RESPONSE_STATUS: usize = 10;
const GRAPH_NODE_ID: usize = 11;
const TEXT_KEYS: [&[&str]; 12] = [
    &["gen_ai.operation.name"],
    &["openinference.span.kind"],
    MODEL_KEYS,
    AGENT_NAME_KEYS,
    TOOL_NAME_KEYS,
    TOOL_CALL_ID_KEYS,
    TOOL_DESCRIPTION_KEYS,
    TOOL_RESULT_KEYS,
    RESPONSE_ID_KEYS,
    &["error.type"],
    &["gen_ai.response.status"],
    &["graph.node.id"],
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

/// Every key above as `(key, slot, rank)`, bucketed by the key's length;
/// `rank` is the key's place in its fact's list. A span's key is compared
/// only against the few keys of its own length, so the common miss costs an
/// index and a short loop, never a string comparison.
static KEY_TABLE: LazyLock<Vec<Vec<(&str, Slot, u8)>>> = LazyLock::new(|| {
    let mut table: Vec<Vec<(&str, Slot, u8)>> = Vec::new();
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

/// One span's facts, borrowed from its attributes.
pub(super) struct Facts<'a> {
    text: [&'a str; TEXT_KEYS.len()],
    text_rank: [u8; TEXT_KEYS.len()],
    number: [Option<f64>; NUMBER_KEYS.len()],
    number_rank: [u8; NUMBER_KEYS.len()],
}

impl<'a> Facts<'a> {
    pub(super) fn read(attrs: &'a [KeyValue]) -> Self {
        let mut facts = Self {
            text: [""; TEXT_KEYS.len()],
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
                    let value = value_str(attr);
                    if !value.is_empty() {
                        facts.text[slot] = value;
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

    pub(super) fn model(&self) -> &'a str {
        self.text[MODEL]
    }

    pub(super) fn tool_name(&self) -> &'a str {
        self.text[TOOL_NAME]
    }

    /// `gen_ai.operation.name`, else the OpenInference span kind translated.
    pub(super) fn operation(&self) -> &'a str {
        let op = self.text[OPERATION];
        if !op.is_empty() {
            return op;
        }
        match self.text[SPAN_KIND] {
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

/// `text` cut to `max` characters.
fn truncate(text: &str, max: usize) -> &str {
    text.char_indices()
        .nth(max)
        .map_or(text, |(end, _)| &text[..end])
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
    let failed = failed_status
        || !facts.text[ERROR_TYPE].is_empty()
        || ["failed", "error"]
            .iter()
            .any(|status| facts.text[RESPONSE_STATUS].eq_ignore_ascii_case(status));
    let mut text = |key: &str, value: &str| {
        if !value.is_empty() {
            stamps.push(owned_string_attribute(key, value.to_owned()));
        }
    };
    text(MODEL_ATTR, facts.model());
    text(AGENT_NAME_ATTR, agent_name(&facts, vendor, &span.name));
    text(TOOL_NAME_ATTR, facts.tool_name());
    text(TOOL_CALL_ID_ATTR, facts.text[TOOL_CALL_ID]);
    if llm_call {
        text(RESPONSE_ID_ATTR, facts.text[RESPONSE_ID]);
    }
    let result = facts.text[TOOL_RESULT];
    if tool_call {
        text(
            TOOL_DESCRIPTION_ATTR,
            truncate(facts.text[TOOL_DESCRIPTION], TOOL_DESCRIPTION_MAX),
        );
        if failed {
            text(
                TOOL_ERROR_RESULT_ATTR,
                truncate(result, TOOL_ERROR_RESULT_MAX),
            );
        }
    }
    let paused =
        tool_call && !failed && (result.is_empty() || result.contains(CONFIRMATION_REQUEST));
    for (key, holds) in [
        (TOOL_CALL_ATTR, tool_call),
        (ERROR_ATTR, failed),
        (TOOL_PAUSED_ATTR, paused),
    ] {
        if holds {
            stamps.push(owned_string_attribute(key, "1".to_owned()));
        }
    }
    stamps
}

/// The agent that owns the span. OpenAI Agents' OpenInference instrumentor
/// names an agent only in `graph.node.id` on its AGENT span, where it equals
/// the span name ("Triage Agent"); the run's root AGENT span has no node id,
/// and agno's node id is a hash that never equals the span name.
fn agent_name<'a>(facts: &Facts<'a>, vendor: &str, span_name: &str) -> &'a str {
    let node = facts.text[GRAPH_NODE_ID];
    match facts.text[AGENT_NAME] {
        "" if matches!(vendor, "openai_agents_sdk" | "unknown:openinference")
            && facts.text[SPAN_KIND] == "AGENT"
            && node == span_name =>
        {
            node
        }
        name => name,
    }
}

/// A tool call: the convention's tool operation, or, under an operation the
/// convention does not name, a tool name or a span name saying "tool".
fn is_tool_call(facts: &Facts, span_name: &str) -> bool {
    let op = facts.operation();
    op == "execute_tool"
        || (!usage::KNOWN_OPS.contains(&op)
            && (!facts.tool_name().is_empty() || name_has(span_name, "tool")))
}

/// Mark a stamped tool call as failed after the fact: Claude Code records a
/// tool run's failure on a phase span that can arrive after its call's
/// (`claude_code::fold_tool_failures`).
pub(super) fn mark_tool_failed(span: &mut Span) {
    span.attributes.retain(|attr| attr.key != TOOL_PAUSED_ATTR);
    let has = |key: &str| span.attributes.iter().any(|attr| attr.key == key);
    let result = (!has(TOOL_ERROR_RESULT_ATTR))
        .then(|| Facts::read(&span.attributes).text[TOOL_RESULT])
        .filter(|result| !result.is_empty())
        .map(|result| truncate(result, TOOL_ERROR_RESULT_MAX).to_owned());
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
    use crate::ai_session::stamp_trace_request;
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
                    (TOOL_CALL_ID_ATTR, "call_1"),
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
                    (TOOL_CALL_ID_ATTR, "call_2"),
                    (TOOL_CALL_ATTR, "1"),
                ]),
            ]
        );
    }

    /// A failure by status, by `error.type` and by response status; a failed
    /// tool call carries its result, cut, and is no paused copy.
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
        // An empty `error.type` is no failure; a call with no result is a
        // paused copy.
        assert_eq!(
            got[3],
            pairs(&[
                ("maple_ai.llm_call", "0"),
                (TOOL_CALL_ATTR, "1"),
                (TOOL_PAUSED_ATTR, "1"),
            ])
        );
    }

    /// Google ADK's human-in-the-loop capture: the paused copy's result is the
    /// confirmation request; the approved run under the same id is a call.
    #[test]
    fn a_confirmation_request_is_a_paused_copy() {
        let tool = |result: &str| {
            span(
                "execute_tool delete_file",
                &[
                    ("gen_ai.operation.name", "execute_tool"),
                    ("gen_ai.tool.name", "delete_file"),
                    ("gen_ai.tool.call.id", "adk-1"),
                    ("gen_ai.tool.call.result", result),
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
        assert!(has(&got[0], TOOL_PAUSED_ATTR));
        assert!(!has(&got[1], TOOL_PAUSED_ATTR));
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

    /// Outside the convention's operations a tool name or a span name saying
    /// "tool" makes a tool call; a memory operation never does.
    #[test]
    fn tool_calls_by_name_under_unknown_operations() {
        let got = stamps(
            "support-agent",
            vec![
                span("run_tools", &[("gen_ai.operation.name", "workflow_step")]),
                span(
                    "search_memory notes",
                    &[
                        ("gen_ai.operation.name", "search_memory"),
                        ("gen_ai.tool.name", "notes"),
                    ],
                ),
            ],
        );
        assert!(has(&got[0], TOOL_CALL_ATTR));
        assert!(!has(&got[1], TOOL_CALL_ATTR));
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
        assert_eq!(truncate("héllo", 2), "hé");
        assert_eq!(truncate("héllo", 9), "héllo");
    }

    #[test]
    fn name_has_ignores_case() {
        assert!(name_has("ai.toolCall", "tool"));
        assert!(name_has("ChatOpenAI", "chat"));
        assert!(!name_has("to", "tool"));
    }
}
