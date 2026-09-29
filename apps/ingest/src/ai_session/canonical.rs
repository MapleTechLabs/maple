//! Usage, cost, time to first token and agent name, restated under the one
//! `gen_ai.*` key each that every reader of an agent span keys on.
//!
//! Frameworks spell these facts their own way (`ai.usage.inputTokens`,
//! `llm.token_count.prompt`, `litellm.cost.total`, a TTFT in milliseconds), and
//! not every emitter means the same thing by `gen_ai.usage.input_tokens`: Claude
//! Code passes Anthropic's raw figure through, which excludes the cache buckets,
//! and Gemini's completion count excludes the reasoning tokens. Settling that
//! here, once per span, is what lets the `ai_trace_index` view, the session page
//! and the MCP tools read one key per fact under one meaning.
//!
//! After this pass, a stamped span's usage follows the semconv: the input figure
//! contains both cache buckets and the output figure contains the reasoning
//! bucket. The canonical key is overwritten when the span's own value is a
//! different spelling or had to be folded; a value that is already canonical is
//! left as the emitter wrote it.

use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::trace::v1::Span;

const INPUT_KEYS: &[&str] = &[
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.prompt_tokens",
    "ai.usage.inputTokens",
    "ai.usage.promptTokens",
    "llm.token_count.prompt",
];
const CACHE_READ_KEYS: &[&str] = &[
    "gen_ai.usage.cache_read.input_tokens",
    // OpenRouter.
    "gen_ai.usage.input_tokens.cached",
    // Older Strands releases.
    "gen_ai.usage.cache_read_input_tokens",
    "ai.usage.cachedInputTokens",
    "ai.usage.inputTokenDetails.cacheReadTokens",
    "llm.token_count.prompt_details.cache_read",
];
const CACHE_WRITE_KEYS: &[&str] = &[
    "gen_ai.usage.cache_creation.input_tokens",
    // The registry's spelling, which Maple's own agents emit.
    "gen_ai.usage.cache_write.input_tokens",
    // OpenRouter.
    "gen_ai.usage.input_tokens.cache_write",
    // Older Strands releases.
    "gen_ai.usage.cache_write_input_tokens",
    "ai.usage.inputTokenDetails.cacheWriteTokens",
];
const OUTPUT_KEYS: &[&str] = &[
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.completion_tokens",
    "ai.usage.outputTokens",
    "ai.usage.completionTokens",
    "llm.token_count.completion",
];
const REASONING_KEYS: &[&str] = &[
    "gen_ai.usage.reasoning.output_tokens",
    // OpenRouter.
    "gen_ai.usage.output_tokens.reasoning",
    // Mastra.
    "gen_ai.usage.reasoning_tokens",
    // Pydantic AI.
    "gen_ai.usage.details.reasoning_tokens",
    "ai.usage.reasoningTokens",
    "ai.usage.outputTokenDetails.reasoningTokens",
    "llm.token_count.completion_details.reasoning",
];
/// USD, as the instrumentation priced the call: OpenLLMetry's key, then
/// OpenRouter's, OpenInference's, LiteLLM's and Pydantic AI's (Logfire's).
const COST_KEYS: &[&str] = &[
    "gen_ai.usage.cost",
    "gen_ai.usage.total_cost",
    "llm.cost.total",
    "litellm.cost.total",
    "operation.cost",
];
/// Seconds. The second is the semconv metric's name, which Pydantic AI and the
/// Vercel AI SDK v7 also write as a span attribute.
const TTFT_KEYS: &[&str] = &[
    "gen_ai.response.time_to_first_chunk",
    "gen_ai.client.operation.time_to_first_chunk",
];
/// LangSmith's OTel export names the LangChain agent of every span of its run
/// under the second; the third is the name an app gave a traced Vercel AI SDK
/// call, the only agent identity an older-SDK span has.
const AGENT_NAME_KEYS: &[&str] = &[
    "gen_ai.agent.name",
    "langsmith.metadata.lc_agent_name",
    "ai.telemetry.functionId",
];
const PROVIDER_KEYS: &[&str] = &[
    "gen_ai.provider.name",
    "gen_ai.system",
    "ai.model.provider",
    "llm.provider",
    "llm.system",
];

/// Emitters that report usage the semconv way whichever provider served the
/// call: the Vercel AI SDK and `@opencode-ai/ai` (Maple's own agents) re-sum
/// every provider's figures, and OpenRouter Broadcast reports OpenAI-shaped
/// usage while naming the upstream as the provider.
const NESTED_VENDORS: &[&str] = &["vercel_ai_sdk", "maple", "openrouter"];
/// Claude Code's `claude_code.llm_request` carries the Messages API usage
/// verbatim: `input_tokens` excludes both cache buckets.
const CACHE_EXCLUSIVE_VENDOR: &str = super::claude_code::VENDOR_ID;
/// Gemini's `candidatesTokenCount` excludes `thoughtsTokenCount`, under the
/// current and the pre-rename provider spellings.
const REASONING_EXCLUSIVE_PROVIDERS: &[&str] =
    &["gcp.gemini", "gcp.vertex_ai", "gemini", "vertex_ai"];

/// A figure read off the span, and whether it is already the canonical key's
/// own value, as written.
struct Read {
    value: f64,
    canonical: bool,
}

/// Restate one stamped span's usage, cost, TTFT and agent name.
pub(super) fn normalize(span: &mut Span, vendor: &str) {
    let attrs = &span.attributes;
    let mut writes: Vec<KeyValue> = Vec::new();
    let mut write = |key: &str, read: Option<Read>, extra: f64| {
        if let Some(read) = read {
            if !read.canonical || extra != 0.0 {
                writes.push(owned(key, (read.value + extra).to_string()));
            }
        }
    };

    let cache_read = number(attrs, CACHE_READ_KEYS);
    let cache_write = number(attrs, CACHE_WRITE_KEYS);
    let reasoning = number(attrs, REASONING_KEYS);
    let figure = |read: &Option<Read>| read.as_ref().map_or(0.0, |read| read.value);
    let cache = figure(&cache_read) + figure(&cache_write);
    let reasoning_total = figure(&reasoning);

    let input_excludes_cache = vendor == CACHE_EXCLUSIVE_VENDOR;
    let output_excludes_reasoning = vendor != CACHE_EXCLUSIVE_VENDOR
        && !NESTED_VENDORS.contains(&vendor)
        && first_text(attrs, PROVIDER_KEYS)
            .is_some_and(|provider| REASONING_EXCLUSIVE_PROVIDERS.contains(&provider));

    write(
        INPUT_KEYS[0],
        number(attrs, INPUT_KEYS),
        if input_excludes_cache { cache } else { 0.0 },
    );
    write(
        OUTPUT_KEYS[0],
        number(attrs, OUTPUT_KEYS),
        if output_excludes_reasoning {
            reasoning_total
        } else {
            0.0
        },
    );
    write(CACHE_READ_KEYS[0], cache_read, 0.0);
    write(CACHE_WRITE_KEYS[0], cache_write, 0.0);
    write(REASONING_KEYS[0], reasoning, 0.0);
    write(COST_KEYS[0], number(attrs, COST_KEYS), 0.0);
    write(TTFT_KEYS[0], ttft(attrs, vendor), 0.0);

    if first_text(attrs, &AGENT_NAME_KEYS[..1]).is_none() {
        let name = first_text(attrs, &AGENT_NAME_KEYS[1..]).or_else(|| {
            // CrewAI's OpenInference spans name the agent's role only here
            // unless the GenAI dual-write is on. Agno's carry an opaque node id
            // under the same key, so it is read for CrewAI alone.
            (vendor == "crewai")
                .then(|| first_text(attrs, &["graph.node.id"]))
                .flatten()
        });
        if let Some(name) = name {
            writes.push(owned(AGENT_NAME_KEYS[0], name.to_owned()));
        }
    }

    if writes.is_empty() {
        return;
    }
    span.attributes
        .retain(|attr| !writes.iter().any(|write| write.key == attr.key));
    span.attributes.extend(writes);
}

/// Time to first token in seconds. OpenRouter Broadcast (the gateway's own
/// clock) and Strands (the model's `timeToFirstByteMs`) report it in
/// milliseconds under a key of their own.
fn ttft(attrs: &[KeyValue], vendor: &str) -> Option<Read> {
    number(attrs, TTFT_KEYS).or_else(|| {
        let key = match vendor {
            "openrouter" => "trace.metadata.openrouter.first_token_ms",
            "strands" => "gen_ai.server.time_to_first_token",
            _ => return None,
        };
        number(attrs, &[key])
            .filter(|read| read.value > 0.0)
            .map(|read| Read {
                value: read.value / 1000.0,
                canonical: false,
            })
    })
}

/// The first key whose value reads as a finite number. `keys[0]` is the
/// canonical key.
#[expect(
    clippy::cast_precision_loss,
    reason = "token counts and prices are far below 2^52"
)]
fn number(attrs: &[KeyValue], keys: &[&str]) -> Option<Read> {
    keys.iter().enumerate().find_map(|(index, key)| {
        let value = attrs
            .iter()
            .filter(|attr| attr.key == *key)
            .find_map(|attr| match attr.value.as_ref()?.value.as_ref()? {
                any_value::Value::IntValue(int) => Some(*int as f64),
                any_value::Value::DoubleValue(double) => Some(*double),
                any_value::Value::StringValue(text) => text.trim().parse::<f64>().ok(),
                _ => None,
            })
            .filter(|value| value.is_finite())?;
        Some(Read {
            value,
            canonical: index == 0,
        })
    })
}

/// The first non-blank string value among `keys`.
fn first_text<'a>(attrs: &'a [KeyValue], keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        attrs.iter().find_map(|attr| {
            if attr.key != *key {
                return None;
            }
            match attr.value.as_ref()?.value.as_ref()? {
                any_value::Value::StringValue(text) if !text.trim().is_empty() => {
                    Some(text.as_str())
                }
                _ => None,
            }
        })
    })
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
    use super::*;

    fn span(pairs: &[(&str, &str)]) -> Span {
        Span {
            attributes: pairs
                .iter()
                .map(|(key, value)| owned(key, (*value).to_owned()))
                .collect(),
            ..Default::default()
        }
    }

    fn normalized(vendor: &str, pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        let mut span = span(pairs);
        normalize(&mut span, vendor);
        span.attributes
            .into_iter()
            .map(|attr| {
                let value = match attr.value.and_then(|value| value.value) {
                    Some(any_value::Value::StringValue(text)) => text,
                    other => panic!("unexpected value {other:?}"),
                };
                (attr.key, value)
            })
            .collect()
    }

    fn get<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a str> {
        let mut values = attrs.iter().filter(|(k, _)| k == key);
        let value = values.next().map(|(_, v)| v.as_str());
        assert!(values.next().is_none(), "{key} written twice");
        value
    }

    #[test]
    fn canonical_usage_is_left_as_written() {
        let pairs = [
            ("gen_ai.provider.name", "anthropic"),
            ("gen_ai.usage.input_tokens", "7911"),
            ("gen_ai.usage.cache_read.input_tokens", "7581"),
            ("gen_ai.usage.output_tokens", "147"),
        ];
        let attrs = normalized("pydantic_ai", &pairs);
        assert_eq!(attrs.len(), pairs.len());
        assert_eq!(get(&attrs, "gen_ai.usage.input_tokens"), Some("7911"));
    }

    #[test]
    fn claude_code_input_gains_both_cache_buckets() {
        let attrs = normalized(
            "claude_agent_sdk",
            &[
                ("gen_ai.usage.input_tokens", "2"),
                ("gen_ai.usage.cache_read.input_tokens", "114514"),
                ("gen_ai.usage.cache_creation.input_tokens", "3549"),
                ("gen_ai.usage.output_tokens", "782"),
            ],
        );
        assert_eq!(get(&attrs, "gen_ai.usage.input_tokens"), Some("118065"));
        assert_eq!(get(&attrs, "gen_ai.usage.output_tokens"), Some("782"));
    }

    #[test]
    fn gemini_output_gains_the_reasoning_bucket() {
        for provider in ["gcp.gemini", "vertex_ai"] {
            let attrs = normalized(
                "google_adk",
                &[
                    ("gen_ai.system", provider),
                    ("gen_ai.usage.output_tokens", "100"),
                    ("gen_ai.usage.reasoning.output_tokens", "40"),
                ],
            );
            assert_eq!(
                get(&attrs, "gen_ai.usage.output_tokens"),
                Some("140"),
                "{provider}"
            );
        }
        // An emitter that re-sums decides over the provider.
        let attrs = normalized(
            "vercel_ai_sdk",
            &[
                ("gen_ai.provider.name", "gcp.gemini"),
                ("gen_ai.usage.output_tokens", "140"),
                ("gen_ai.usage.reasoning.output_tokens", "40"),
            ],
        );
        assert_eq!(get(&attrs, "gen_ai.usage.output_tokens"), Some("140"));
    }

    #[test]
    fn dialect_spellings_become_the_canonical_keys() {
        let attrs = normalized(
            "vercel_ai_sdk",
            &[
                ("ai.usage.promptTokens", "10"),
                ("ai.usage.completionTokens", "5"),
                ("ai.usage.cachedInputTokens", "4"),
                ("ai.usage.reasoningTokens", "2"),
                ("ai.telemetry.functionId", "planner"),
            ],
        );
        assert_eq!(get(&attrs, "gen_ai.usage.input_tokens"), Some("10"));
        assert_eq!(get(&attrs, "gen_ai.usage.output_tokens"), Some("5"));
        assert_eq!(
            get(&attrs, "gen_ai.usage.cache_read.input_tokens"),
            Some("4")
        );
        assert_eq!(
            get(&attrs, "gen_ai.usage.reasoning.output_tokens"),
            Some("2")
        );
        assert_eq!(get(&attrs, "gen_ai.agent.name"), Some("planner"));
        // The dialect's own keys stay.
        assert_eq!(get(&attrs, "ai.usage.promptTokens"), Some("10"));

        let attrs = normalized(
            "openrouter",
            &[
                ("gen_ai.usage.prompt_tokens", "4804"),
                ("gen_ai.usage.input_tokens.cached", "4324"),
                ("gen_ai.usage.input_tokens.cache_write", "12"),
                ("gen_ai.usage.output_tokens.reasoning", "9"),
                ("gen_ai.usage.total_cost", "0.0042"),
            ],
        );
        assert_eq!(get(&attrs, "gen_ai.usage.input_tokens"), Some("4804"));
        assert_eq!(
            get(&attrs, "gen_ai.usage.cache_read.input_tokens"),
            Some("4324")
        );
        assert_eq!(
            get(&attrs, "gen_ai.usage.cache_creation.input_tokens"),
            Some("12")
        );
        assert_eq!(
            get(&attrs, "gen_ai.usage.reasoning.output_tokens"),
            Some("9")
        );
        assert_eq!(get(&attrs, "gen_ai.usage.cost"), Some("0.0042"));

        let attrs = normalized(
            "unknown:openinference",
            &[
                ("llm.token_count.prompt", "30"),
                ("llm.token_count.prompt_details.cache_read", "20"),
                ("llm.cost.total", "0.01"),
            ],
        );
        assert_eq!(get(&attrs, "gen_ai.usage.input_tokens"), Some("30"));
        assert_eq!(
            get(&attrs, "gen_ai.usage.cache_read.input_tokens"),
            Some("20")
        );
        assert_eq!(get(&attrs, "gen_ai.usage.cost"), Some("0.01"));
    }

    #[test]
    fn a_canonical_value_beats_a_dialect_spelling() {
        let attrs = normalized(
            "vercel_ai_sdk",
            &[
                ("ai.usage.inputTokens", "999"),
                ("gen_ai.usage.input_tokens", "10"),
            ],
        );
        assert_eq!(get(&attrs, "gen_ai.usage.input_tokens"), Some("10"));
    }

    #[test]
    fn a_spelling_that_does_not_parse_does_not_consume_the_field() {
        let attrs = normalized(
            "pydantic_ai",
            &[("gen_ai.usage.cost", "n/a"), ("operation.cost", "0.5")],
        );
        assert_eq!(get(&attrs, "gen_ai.usage.cost"), Some("0.5"));
    }

    #[test]
    fn millisecond_ttft_becomes_seconds() {
        let attrs = normalized(
            "openrouter",
            &[("trace.metadata.openrouter.first_token_ms", "934")],
        );
        assert_eq!(
            get(&attrs, "gen_ai.response.time_to_first_chunk"),
            Some("0.934")
        );
        let attrs = normalized("strands", &[("gen_ai.server.time_to_first_token", "0")]);
        assert_eq!(get(&attrs, "gen_ai.response.time_to_first_chunk"), None);
        // Another vendor's millisecond key means nothing.
        let attrs = normalized("mastra", &[("gen_ai.server.time_to_first_token", "500")]);
        assert_eq!(get(&attrs, "gen_ai.response.time_to_first_chunk"), None);
        let attrs = normalized(
            "pydantic_ai",
            &[("gen_ai.client.operation.time_to_first_chunk", "0.25")],
        );
        assert_eq!(
            get(&attrs, "gen_ai.response.time_to_first_chunk"),
            Some("0.25")
        );
    }

    #[test]
    fn agent_name_from_langsmith_and_crewai() {
        let attrs = normalized(
            "langchain",
            &[("langsmith.metadata.lc_agent_name", "researcher")],
        );
        assert_eq!(get(&attrs, "gen_ai.agent.name"), Some("researcher"));

        let attrs = normalized("crewai", &[("graph.node.id", "Senior Analyst")]);
        assert_eq!(get(&attrs, "gen_ai.agent.name"), Some("Senior Analyst"));
        let attrs = normalized("agno", &[("graph.node.id", "a1b2c3")]);
        assert_eq!(get(&attrs, "gen_ai.agent.name"), None);

        let attrs = normalized(
            "crewai",
            &[
                ("gen_ai.agent.name", "Writer"),
                ("graph.node.id", "Senior Analyst"),
            ],
        );
        assert_eq!(get(&attrs, "gen_ai.agent.name"), Some("Writer"));
    }
}
