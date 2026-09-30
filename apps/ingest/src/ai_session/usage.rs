//! Which stamped span is the model call, and that call's token usage,
//! restated as five disjoint buckets under Maple-owned keys.
//!
//! `maple_ai.llm_call` is `1` on the span that IS a model call — whether or not
//! it reported usage, so a failed call still counts — and `0` on every other
//! span the gateway stamps. The key being present at all is what tells a reader
//! the gateway made that call, so a span ingested before it did falls back to
//! the reader's own op/name heuristics.
//!
//! Every emitter reports usage its own way. The prompt figure contains the
//! cache buckets on every semconv/OpenAI-shaped wire, but excludes them where a
//! framework passes a raw Anthropic Messages or Bedrock Converse response
//! through. The completion figure contains the reasoning tokens, sometimes
//! reports fewer of them than the reasoning figure does, and the same usage is
//! repeated on agent, step and workflow wrappers above the call. Settling that
//! here, once, where the vendor is known and the span is whole, means every
//! reader sums five columns instead of re-deriving the convention.
//!
//! - `maple_ai.usage.input_tokens`: prompt tokens billed at the uncached rate
//! - `maple_ai.usage.cache_read_tokens`, `maple_ai.usage.cache_write_tokens`
//! - `maple_ai.usage.output_tokens`: the visible completion
//! - `maple_ai.usage.reasoning_tokens`
//! - `maple_ai.usage.cost`: USD, as the emitter priced the call; `0` is kept,
//!   because a free call is not an unpriced one
//!
//! A span's total is the plain sum of the five token buckets. Only the span
//! that IS the model call carries them: a wrapper's figures are a roll-up of
//! its calls, so summing the buckets over a session never double counts. A
//! zero bucket is left absent, so a failed call carries none.
//!
//! The customer's own `gen_ai.usage.*` keys are left as sent: semconv defines
//! `gen_ai.usage.input_tokens` as inclusive, so writing the uncached figure
//! there would misreport the span to anyone reading it raw.

use opentelemetry_proto::tonic::common::v1::KeyValue;
use opentelemetry_proto::tonic::trace::v1::span::SpanKind;
use opentelemetry_proto::tonic::trace::v1::Span;

use super::facts::{self, name_has, Facts};
use super::owned_string_attribute;

const INPUT_TOKENS_ATTR: &str = "maple_ai.usage.input_tokens";
const CACHE_READ_TOKENS_ATTR: &str = "maple_ai.usage.cache_read_tokens";
const CACHE_WRITE_TOKENS_ATTR: &str = "maple_ai.usage.cache_write_tokens";
const OUTPUT_TOKENS_ATTR: &str = "maple_ai.usage.output_tokens";
const REASONING_TOKENS_ATTR: &str = "maple_ai.usage.reasoning_tokens";
const COST_ATTR: &str = "maple_ai.usage.cost";
const LLM_CALL_ATTR: &str = "maple_ai.llm_call";

// Each bucket's spellings, canonical first: the first key whose value parses
// as a number wins. The semconv key, its legacy and vendor spellings, then the
// Vercel AI SDK and OpenInference dialects. Read for every vendor, so an
// emitter that dual-writes two dialects is read the same way whoever it is.

pub(super) const INPUT_KEYS: &[&str] = &[
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.prompt_tokens",
    "ai.usage.inputTokens",
    "ai.usage.promptTokens",
    "llm.token_count.prompt",
];
pub(super) const CACHE_READ_KEYS: &[&str] = &[
    "gen_ai.usage.cache_read.input_tokens",
    // OpenRouter Broadcast.
    "gen_ai.usage.input_tokens.cached",
    // Strands before the semconv rename.
    "gen_ai.usage.cache_read_input_tokens",
    "ai.usage.cachedInputTokens",
    "ai.usage.inputTokenDetails.cacheReadTokens",
    "llm.token_count.prompt_details.cache_read",
];
pub(super) const CACHE_WRITE_KEYS: &[&str] = &[
    "gen_ai.usage.cache_creation.input_tokens",
    "gen_ai.usage.cache_write.input_tokens",
    "gen_ai.usage.input_tokens.cache_write",
    "gen_ai.usage.cache_write_input_tokens",
    "ai.usage.inputTokenDetails.cacheWriteTokens",
    "llm.token_count.prompt_details.cache_write",
];
pub(super) const OUTPUT_KEYS: &[&str] = &[
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.completion_tokens",
    "ai.usage.outputTokens",
    "ai.usage.completionTokens",
    "llm.token_count.completion",
];
pub(super) const REASONING_KEYS: &[&str] = &[
    "gen_ai.usage.reasoning.output_tokens",
    "gen_ai.usage.output_tokens.reasoning",
    // Mastra.
    "gen_ai.usage.reasoning_tokens",
    // Pydantic AI.
    "gen_ai.usage.details.reasoning_tokens",
    "ai.usage.reasoningTokens",
    "ai.usage.outputTokenDetails.reasoningTokens",
    "llm.token_count.completion_details.reasoning",
];
/// The Vercel AI SDK reports the disjoint figures itself; they win over any
/// arithmetic on the containing ones.
pub(super) const UNCACHED_INPUT_KEYS: &[&str] = &["ai.usage.inputTokenDetails.noCacheTokens"];
pub(super) const VISIBLE_OUTPUT_KEYS: &[&str] = &["ai.usage.outputTokenDetails.textTokens"];
pub(super) const COST_KEYS: &[&str] = &[
    "gen_ai.usage.cost",
    "gen_ai.usage.total_cost",
    "llm.cost.total",
    "litellm.cost.total",
    // Pydantic AI.
    "operation.cost",
    "openrouter.cost",
];

const INFERENCE_OPS: [&str; 4] = [
    "chat",
    "generate_content",
    "text_completion",
    "fetch_response",
];
/// Every operation the convention names, memory-store operations included:
/// none of them is a model call or a tool call by its span name.
pub(super) const KNOWN_OPS: [&str; 19] = [
    "chat",
    "generate_content",
    "text_completion",
    "fetch_response",
    "embeddings",
    "retrieval",
    "execute_tool",
    "invoke_agent",
    "create_agent",
    "invoke_workflow",
    "plan",
    "agent_step",
    "search_memory",
    "create_memory",
    "update_memory",
    "upsert_memory",
    "delete_memory",
    "create_memory_store",
    "delete_memory_store",
];

/// Bedrock cross-region inference profile prefixes (`us.anthropic.claude-…`).
const BEDROCK_REGION_PREFIXES: [&str; 4] = ["us.", "eu.", "apac.", "global."];

/// Mark whether `span` is the model call, and stamp its usage buckets if it
/// is. Returns whether it is.
pub(super) fn stamp(span: &Span, vendor: &str, facts: &Facts, out: &mut Vec<KeyValue>) -> bool {
    let call = is_model_call(vendor, span, facts);
    out.push(owned_string_attribute(
        LLM_CALL_ATTR,
        if call { "1" } else { "0" }.to_owned(),
    ));
    if !call {
        return false;
    }
    let usage = Usage::read(facts, input_excludes_cache(vendor, facts.model()));
    let tokens = [
        (INPUT_TOKENS_ATTR, usage.input),
        (CACHE_READ_TOKENS_ATTR, usage.cache_read),
        (CACHE_WRITE_TOKENS_ATTR, usage.cache_write),
        (OUTPUT_TOKENS_ATTR, usage.output),
        (REASONING_TOKENS_ATTR, usage.reasoning),
    ];
    out.extend(
        tokens
            .into_iter()
            .filter(|(_, count)| *count > 0)
            .map(|(key, count)| owned_string_attribute(key, count.to_string())),
    );
    if let Some(cost) = facts.number(facts::COST) {
        out.push(owned_string_attribute(COST_ATTR, cost.to_string()));
    }
    true
}

/// Is this span the model call itself, rather than an agent, step or workflow
/// wrapper that repeats its calls' usage?
fn is_model_call(vendor: &str, span: &Span, facts: &Facts) -> bool {
    let span_name = span.name.as_str();
    let op = facts.operation();
    match vendor {
        _ if INFERENCE_OPS.contains(&op) => true,
        "litellm" => matches!(op, "acompletion" | "completion"),
        "semantic_kernel" => matches!(op, "chat.completions" | "chat.streaming_completions"),
        // The legacy `ai` scope: the provider call, never the `ai.generateText`
        // wrapper that sums its steps.
        "vercel_ai_sdk" => {
            op.is_empty()
                && span_name.starts_with("ai.")
                && (span_name.ends_with(".doGenerate") || span_name.ends_with(".doStream"))
        }
        // A server span is the endpoint that received the request (a proxy's
        // `POST /chat/completions`), never the call it made.
        _ => {
            vendor.starts_with("unknown:")
                && span.kind != SpanKind::Server as i32
                && named_like_a_model_call(op, span_name, facts)
        }
    }
}

/// The span-name fallback `classifyAiSpan` applies to a span ingested before
/// this stamp, for a dialect Maple has no vendor rules for: an op outside the convention, not a tool, not an agent or
/// workflow, and a model named (or a name that says chat/completion).
fn named_like_a_model_call(op: &str, span_name: &str, facts: &Facts) -> bool {
    if KNOWN_OPS.contains(&op) {
        return false;
    }
    if facts.has_tool_name() || (op.is_empty() && name_has(span_name, "tool")) {
        return false;
    }
    if name_has(span_name, "agent") || name_has(span_name, "workflow") {
        return false;
    }
    !facts.model().is_empty() || name_has(span_name, "chat") || name_has(span_name, "completion")
}

/// Does the prompt figure exclude the cache buckets? Only where the emitter
/// passes a raw Anthropic Messages or Bedrock Converse response through.
/// `gen_ai.provider.name` cannot tell: it names the model's vendor, not the
/// reporting convention, and these frameworks stamp values unrelated to the
/// client (Strands `strands-agents`, ADK `gemini`, MAF `openai`).
fn input_excludes_cache(vendor: &str, model: &str) -> bool {
    match vendor {
        // Claude Code reports the Messages API's own usage.
        "claude_agent_sdk" => true,
        // Their native Anthropic/Bedrock clients pass raw usage through; their
        // OpenAI, Gemini and LiteLLM clients report it inclusive.
        "strands" | "google_adk" | "agno" | "microsoft_agent_framework" => {
            is_native_anthropic_or_bedrock_model(model)
        }
        _ => false,
    }
}

/// A model id only a native Anthropic or Bedrock client takes: `claude-…`,
/// `anthropic.claude-…`, or a Bedrock cross-region profile. A `provider/model`
/// id went through a router (LiteLLM, OpenRouter) that reports inclusive.
fn is_native_anthropic_or_bedrock_model(model: &str) -> bool {
    !model.contains('/')
        && (model.starts_with("claude")
            || model.starts_with("anthropic.")
            || BEDROCK_REGION_PREFIXES
                .iter()
                .any(|prefix| model.starts_with(prefix)))
}

#[derive(Debug, PartialEq)]
struct Usage {
    input: u64,
    cache_read: u64,
    cache_write: u64,
    output: u64,
    reasoning: u64,
}

impl Usage {
    fn read(facts: &Facts, input_excludes_cache: bool) -> Self {
        let count = |slot| facts.number(slot).map(tokens);
        let prompt = count(facts::INPUT).unwrap_or(0);
        let cache_read = count(facts::CACHE_READ).unwrap_or(0);
        let cache_write = count(facts::CACHE_WRITE).unwrap_or(0);
        let completion = count(facts::OUTPUT).unwrap_or(0);
        // An inclusive prompt cannot be smaller than the cache it contains, so
        // a prompt that is must be a raw passthrough the vendor rule missed.
        let cache = cache_read.saturating_add(cache_write);
        let excludes_cache = input_excludes_cache || cache > prompt;
        // The completion is what the provider billed (`total_tokens` is prompt
        // + completion), so a reasoning figure larger than it is clamped.
        let reasoning = count(facts::REASONING).unwrap_or(0).min(completion);
        Self {
            input: count(facts::UNCACHED_INPUT).unwrap_or(if excludes_cache {
                prompt
            } else {
                prompt - cache
            }),
            cache_read,
            cache_write,
            output: count(facts::VISIBLE_OUTPUT).unwrap_or(completion - reasoning),
            reasoning,
        }
    }
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a finite, non-negative token count; a fraction is dropped"
)]
fn tokens(value: f64) -> u64 {
    value as u64
}

/// Each integration's usage spans as its instrumentation exports them: from
/// the trace-capture recordings (`captures/<id>`), from EU production spans
/// (PROD), or, where no capture exercises the path, from the framework source
/// that builds the figures (SRC).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_session::{stamp_trace_request, value_str, VENDOR_ID_ATTR};
    use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
    use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope};
    use opentelemetry_proto::tonic::resource::v1::Resource;
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans};

    type Attrs<'a> = &'a [(&'a str, &'a str)];

    /// input, cache read, cache write, output, reasoning.
    type Buckets = [u64; 5];

    #[derive(Debug)]
    struct Stamped {
        vendor: String,
        /// `maple_ai.llm_call`, absent on a span the gateway did not stamp.
        llm_call: Option<String>,
        buckets: Option<Buckets>,
        cost: Option<String>,
    }

    /// One scope's spans through the gateway's stamping pass.
    fn stamp_spans(service: &str, scope: &str, spans: &[(&str, Attrs)]) -> Vec<Stamped> {
        stamp_request(
            service,
            scope,
            spans
                .iter()
                .map(|(name, attrs)| Span {
                    name: (*name).to_owned(),
                    attributes: kvs(attrs),
                    ..Default::default()
                })
                .collect(),
        )
    }

    fn stamp_request(service: &str, scope: &str, spans: Vec<Span>) -> Vec<Stamped> {
        let mut request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource {
                    attributes: kvs(&[("service.name", service)]),
                    ..Default::default()
                }),
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
                let attrs = &span.attributes;
                let text = |key| {
                    attrs
                        .iter()
                        .find(|attr| attr.key == key)
                        .map_or("", value_str)
                };
                let bucket = |key| text(key).parse().unwrap_or(0);
                let has_buckets = attrs
                    .iter()
                    .any(|attr| attr.key.starts_with("maple_ai.usage.") && attr.key != COST_ATTR);
                Stamped {
                    vendor: text(VENDOR_ID_ATTR).to_owned(),
                    llm_call: attrs
                        .iter()
                        .find(|attr| attr.key == LLM_CALL_ATTR)
                        .map(|attr| value_str(attr).to_owned()),
                    buckets: has_buckets.then(|| {
                        [
                            bucket(INPUT_TOKENS_ATTR),
                            bucket(CACHE_READ_TOKENS_ATTR),
                            bucket(CACHE_WRITE_TOKENS_ATTR),
                            bucket(OUTPUT_TOKENS_ATTR),
                            bucket(REASONING_TOKENS_ATTR),
                        ]
                    }),
                    cost: attrs
                        .iter()
                        .find(|attr| attr.key == COST_ATTR)
                        .map(|attr| value_str(attr).to_owned()),
                }
            })
            .collect()
    }

    fn kvs(pairs: Attrs) -> Vec<KeyValue> {
        pairs
            .iter()
            .map(|(key, value)| owned_string_attribute(key, (*value).to_owned()))
            .collect()
    }

    /// Stamp, then check every span's vendor and buckets (`None`: the span
    /// owns no usage).
    fn check(service: &str, scope: &str, vendor: &str, spans: &[(&str, Attrs, Option<Buckets>)]) {
        let stamped = stamp_spans(
            service,
            scope,
            &spans
                .iter()
                .map(|(name, attrs, _)| (*name, *attrs))
                .collect::<Vec<_>>(),
        );
        for ((name, _, expected), got) in spans.iter().zip(&stamped) {
            assert_eq!(got.vendor, vendor, "{name}: vendor");
            assert_eq!(got.buckets, *expected, "{name}: buckets");
            // Every span here that owns usage is the model call, and every one
            // that owns none is a wrapper.
            let call = if expected.is_some() { "1" } else { "0" };
            assert_eq!(got.llm_call.as_deref(), Some(call), "{name}: llm_call");
        }
    }

    fn sum(stamped: &[Stamped]) -> Buckets {
        stamped
            .iter()
            .filter_map(|span| span.buckets)
            .fold([0; 5], |mut total, buckets| {
                for (sum, bucket) in total.iter_mut().zip(buckets) {
                    *sum += bucket;
                }
                total
            })
    }

    fn slices<'a>(spans: &'a [(&'a str, Vec<(&'a str, &'a str)>)]) -> Vec<(&'a str, Attrs<'a>)> {
        spans
            .iter()
            .map(|(name, attrs)| (*name, attrs.as_slice()))
            .collect()
    }

    // --- Evidence cases from the design ---------------------------------

    /// (a) An inclusive emitter labelled `anthropic` is not Anthropic's raw
    /// convention. PROD OpenRouter Broadcast, session f0f992b0: 5021 in, 4248
    /// cached, 263 out (37 reasoning), total 5284. The index used to count
    /// 9532.
    #[test]
    fn openrouter_broadcast_labelled_anthropic_is_inclusive() {
        let stamped = stamp_spans(
            "openrouter",
            "openrouter",
            &[(
                "LLM Generation",
                &[
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.provider.name", "anthropic"),
                    ("gen_ai.system", "anthropic"),
                    ("gen_ai.request.model", "anthropic/claude-haiku-4.5"),
                    ("gen_ai.response.id", "gen-1785984177-CuGnP5CaGaQSBKXIWTKd"),
                    ("gen_ai.usage.input_cost", "0.00138905"),
                    ("gen_ai.usage.input_tokens", "5021"),
                    ("gen_ai.usage.input_tokens.cached", "4248"),
                    ("gen_ai.usage.output_cost", "0.001315"),
                    ("gen_ai.usage.output_tokens", "263"),
                    ("gen_ai.usage.output_tokens.reasoning", "37"),
                    ("gen_ai.usage.total_cost", "0.00270405"),
                    ("gen_ai.usage.total_tokens", "5284"),
                ],
            )],
        );
        assert_eq!(stamped[0].vendor, "openrouter");
        assert_eq!(stamped[0].buckets, Some([773, 4248, 0, 226, 37]));
        assert_eq!(sum(&stamped).iter().sum::<u64>(), 5284);
        assert_eq!(stamped[0].cost.as_deref(), Some("0.00270405"));
    }

    /// (a) `captures/docs_provider-sdks_anthropic`, OTel genai anthropic
    /// instrumentation: the prompt contains the cache write, then the read.
    /// The index used to count 15594 for the second call against a real 8013.
    #[test]
    fn otel_genai_anthropic_is_inclusive() {
        let chat = |cache_key, input, output| {
            [
                ("gen_ai.operation.name", "chat"),
                ("gen_ai.provider.name", "anthropic"),
                ("gen_ai.request.model", "anthropic/claude-haiku-4.5"),
                (cache_key, "7581"),
                ("gen_ai.usage.input_tokens", input),
                ("gen_ai.usage.output_tokens", output),
            ]
        };
        check(
            "docs-verify-provider-sdks",
            "opentelemetry.instrumentation.genai.anthropic",
            "unknown:genai",
            &[
                (
                    "chat anthropic/claude-haiku-4.5",
                    &chat("gen_ai.usage.cache_write.input_tokens", "7911", "54"),
                    Some([330, 0, 7581, 54, 0]),
                ),
                (
                    "chat anthropic/claude-haiku-4.5",
                    &chat("gen_ai.usage.cache_read.input_tokens", "7999", "14"),
                    Some([418, 7581, 0, 14, 0]),
                ),
            ],
        );
    }

    /// (b) `captures/docs_strands_ts`: `invoke_agent` repeats the sum of its
    /// chats (246 = 104 + 142, 386 = 172 + 214) under an unstamped loop span.
    /// The session is 632 tokens, not 1264.
    #[test]
    fn strands_ts_agent_roll_up_owns_no_usage() {
        let service = "docs-verify-strands-ts";
        let span = |op, input, output| {
            vec![
                ("gen_ai.operation.name", op),
                ("gen_ai.provider.name", service),
                ("gen_ai.request.model", "openai/gpt-4o-mini"),
                ("gen_ai.event.start_time", "2026-09-10T10:00:00.000Z"),
                ("gen_ai.usage.input_tokens", input),
                ("gen_ai.usage.prompt_tokens", input),
                ("gen_ai.usage.output_tokens", output),
                ("gen_ai.usage.completion_tokens", output),
            ]
        };
        let spans = [
            ("chat", span("chat", "90", "14")),
            ("chat", span("chat", "128", "14")),
            (
                "invoke_agent support_agent",
                span("invoke_agent", "218", "28"),
            ),
            ("chat", span("chat", "157", "15")),
            ("chat", span("chat", "193", "21")),
            (
                "invoke_agent support_agent",
                span("invoke_agent", "350", "36"),
            ),
        ];
        let stamped = stamp_spans(service, service, &slices(&spans));
        assert!(stamped.iter().all(|span| span.vendor == "strands"));
        assert_eq!(stamped[2].buckets, None);
        assert_eq!(stamped[5].buckets, None);
        assert_eq!(sum(&stamped).iter().sum::<u64>(), 632);
    }

    /// (c) PROD `blind-ts-langchain-demo-001`, OpenInference LangChain JS with
    /// the GenAI mirror (`langchain`): (prompt, completion, reasoning).
    /// Three calls report more reasoning than completion; the total is still
    /// the sum of `llm.token_count.total`, 17763. The list used to read output
    /// 1206 / reasoning 3098 / total 17827, the page 4240 / 0 / 17763.
    #[test]
    fn langchain_js_reasoning_is_clamped_to_the_completion() {
        const CALLS: [(&str, &str, &str); 23] = [
            ("386", "113", "64"),
            ("437", "335", "256"),
            ("484", "204", "128"),
            ("531", "186", "128"),
            ("606", "179", "128"),
            ("647", "26", ""),
            ("688", "21", ""),
            ("732", "73", "95"),
            ("781", "283", "192"),
            ("386", "192", "128"),
            ("441", "366", "256"),
            ("531", "163", "128"),
            ("572", "26", ""),
            ("613", "15", ""),
            ("651", "77", "92"),
            ("700", "610", "512"),
            ("386", "329", "256"),
            ("489", "401", "256"),
            ("610", "244", "192"),
            ("651", "26", ""),
            ("692", "15", ""),
            ("730", "68", "95"),
            ("779", "288", "192"),
        ];
        let spans: Vec<(&str, Vec<(&str, &str)>)> = CALLS
            .iter()
            .map(|(prompt, completion, reasoning)| {
                let mut attrs = vec![
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.provider.name", "openai"),
                    ("gen_ai.request.model", "openai/gpt-5-mini"),
                    ("gen_ai.usage.input_tokens", *prompt),
                    ("gen_ai.usage.output_tokens", *completion),
                    ("llm.token_count.prompt", *prompt),
                    ("llm.token_count.completion", *completion),
                    ("openinference.span.kind", "LLM"),
                ];
                if !reasoning.is_empty() {
                    attrs.push(("llm.token_count.completion_details.reasoning", *reasoning));
                }
                ("ChatOpenAI", attrs)
            })
            .collect();
        let stamped = stamp_spans(
            "blind-ts-langchain",
            "@arizeai/openinference-instrumentation-langchain",
            &slices(&spans),
        );
        assert!(stamped.iter().all(|span| span.vendor == "langchain"));
        // 73 completion, 95 reasoning: all of the completion was reasoning.
        assert_eq!(stamped[7].buckets, Some([732, 0, 0, 0, 73]));
        let total = sum(&stamped);
        assert_eq!(total, [13523, 0, 0, 1206, 3034]);
        assert_eq!(total.iter().sum::<u64>(), 17763);
    }

    /// (d) PROD `cs-demo-004`, OpenAI Agents TS (OpenInference keys only):
    /// (prompt, completion, reasoning). One generation reports 107 reasoning
    /// inside a 96 completion; the session is Σ `llm.token_count.total`, 4667,
    /// not 4678.
    #[test]
    fn openai_agents_ts_reasoning_is_clamped_to_the_completion() {
        const CALLS: [(&str, &str, &str); 7] = [
            ("245", "146", "64"),
            ("330", "96", "107"),
            ("402", "299", "192"),
            ("480", "603", "576"),
            ("468", "213", "128"),
            ("576", "158", "128"),
            ("622", "29", "0"),
        ];
        let spans: Vec<(&str, Vec<(&str, &str)>)> = CALLS
            .iter()
            .map(|(prompt, completion, reasoning)| {
                (
                    "generation",
                    vec![
                        ("llm.model_name", "openai/gpt-5-mini"),
                        ("llm.system", "openai"),
                        ("llm.token_count.completion", *completion),
                        ("llm.token_count.completion_details.reasoning", *reasoning),
                        ("llm.token_count.prompt", *prompt),
                        ("llm.token_count.prompt_details.cache_read", "0"),
                        ("openinference.span.kind", "LLM"),
                    ],
                )
            })
            .collect();
        let stamped = stamp_spans(
            "blind-ts-openai-agents",
            "@arizeai/openinference-instrumentation-openai-agents",
            &slices(&spans),
        );
        assert!(stamped
            .iter()
            .all(|span| span.vendor == "openai_agents_sdk"));
        assert_eq!(stamped[1].buckets, Some([330, 0, 0, 0, 96]));
        assert_eq!(sum(&stamped).iter().sum::<u64>(), 4667);
    }

    /// (d) PROD `maple-demo-20260929-163938`, Vercel AI SDK v7 through
    /// OpenRouter: (input, output, text, reasoning). The SDK's own text figure
    /// is the visible output; the session is Σ input + output, 6686, not 6707.
    #[test]
    fn vercel_v7_reasoning_past_the_completion_is_clamped() {
        const CALLS: [(&str, &str, &str, &str); 12] = [
            ("145", "81", "0", "102"),
            ("190", "59", "59", "0"),
            ("231", "111", "47", "64"),
            ("282", "239", "111", "128"),
            ("213", "85", "1", "84"),
            ("258", "114", "50", "64"),
            ("315", "181", "53", "128"),
            ("402", "232", "40", "192"),
            ("467", "219", "91", "128"),
            ("552", "222", "94", "128"),
            ("635", "202", "74", "128"),
            ("678", "573", "125", "448"),
        ];
        let spans: Vec<(&str, Vec<(&str, &str)>)> = CALLS
            .iter()
            .map(|(input, output, text, reasoning)| {
                (
                    "chat openai/gpt-5-mini",
                    vec![
                        ("ai.usage.inputTokenDetails.noCacheTokens", *input),
                        ("ai.usage.outputTokenDetails.reasoningTokens", *reasoning),
                        ("ai.usage.outputTokenDetails.textTokens", *text),
                        ("gen_ai.operation.name", "chat"),
                        ("gen_ai.provider.name", "openrouter.chat"),
                        ("gen_ai.request.model", "openai/gpt-5-mini"),
                        ("gen_ai.usage.cache_creation.input_tokens", "0"),
                        ("gen_ai.usage.cache_read.input_tokens", "0"),
                        ("gen_ai.usage.input_tokens", *input),
                        ("gen_ai.usage.output_tokens", *output),
                    ],
                )
            })
            .collect();
        let stamped = stamp_spans("blind-ts-vercel-ai", "gen_ai", &slices(&spans));
        assert!(stamped.iter().all(|span| span.vendor == "vercel_ai_sdk"));
        assert_eq!(stamped[0].buckets, Some([145, 0, 0, 0, 81]));
        let total = sum(&stamped);
        assert_eq!(total, [4368, 0, 0, 745, 1573]);
        assert_eq!(total.iter().sum::<u64>(), 6686);
    }

    // --- One case per integration ---------------------------------------

    /// `captures/docs_vercel-ai-sdk_b`: `invoke_agent` and `step N` repeat the
    /// chat's figures.
    #[test]
    fn vercel_v7_only_the_chat_span_owns_usage() {
        let figures = [
            ("ai.usage.inputTokenDetails.noCacheTokens", "127"),
            ("ai.usage.outputTokenDetails.reasoningTokens", "0"),
            ("ai.usage.outputTokenDetails.textTokens", "81"),
        ];
        let mut agent = vec![
            ("gen_ai.operation.name", "invoke_agent"),
            ("gen_ai.provider.name", "openrouter"),
            ("gen_ai.request.model", "openai/gpt-4o-mini"),
            ("gen_ai.usage.input_tokens", "127"),
            ("gen_ai.usage.output_tokens", "81"),
        ];
        agent.extend(figures);
        let mut step = vec![("gen_ai.operation.name", "agent_step")];
        step.extend(figures);
        let mut chat = agent.clone();
        chat[0] = ("gen_ai.operation.name", "chat");
        check(
            "docs-verify-vercel-ai-sdk",
            "gen_ai",
            "vercel_ai_sdk",
            &[
                ("invoke_agent openai/gpt-4o-mini", &agent, None),
                ("step 1", &step, None),
                ("chat openai/gpt-4o-mini", &chat, Some([127, 0, 0, 81, 0])),
            ],
        );
    }

    /// `captures/vercel_ai_sdk_user_legacy`: the `ai` scope has no operation
    /// names; `ai.generateText` sums its `doGenerate` calls.
    #[test]
    fn vercel_legacy_only_do_generate_owns_usage() {
        let usage = [
            ("ai.model.provider", "openrouter"),
            ("ai.usage.cachedInputTokens", "0"),
            ("ai.usage.inputTokenDetails.cacheReadTokens", "0"),
            ("ai.usage.inputTokenDetails.cacheWriteTokens", "0"),
            ("ai.usage.inputTokenDetails.noCacheTokens", "209"),
            ("ai.usage.inputTokens", "209"),
            ("ai.usage.outputTokenDetails.reasoningTokens", "0"),
            ("ai.usage.outputTokenDetails.textTokens", "44"),
            ("ai.usage.outputTokens", "44"),
            ("ai.usage.reasoningTokens", "0"),
            ("ai.usage.totalTokens", "253"),
        ];
        let mut call = usage.to_vec();
        call.extend([
            ("gen_ai.request.model", "openai/gpt-4o-mini"),
            ("gen_ai.system", "openrouter"),
            ("gen_ai.usage.input_tokens", "209"),
            ("gen_ai.usage.output_tokens", "44"),
        ]);
        check(
            "vercel-legacy",
            "ai",
            "vercel_ai_sdk",
            &[
                ("ai.generateText", &usage, None),
                (
                    "ai.generateText.doGenerate",
                    &call,
                    Some([209, 0, 0, 44, 0]),
                ),
            ],
        );
    }

    /// `captures/docs_openai-agents_a`: OpenInference keys plus the GenAI
    /// mirror on the `generation` span.
    #[test]
    fn openai_agents_python_generation() {
        check(
            "docs-verify-openai-agents",
            "openinference.instrumentation.openai_agents",
            "openai_agents_sdk",
            &[(
                "generation",
                &[
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.provider.name", "openai"),
                    ("gen_ai.request.model", "openai/gpt-4o-mini"),
                    ("gen_ai.usage.input_tokens", "149"),
                    ("gen_ai.usage.output_tokens", "34"),
                    ("llm.model_name", "openai/gpt-4o-mini"),
                    ("llm.system", "openai"),
                    ("llm.token_count.completion", "34"),
                    ("llm.token_count.prompt", "149"),
                    ("openinference.span.kind", "LLM"),
                ],
                Some([149, 0, 0, 34, 0]),
            )],
        );
    }

    /// `captures/docs_langchain_a` (OpenInference LangChain py) and
    /// `captures/docs_langchain_ls` (LangSmith OTel).
    #[test]
    fn langchain_openinference_and_langsmith() {
        check(
            "docs-verify-langchain",
            "openinference.instrumentation.langchain",
            "langchain",
            &[(
                "ChatOpenAI",
                &[
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.provider.name", "openai"),
                    ("gen_ai.request.model", "openai/gpt-4o-mini"),
                    ("gen_ai.usage.cache_read.input_tokens", "0"),
                    ("gen_ai.usage.input_tokens", "143"),
                    ("gen_ai.usage.output_tokens", "32"),
                    ("llm.token_count.completion", "32"),
                    ("llm.token_count.completion_details.reasoning", "0"),
                    ("llm.token_count.prompt", "143"),
                    ("llm.token_count.prompt_details.cache_read", "0"),
                    ("llm.token_count.total", "175"),
                    ("openinference.span.kind", "LLM"),
                ],
                Some([143, 0, 0, 32, 0]),
            )],
        );
        check(
            "docs-verify-langchain",
            "langsmith",
            "langchain",
            &[(
                "ChatOpenAI",
                &[
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.request.model", "openai/gpt-4o-mini"),
                    ("gen_ai.system", "openai"),
                    ("gen_ai.usage.input_tokens", "143"),
                    ("gen_ai.usage.output_tokens", "32"),
                    ("gen_ai.usage.total_tokens", "175"),
                ],
                Some([143, 0, 0, 32, 0]),
            )],
        );
    }

    /// `captures/docs_pydantic-ai_a`: the agent's `aggregated_usage` is a
    /// roll-up; the chat carries `operation.cost`. With an Anthropic model
    /// Pydantic AI still sums the cache into the prompt (SRC
    /// `models/anthropic.py:2642-2684`), whatever `provider.name` says.
    #[test]
    fn pydantic_ai_chat_owns_usage_and_cost() {
        let stamped = stamp_spans(
            "docs-verify-pydantic-ai",
            "pydantic-ai",
            &[
                (
                    "invoke_agent assistant",
                    &[
                        ("gen_ai.aggregated_usage.details.reasoning_tokens", "0"),
                        ("gen_ai.aggregated_usage.input_tokens", "133"),
                        ("gen_ai.aggregated_usage.output_tokens", "46"),
                        ("gen_ai.operation.name", "invoke_agent"),
                    ],
                ),
                (
                    "chat openai/gpt-4o-mini",
                    &[
                        ("gen_ai.operation.name", "chat"),
                        ("gen_ai.provider.name", "openrouter"),
                        ("gen_ai.request.model", "openai/gpt-4o-mini"),
                        ("gen_ai.usage.details.is_byok", "False"),
                        ("gen_ai.usage.details.reasoning_tokens", "0"),
                        ("gen_ai.usage.input_tokens", "133"),
                        ("gen_ai.usage.output_tokens", "46"),
                        ("operation.cost", "4.755e-05"),
                    ],
                ),
                (
                    "chat claude-sonnet-4-5",
                    &[
                        ("gen_ai.operation.name", "chat"),
                        ("gen_ai.provider.name", "anthropic"),
                        ("gen_ai.request.model", "claude-sonnet-4-5"),
                        ("gen_ai.usage.input_tokens", "5200"),
                        ("gen_ai.usage.cache_read.input_tokens", "4000"),
                        ("gen_ai.usage.cache_creation.input_tokens", "1000"),
                        ("gen_ai.usage.output_tokens", "300"),
                        ("gen_ai.usage.details.reasoning_tokens", "120"),
                    ],
                ),
            ],
        );
        assert!(stamped.iter().all(|span| span.vendor == "pydantic_ai"));
        assert_eq!(stamped[0].buckets, None);
        assert_eq!(stamped[1].buckets, Some([133, 0, 0, 46, 0]));
        assert_eq!(stamped[1].cost.as_deref(), Some("0.00004755"));
        assert_eq!(stamped[2].buckets, Some([200, 4000, 1000, 180, 120]));
    }

    /// `captures/docs_strands_a` and `captures/strands_agents` (the pre-rename
    /// cache keys). A native Anthropic or Bedrock model passes the raw,
    /// cache-exclusive usage through (SRC `models/anthropic.py:374-387`,
    /// `models/bedrock.py:1018-1029`); a routed one does not.
    #[test]
    fn strands_python_chat_and_native_anthropic_models() {
        let chat = |model, input, cache_read| {
            vec![
                ("gen_ai.operation.name", "chat"),
                ("gen_ai.provider.name", "strands-agents"),
                ("gen_ai.request.model", model),
                ("gen_ai.usage.input_tokens", input),
                ("gen_ai.usage.prompt_tokens", input),
                ("gen_ai.usage.cache_read_input_tokens", cache_read),
                ("gen_ai.usage.output_tokens", "35"),
                ("gen_ai.usage.completion_tokens", "35"),
            ]
        };
        check(
            "docs-verify-strands",
            "strands.telemetry.tracer",
            "strands",
            &[
                (
                    "invoke_agent support_agent",
                    &[
                        ("gen_ai.operation.name", "invoke_agent"),
                        ("gen_ai.system", "strands-agents"),
                        ("gen_ai.request.model", "openai/gpt-4o-mini"),
                        ("gen_ai.usage.cache_read_input_tokens", "0"),
                        ("gen_ai.usage.cache_write_input_tokens", "0"),
                        ("gen_ai.usage.input_tokens", "103"),
                        ("gen_ai.usage.output_tokens", "118"),
                    ],
                    None,
                ),
                (
                    "chat",
                    &chat("openai/gpt-4o-mini", "175", "0"),
                    Some([175, 0, 0, 35, 0]),
                ),
                (
                    "chat",
                    &chat("us.anthropic.claude-sonnet-4-20250514-v1:0", "12", "4000"),
                    Some([12, 4000, 0, 35, 0]),
                ),
                (
                    "chat",
                    &chat("claude-sonnet-4-20250514", "4012", "4000"),
                    Some([4012, 4000, 0, 35, 0]),
                ),
                (
                    "chat",
                    &chat("anthropic/claude-sonnet-4", "4012", "4000"),
                    Some([12, 4000, 0, 35, 0]),
                ),
            ],
        );
    }

    /// `captures/smolagents_agents`: `*.run` (AGENT) totals its steps.
    #[test]
    fn smolagents_run_owns_no_usage() {
        check(
            "smolagents-agents",
            "openinference.instrumentation.smolagents",
            "smolagents",
            &[
                (
                    "orchestrator.run",
                    &[
                        ("llm.token_count.completion", "406"),
                        ("llm.token_count.prompt", "7638"),
                        ("llm.token_count.total", "8044"),
                        ("openinference.span.kind", "AGENT"),
                    ],
                    None,
                ),
                (
                    "OpenAIModel.generate",
                    &[
                        ("llm.model_name", "openai/gpt-4o-mini"),
                        ("llm.provider", "openai"),
                        ("llm.system", "openai"),
                        ("llm.token_count.completion", "97"),
                        ("llm.token_count.prompt", "1793"),
                        ("llm.token_count.total", "1890"),
                        ("openinference.span.kind", "LLM"),
                    ],
                    Some([1793, 0, 0, 97, 0]),
                ),
            ],
        );
    }

    /// `captures/docs_google-adk_a`: Python ADK's `call_llm` and its
    /// `generate_content` child carry the same figures, and only the child
    /// names an operation. ADK's AnthropicLlm passes the raw usage through (SRC).
    #[test]
    fn google_adk_generate_content_owns_usage() {
        let usage = [
            ("gen_ai.usage.cache_read.input_tokens", "0"),
            ("gen_ai.usage.input_tokens", "177"),
            ("gen_ai.usage.output_tokens", "32"),
        ];
        let mut call_llm = vec![
            ("gen_ai.request.model", "openrouter/openai/gpt-4o-mini"),
            ("gen_ai.system", "gcp.vertex.agent"),
        ];
        call_llm.extend(usage);
        let mut generate = vec![
            ("gen_ai.operation.name", "generate_content"),
            ("gen_ai.request.model", "openrouter/openai/gpt-4o-mini"),
        ];
        generate.extend(usage);
        check(
            "docs-verify-google-adk",
            "gcp.vertex.agent",
            "google_adk",
            &[
                ("call_llm", &call_llm, None),
                (
                    "generate_content openrouter/openai/gpt-4o-mini",
                    &generate,
                    Some([177, 0, 0, 32, 0]),
                ),
                (
                    "generate_content claude-sonnet-4-5@20250929",
                    &[
                        ("gen_ai.operation.name", "generate_content"),
                        ("gen_ai.request.model", "claude-sonnet-4-5@20250929"),
                        ("gen_ai.usage.cache_read.input_tokens", "3000"),
                        ("gen_ai.usage.input_tokens", "3200"),
                        ("gen_ai.usage.output_tokens", "40"),
                    ],
                    Some([3200, 3000, 0, 40, 0]),
                ),
            ],
        );
    }

    /// PROD `verify2-adk-ts-synthetic`: TypeScript ADK has no `generate_content`
    /// span, so the `call_llm` the Maple processor stamps `chat` is the call.
    #[test]
    fn google_adk_ts_call_llm_owns_usage() {
        check(
            "verify2-adk-ts-synthetic",
            "gcp.vertex.agent",
            "google_adk",
            &[(
                "call_llm",
                &[
                    ("gcp.vertex.agent.session_id", "verify2-adk-ts-synthetic-1"),
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.provider.name", "gcp.gemini"),
                    ("gen_ai.request.model", "gemini-2.5-flash"),
                    ("gen_ai.usage.cache_read.input_tokens", "400"),
                    ("gen_ai.usage.input_tokens", "1000"),
                    ("gen_ai.usage.output_tokens", "100"),
                ],
                Some([600, 400, 0, 100, 0]),
            )],
        );
    }

    /// `captures/docs_mastra_b` for the keys, PROD `blind-ts-mastra` for the
    /// reasoning figure Maple used to drop.
    #[test]
    fn mastra_reasoning_tokens_key() {
        check(
            "docs-verify-mastra",
            "@mastra/otel-exporter",
            "mastra",
            &[(
                "chat openai/gpt-5-mini",
                &[
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.provider.name", "openrouter"),
                    ("gen_ai.request.model", "openai/gpt-5-mini"),
                    ("gen_ai.usage.cache_creation.input_tokens", "0"),
                    ("gen_ai.usage.cache_read.input_tokens", "0"),
                    ("gen_ai.usage.input_tokens", "849"),
                    ("gen_ai.usage.output_tokens", "2200"),
                    ("gen_ai.usage.reasoning_tokens", "1792"),
                ],
                Some([849, 0, 0, 408, 1792]),
            )],
        );
    }

    /// `captures/litellm_agents` (`litellm_request`, op `acompletion`) and
    /// `captures/docs_litellm_a` (semconv `chat`, under an app `invoke_agent`
    /// that repeats the call's cost).
    #[test]
    fn litellm_request_and_semconv_chat() {
        check(
            "litellm-agents",
            "litellm",
            "litellm",
            &[
                (
                    "litellm_request",
                    &[
                        ("gen_ai.operation.name", "acompletion"),
                        ("gen_ai.request.model", "openai/gpt-4o-mini"),
                        ("gen_ai.system", "openrouter"),
                        ("gen_ai.usage.input_tokens", "107"),
                        ("gen_ai.usage.output_tokens", "81"),
                        ("gen_ai.usage.total_tokens", "188"),
                    ],
                    Some([107, 0, 0, 81, 0]),
                ),
                (
                    "raw_gen_ai_request",
                    &[("llm.openrouter.usage", "{'prompt_tokens': 107}")],
                    None,
                ),
            ],
        );
        let stamped = stamp_spans(
            "docs-verify-litellm",
            "litellm",
            &[(
                "chat openai/gpt-4o-mini",
                &[
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.provider.name", "openrouter"),
                    ("gen_ai.request.model", "openai/gpt-4o-mini"),
                    ("gen_ai.usage.cache_creation.input_tokens", "0"),
                    ("gen_ai.usage.cache_read.input_tokens", "0"),
                    ("gen_ai.usage.completion_tokens", "26"),
                    ("gen_ai.usage.input_tokens", "89"),
                    ("gen_ai.usage.output_tokens", "26"),
                    ("gen_ai.usage.prompt_tokens", "89"),
                    ("gen_ai.usage.total_tokens", "115"),
                    ("litellm.cost.total", "2.895e-05"),
                ],
            )],
        );
        assert_eq!(stamped[0].buckets, Some([89, 0, 0, 26, 0]));
        assert_eq!(stamped[0].cost.as_deref(), Some("0.00002895"));
        let app = stamp_spans(
            "docs-verify-litellm",
            "docs-verify-litellm",
            &[(
                "invoke_agent assistant",
                &[
                    ("gen_ai.operation.name", "invoke_agent"),
                    ("gen_ai.usage.cost", "2.895e-05"),
                ],
            )],
        );
        assert_eq!(app[0].vendor, "unknown:genai");
        assert!(app[0].buckets.is_none() && app[0].cost.is_none());
    }

    /// `captures/claude_agent_sdk_agents`: the Messages API's own usage, with
    /// the cache outside `input_tokens`.
    #[test]
    fn claude_code_is_cache_exclusive() {
        check(
            "claude-code",
            "com.anthropic.claude_code.tracing",
            "claude_agent_sdk",
            &[(
                "claude_code.llm_request",
                &[
                    ("cache_creation_tokens", "2025"),
                    ("cache_read_tokens", "0"),
                    ("gen_ai.request.model", "anthropic/claude-sonnet-4.5"),
                    ("gen_ai.system", "anthropic"),
                    ("input_tokens", "3"),
                    ("output_tokens", "93"),
                ],
                Some([3, 0, 2025, 93, 0]),
            )],
        );
    }

    /// `captures/docs_agno_a`, and agno's native Claude model (SRC).
    #[test]
    fn agno_invoke_and_native_claude() {
        let stamped = stamp_spans(
            "docs-verify-agno",
            "openinference.instrumentation.agno",
            &[
                (
                    "OpenRouter.invoke",
                    &[
                        ("gen_ai.operation.name", "chat"),
                        ("gen_ai.provider.name", "openai"),
                        ("gen_ai.request.model", "openai/gpt-4o-mini"),
                        ("gen_ai.usage.input_tokens", "171"),
                        ("gen_ai.usage.output_tokens", "46"),
                        ("llm.cost.total", "5.325e-05"),
                        ("llm.model_name", "openai/gpt-4o-mini"),
                        ("llm.provider", "OpenRouter"),
                        ("llm.token_count.completion", "46"),
                        ("llm.token_count.prompt", "171"),
                        ("openinference.span.kind", "LLM"),
                    ],
                ),
                (
                    "Claude.invoke",
                    &[
                        ("llm.model_name", "claude-sonnet-4-5"),
                        ("llm.provider", "Anthropic"),
                        ("llm.token_count.completion", "60"),
                        ("llm.token_count.prompt", "3600"),
                        ("llm.token_count.prompt_details.cache_read", "3000"),
                        ("llm.token_count.prompt_details.cache_write", "500"),
                        ("openinference.span.kind", "LLM"),
                    ],
                ),
            ],
        );
        assert!(stamped.iter().all(|span| span.vendor == "agno"));
        assert_eq!(stamped[0].buckets, Some([171, 0, 0, 46, 0]));
        assert_eq!(stamped[0].cost.as_deref(), Some("0.00005325"));
        assert_eq!(stamped[1].buckets, Some([3600, 3000, 500, 60, 0]));
    }

    /// `captures/crewai_agents`: the OpenAI OpenInference instrumentor under
    /// crewAI.
    #[test]
    fn openinference_openai_chat_completion() {
        check(
            "crewai-agents",
            "openinference.instrumentation.openai",
            "openinference-openai",
            &[(
                "ChatCompletion",
                &[
                    ("llm.model_name", "anthropic/claude-haiku-4.5"),
                    ("llm.system", "openai"),
                    ("llm.token_count.completion", "159"),
                    ("llm.token_count.completion_details.reasoning", "0"),
                    ("llm.token_count.prompt", "890"),
                    ("llm.token_count.prompt_details.cache_read", "0"),
                    ("llm.token_count.total", "1049"),
                    ("openinference.span.kind", "LLM"),
                ],
                Some([890, 0, 0, 159, 0]),
            )],
        );
    }

    /// `captures/docs_microsoft-agent-framework_a`: `invoke_agent` sums its
    /// own chats. MAF's Anthropic client passes the raw usage through (SRC
    /// `agent_framework_anthropic/_chat_client.py:1162-1170`).
    #[test]
    fn microsoft_agent_framework_chat_owns_usage() {
        let usage = [
            ("gen_ai.usage.cache_creation.input_tokens", "0"),
            ("gen_ai.usage.cache_read.input_tokens", "0"),
            ("gen_ai.usage.input_tokens", "176"),
            ("gen_ai.usage.output_tokens", "48"),
            ("gen_ai.usage.reasoning.output_tokens", "0"),
        ];
        let mut agent = vec![
            ("gen_ai.operation.name", "invoke_agent"),
            ("gen_ai.provider.name", "microsoft.agent_framework"),
            ("gen_ai.request.model", "openai/gpt-4o-mini"),
        ];
        agent.extend(usage);
        let mut chat = vec![
            ("gen_ai.operation.name", "chat"),
            ("gen_ai.provider.name", "openai"),
            ("gen_ai.request.model", "openai/gpt-4o-mini"),
        ];
        chat.extend(usage);
        check(
            "docs-verify-maf",
            "agent_framework",
            "microsoft_agent_framework",
            &[
                ("invoke_agent support_agent", &agent, None),
                ("chat openai/gpt-4o-mini", &chat, Some([176, 0, 0, 48, 0])),
                (
                    "chat claude-sonnet-4-5",
                    &[
                        ("gen_ai.operation.name", "chat"),
                        ("gen_ai.provider.name", "anthropic"),
                        ("gen_ai.request.model", "claude-sonnet-4-5"),
                        ("gen_ai.usage.cache_creation.input_tokens", "900"),
                        ("gen_ai.usage.input_tokens", "930"),
                        ("gen_ai.usage.output_tokens", "48"),
                    ],
                    Some([930, 0, 900, 48, 0]),
                ),
            ],
        );
    }

    /// `captures/semantic_kernel_agents`: the call's op is not a semconv one.
    #[test]
    fn semantic_kernel_completions() {
        let chat = |op| {
            [
                ("gen_ai.operation.name", op),
                ("gen_ai.request.model", "openai/gpt-4o-mini"),
                ("gen_ai.system", "openai"),
                ("gen_ai.usage.input_tokens", "209"),
                ("gen_ai.usage.output_tokens", "17"),
            ]
        };
        check(
            "semantic-kernel-agents",
            "semantic_kernel.utils.telemetry.model_diagnostics",
            "semantic_kernel",
            &[
                (
                    "chat.completions openai/gpt-4o-mini",
                    &chat("chat.completions"),
                    Some([209, 0, 0, 17, 0]),
                ),
                (
                    "chat.streaming_completions openai/gpt-4o-mini",
                    &chat("chat.streaming_completions"),
                    Some([209, 0, 0, 17, 0]),
                ),
            ],
        );
    }

    /// `captures/docs_spring-ai_a`, `captures/flue_agents` and
    /// `captures/effect_ai_agents`: plain semconv chat spans.
    #[test]
    fn semconv_chat_emitters() {
        check(
            "docs-verify-spring-ai",
            "org.springframework.boot",
            "spring_ai",
            &[(
                "chat openai/gpt-4o-mini",
                &[
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.request.model", "openai/gpt-4o-mini"),
                    ("gen_ai.system", "openai"),
                    ("gen_ai.usage.cache_read.input_tokens", "0"),
                    ("gen_ai.usage.input_tokens", "104"),
                    ("gen_ai.usage.output_tokens", "33"),
                    ("gen_ai.usage.total_tokens", "137"),
                ],
                Some([104, 0, 0, 33, 0]),
            )],
        );
        check(
            "flue-agents",
            "@flue/opentelemetry",
            "flue",
            &[(
                "chat openai/gpt-4o-mini",
                &[
                    ("flue.usage.total_tokens", "670"),
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.provider.name", "openrouter"),
                    ("gen_ai.request.model", "openai/gpt-4o-mini"),
                    ("gen_ai.usage.cache_creation.input_tokens", "0"),
                    ("gen_ai.usage.cache_read.input_tokens", "0"),
                    ("gen_ai.usage.input_tokens", "533"),
                    ("gen_ai.usage.output_tokens", "137"),
                ],
                Some([533, 0, 0, 137, 0]),
            )],
        );
        check(
            "effect-ai-agents",
            "effect-ai-agents",
            "effect_ai",
            &[(
                "LanguageModel.generateText",
                &[
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.request.model", "openai/gpt-4o-mini"),
                    ("gen_ai.system", "openrouter"),
                    ("gen_ai.usage.input_tokens", "90"),
                    ("gen_ai.usage.output_tokens", "71"),
                ],
                Some([90, 0, 0, 71, 0]),
            )],
        );
    }

    /// `captures/jev_agents`: `decide` is jev's own model call, found by the
    /// unknown-dialect fallback; an unknown workflow op is not a call, nor is a
    /// memory operation naming its embedding model. A "tool" in the name of a
    /// span that names its own operation does not rule it out.
    #[test]
    fn unknown_dialect_calls_by_name_and_model() {
        let stamped = stamp_spans(
            "jev-example",
            "jev-example",
            &[
                (
                    "decide typesafe/jev-1.13",
                    &[
                        ("gen_ai.operation.name", "decide"),
                        ("gen_ai.provider.name", "openrouter"),
                        ("gen_ai.request.model", "typesafe/jev-1.13"),
                        ("gen_ai.usage.input_tokens", "379"),
                        ("gen_ai.usage.output_tokens", "73"),
                        ("openrouter.cost", "1.5918e-05"),
                    ],
                ),
                (
                    "chat openai/gpt-4o-mini",
                    &[
                        ("gen_ai.operation.name", "chat"),
                        ("gen_ai.provider.name", "openrouter"),
                        ("gen_ai.request.model", "openai/gpt-4o-mini"),
                        ("gen_ai.usage.input_tokens", "81"),
                        ("gen_ai.usage.output_tokens", "14"),
                    ],
                ),
                (
                    "run_workflow",
                    &[
                        ("gen_ai.operation.name", "workflow_step"),
                        ("gen_ai.request.model", "openai/gpt-4o-mini"),
                        ("gen_ai.usage.input_tokens", "81"),
                    ],
                ),
                (
                    "search_memory chat-history",
                    &[
                        ("gen_ai.operation.name", "search_memory"),
                        ("gen_ai.request.model", "text-embedding-3-small"),
                    ],
                ),
                (
                    "rank_tools openai/gpt-4o-mini",
                    &[
                        ("gen_ai.operation.name", "rank"),
                        ("gen_ai.request.model", "openai/gpt-4o-mini"),
                        ("gen_ai.usage.input_tokens", "52"),
                        ("gen_ai.usage.output_tokens", "9"),
                    ],
                ),
            ],
        );
        assert!(stamped.iter().all(|span| span.vendor == "unknown:genai"));
        assert_eq!(stamped[0].buckets, Some([379, 0, 0, 73, 0]));
        assert_eq!(stamped[0].cost.as_deref(), Some("0.000015918"));
        assert_eq!(stamped[1].buckets, Some([81, 0, 0, 14, 0]));
        assert_eq!(stamped[2].buckets, None);
        let calls: Vec<_> = stamped
            .iter()
            .map(|span| span.llm_call.as_deref())
            .collect();
        assert_eq!(
            calls,
            [Some("1"), Some("1"), Some("0"), Some("0"), Some("1")]
        );
        assert_eq!(stamped[4].buckets, Some([52, 0, 0, 9, 0]));
    }

    // --- Guards and the write itself ------------------------------------

    /// A prompt smaller than its own cache cannot contain it: a raw
    /// passthrough the vendor table does not know is still read exclusive.
    #[test]
    fn a_prompt_smaller_than_its_cache_is_exclusive() {
        check(
            "anthropic-app",
            "opentelemetry.instrumentation.anthropic",
            "unknown:genai",
            &[(
                "chat claude-sonnet-4-5",
                &[
                    ("gen_ai.operation.name", "chat"),
                    ("gen_ai.request.model", "claude-sonnet-4-5"),
                    ("gen_ai.usage.input_tokens", "8"),
                    ("gen_ai.usage.cache_read.input_tokens", "4248"),
                    ("gen_ai.usage.cache_creation.input_tokens", "765"),
                    ("gen_ai.usage.output_tokens", "263"),
                ],
                Some([8, 4248, 765, 263, 0]),
            )],
        );
    }

    /// A failed call reports no tokens but keeps the price it reported, $0 for
    /// a free model; a customer's own `maple_ai.usage.*` is stripped with the
    /// rest of the namespace rather than trusted.
    #[test]
    fn zero_usage_writes_nothing_and_spoofed_buckets_are_stripped() {
        let stamped = stamp_spans(
            "docs-verify-mastra",
            "@mastra/otel-exporter",
            &[
                (
                    "chat openai/gpt-4o-mini",
                    &[
                        ("gen_ai.operation.name", "chat"),
                        ("gen_ai.usage.input_tokens", "0"),
                        ("gen_ai.usage.output_tokens", "0"),
                        ("gen_ai.usage.cost", "0"),
                    ],
                ),
                (
                    "agent.generate",
                    &[
                        ("gen_ai.operation.name", "invoke_agent"),
                        (INPUT_TOKENS_ATTR, "999"),
                        (COST_ATTR, "9.99"),
                        (LLM_CALL_ATTR, "1"),
                    ],
                ),
            ],
        );
        // Still the model call: a failed call counts once.
        assert_eq!(stamped[0].llm_call.as_deref(), Some("1"));
        assert!(stamped[0].buckets.is_none());
        assert_eq!(stamped[0].cost.as_deref(), Some("0"));
        assert_eq!(stamped[1].llm_call.as_deref(), Some("0"));
        assert!(stamped[1].buckets.is_none() && stamped[1].cost.is_none());
    }

    /// Spans the op/name heuristics read as model calls because their names say
    /// "chat" and a model is named nearby.
    #[test]
    fn name_heuristic_false_positives_are_not_calls() {
        // `captures/spring_ai_agents`: the ChatClient facade over the chat model.
        let spring = stamp_spans(
            "spring-ai-trace-capture",
            "org.springframework.boot",
            &[(
                "spring_ai chat_client",
                &[
                    ("gen_ai.operation.name", "framework"),
                    ("gen_ai.system", "spring_ai"),
                    ("spring.ai.chat.client.stream", "false"),
                    ("spring.ai.kind", "chat_client"),
                ],
            )],
        );
        // LangSmith's OTel export names a prompt template step `chain`.
        let langsmith = stamp_spans(
            "docs-verify-langchain",
            "langsmith",
            &[(
                "ChatPromptTemplate",
                &[
                    ("gen_ai.operation.name", "chain"),
                    ("langsmith.span.kind", "prompt"),
                ],
            )],
        );
        // `captures/dspy_agents`: the adapter formatting the LM call.
        let dspy = stamp_spans(
            "dspy-agents-scenario",
            "openinference.instrumentation.dspy",
            &[(
                "ChatAdapter.__call__",
                &[
                    ("input.mime_type", "application/json"),
                    ("openinference.span.kind", "CHAIN"),
                    ("output.mime_type", "application/json"),
                ],
            )],
        );
        for (stamped, vendor) in [
            (spring, "spring_ai"),
            (langsmith, "langchain"),
            (dspy, "dspy"),
        ] {
            assert_eq!(stamped[0].vendor, vendor);
            assert_eq!(stamped[0].llm_call.as_deref(), Some("0"), "{vendor}");
        }

        // `captures/docs_litellm_proxy`: the proxy's own server span for the
        // request, which is no AI span at all as captured...
        let proxy = |kind: SpanKind| Span {
            name: "POST /chat/completions".to_owned(),
            kind: kind as i32,
            attributes: kvs(&[
                ("http.method", "POST"),
                ("http.route", "/chat/completions"),
                ("gen_ai.request.model", "gpt-4o-mini"),
                ("llm.request.type", "chat"),
            ]),
            ..Default::default()
        };
        let captured = stamp_spans(
            "litellm-proxy",
            "opentelemetry.instrumentation.fastapi",
            &[(
                "POST /chat/completions",
                &[
                    ("http.method", "POST"),
                    ("http.route", "/chat/completions"),
                    ("litellm.api_key.hash", "7c9f8cb332edbdb1"),
                    ("gen_ai.request.model", "gpt-4o-mini"),
                ],
            )],
        );
        assert!(captured[0].llm_call.is_none());
        // ...and, stamped as an unknown dialect, a server span is never the call;
        // the same span as a client is.
        let stamped = stamp_request(
            "litellm-proxy",
            "opentelemetry.instrumentation.fastapi",
            vec![proxy(SpanKind::Server), proxy(SpanKind::Client)],
        );
        assert_eq!(stamped[0].vendor, "unknown:other");
        assert_eq!(stamped[0].llm_call.as_deref(), Some("0"));
        assert_eq!(stamped[1].llm_call.as_deref(), Some("1"));
    }

    /// Integer and double values count like their string forms; a value that
    /// does not parse falls through to the next spelling.
    #[test]
    fn number_values_of_any_scalar_type() {
        let scalar = |key: &str, value| KeyValue {
            key: key.to_owned(),
            key_strindex: 0,
            value: Some(AnyValue { value: Some(value) }),
        };
        let attrs = [
            scalar("gen_ai.usage.input_tokens", any_value::Value::IntValue(120)),
            scalar(
                "gen_ai.usage.output_tokens",
                any_value::Value::DoubleValue(30.0),
            ),
            owned_string_attribute("gen_ai.usage.reasoning.output_tokens", "n/a".to_owned()),
            owned_string_attribute("ai.usage.reasoningTokens", "10".to_owned()),
        ];
        assert_eq!(
            Usage::read(&Facts::read(&attrs), false),
            Usage {
                input: 120,
                cache_read: 0,
                cache_write: 0,
                output: 20,
                reasoning: 10,
            }
        );
    }
}
