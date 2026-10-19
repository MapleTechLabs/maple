//! Vercel AI Gateway's trace drain, restated for Agent Sessions.
//!
//! Every gateway request is one trace on resource `service.name=ai-gateway`,
//! `service.namespace=vercel`. Its root, the server span `<operation> <model>`,
//! carries the request's `gen_ai.*` usage and its cost as
//! `vercel.ai_gateway.cost.total` (a decimal USD string). Beneath it sit the
//! routing span, one span per model attempt and one client span per provider
//! call (`<model> (<provider>)`); those repeat the model and provider but are
//! the same request, so only the root is stamped and only it counts usage.
//!
//! Sessions: the gateway records no conversation. `vercel.ai_gateway.user.id`
//! names the caller's end user, which spans every conversation that user ever
//! had, so it is no session key. Without a `gen_ai.conversation.id` the span
//! gets no session id and Agent Sessions groups it by trace: one gateway
//! request per session.

use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::trace::v1::span::SpanKind;
use opentelemetry_proto::tonic::trace::v1::Span;

pub(super) const VENDOR_ID: &str = "vercel_ai_gateway";
pub(super) const SERVICE_NAME: &str = "ai-gateway";
pub(super) const SERVICE_NAMESPACE: &str = "vercel";

const COST_TOTAL: &str = "vercel.ai_gateway.cost.total";
const COST: &str = "gen_ai.usage.cost";

/// The request's own span; every other gateway span is a part of it.
pub(super) fn is_request(span: &Span) -> bool {
    span.kind == SpanKind::Server as i32
}

/// Restate the gateway's cost under the key the usage stamps read.
pub(super) fn normalize(span: &mut Span) {
    if span.attributes.iter().any(|attr| attr.key == COST) {
        return;
    }
    let cost = span.attributes.iter().find_map(|attr| {
        if attr.key != COST_TOTAL {
            return None;
        }
        match attr.value.as_ref()?.value.as_ref()? {
            any_value::Value::StringValue(text) if !text.is_empty() => Some(text.clone()),
            _ => None,
        }
    });
    if let Some(cost) = cost {
        span.attributes.push(KeyValue {
            key: COST.to_owned(),
            key_strindex: 0,
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue(cost)),
            }),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::super::stamp_trace_request;
    use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
    use opentelemetry_proto::tonic::common::v1::{
        any_value, AnyValue, InstrumentationScope, KeyValue,
    };
    use opentelemetry_proto::tonic::resource::v1::Resource;
    use opentelemetry_proto::tonic::trace::v1::span::SpanKind;
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};
    use std::collections::HashMap;

    fn kv(key: &str, value: any_value::Value) -> KeyValue {
        KeyValue {
            key: key.to_owned(),
            key_strindex: 0,
            value: Some(AnyValue { value: Some(value) }),
        }
    }

    fn text(key: &str, value: &str) -> KeyValue {
        kv(key, any_value::Value::StringValue(value.to_owned()))
    }

    fn int(key: &str, value: i64) -> KeyValue {
        kv(key, any_value::Value::IntValue(value))
    }

    fn span(name: &str, kind: SpanKind, parent: &[u8], attributes: Vec<KeyValue>) -> Span {
        Span {
            parent_span_id: parent.to_vec(),
            name: name.to_owned(),
            kind: kind as i32,
            attributes,
            ..Default::default()
        }
    }

    /// A gateway request that failed over from one provider to another, as
    /// the trace drain reference lays it out.
    fn failover_trace() -> Vec<Span> {
        vec![
            span(
                "chat anthropic/claude-sonnet-4",
                SpanKind::Server,
                &[],
                vec![
                    text("gen_ai.operation.name", "chat"),
                    text("gen_ai.provider.name", "anthropic"),
                    text("gen_ai.request.model", "anthropic/claude-sonnet-4"),
                    text("gen_ai.response.model", "anthropic/claude-sonnet-4"),
                    int("gen_ai.usage.input_tokens", 1200),
                    int("gen_ai.usage.cache_read.input_tokens", 1000),
                    int("gen_ai.usage.output_tokens", 80),
                    int("http.response.status_code", 200),
                    text("vercel.ai_gateway.cost.total", "0.0012345"),
                    text("vercel.ai_gateway.cost.currency", "USD"),
                    text("vercel.ai_gateway.provider", "bedrock"),
                    text("vercel.ai_gateway.request.id", "req_1"),
                    text("vercel.ai_gateway.user.id", "end-user-7"),
                    text("vercel.project.id", "prj_1"),
                ],
            ),
            span(
                "vercel.ai_gateway.routing",
                SpanKind::Internal,
                &[3; 8],
                vec![text(
                    "vercel.ai_gateway.routing.custom_provider_order",
                    "anthropic,bedrock",
                )],
            ),
            span(
                "claude-sonnet-4 (anthropic)",
                SpanKind::Client,
                &[3; 8],
                vec![
                    text("gen_ai.provider.name", "anthropic"),
                    text("gen_ai.request.model", "anthropic/claude-sonnet-4"),
                    // A provider span a later gateway version also names.
                    text("gen_ai.operation.name", "chat"),
                    int("gen_ai.usage.input_tokens", 1200),
                    int("http.response.status_code", 529),
                    text("error.type", "overloaded"),
                ],
            ),
            span(
                "claude-sonnet-4 (bedrock)",
                SpanKind::Client,
                &[3; 8],
                vec![
                    text("gen_ai.provider.name", "aws.bedrock"),
                    text("gen_ai.request.model", "anthropic/claude-sonnet-4"),
                    int("http.response.status_code", 200),
                ],
            ),
        ]
    }

    fn stamp(
        resource: &[(&str, &str)],
        scope: &str,
        spans: Vec<Span>,
    ) -> Vec<HashMap<String, String>> {
        let mut request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource {
                    attributes: resource
                        .iter()
                        .map(|(key, value)| text(key, value))
                        .collect(),
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
                span.attributes
                    .iter()
                    .filter_map(|attr| match attr.value.as_ref()?.value.as_ref()? {
                        any_value::Value::StringValue(value) => {
                            Some((attr.key.clone(), value.clone()))
                        }
                        any_value::Value::IntValue(value) => {
                            Some((attr.key.clone(), value.to_string()))
                        }
                        _ => None,
                    })
                    .collect()
            })
            .collect()
    }

    const GATEWAY: &[(&str, &str)] = &[
        ("service.name", "ai-gateway"),
        ("service.namespace", "vercel"),
    ];

    #[test]
    fn the_request_span_is_the_one_model_call_and_carries_the_cost() {
        let spans = stamp(GATEWAY, "ai-gateway", failover_trace());
        let root = &spans[0];
        assert_eq!(root["maple_ai.vendor.id"], "vercel_ai_gateway");
        assert_eq!(root["maple_ai.llm_call"], "1");
        assert_eq!(root["gen_ai.usage.cost"], "0.0012345");
        assert_eq!(root["maple_ai.usage.cost"], "0.0012345");
        // Semconv input is inclusive of the cache read.
        assert_eq!(root["maple_ai.usage.input_tokens"], "200");
        assert_eq!(root["maple_ai.usage.cache_read_tokens"], "1000");
        assert_eq!(root["maple_ai.usage.output_tokens"], "80");
        assert_eq!(root["maple_ai.model"], "anthropic/claude-sonnet-4");
        // No conversation: the session is the trace, never the end user.
        assert!(!root.contains_key("maple_ai.session.id"));

        for part in &spans[1..] {
            assert!(
                !part.keys().any(|key| key.starts_with("maple_ai.")),
                "a part of the request is unstamped: {part:?}"
            );
        }
    }

    #[test]
    fn a_conversation_id_on_the_request_is_its_session() {
        let mut trace = failover_trace();
        trace[0]
            .attributes
            .push(text("gen_ai.conversation.id", "conv-1"));
        assert_eq!(
            stamp(GATEWAY, "ai-gateway", trace)[0]["maple_ai.session.id"],
            "conv-1"
        );
    }

    #[test]
    fn a_cost_the_span_already_reports_is_kept() {
        let mut trace = failover_trace();
        trace[0].attributes.push(text("gen_ai.usage.cost", "0.5"));
        assert_eq!(
            stamp(GATEWAY, "ai-gateway", trace)[0]["maple_ai.usage.cost"],
            "0.5"
        );
    }

    #[test]
    fn embeddings_requests_count_as_model_calls() {
        let trace = vec![span(
            "embeddings openai/text-embedding-3-small",
            SpanKind::Server,
            &[],
            vec![
                text("gen_ai.operation.name", "embeddings"),
                int("gen_ai.usage.input_tokens", 12),
                text("vercel.ai_gateway.cost.total", "0.00000024"),
            ],
        )];
        let root = &stamp(GATEWAY, "ai-gateway", trace)[0];
        assert_eq!(root["maple_ai.llm_call"], "1");
        assert_eq!(root["maple_ai.usage.input_tokens"], "12");
        assert_eq!(root["maple_ai.usage.cost"], "0.00000024");
    }

    #[test]
    fn vercel_ai_sdk_spans_are_not_the_gateway() {
        // An app on Vercel calling the gateway through the AI SDK.
        let app = vec![span(
            "ai.generateText.doGenerate",
            SpanKind::Client,
            &[],
            vec![
                text("ai.model.id", "anthropic/claude-sonnet-4"),
                text("ai.model.provider", "gateway"),
                int("ai.usage.inputTokens", 10),
                text("vercel.ai_gateway.cost.total", "0.1"),
            ],
        )];
        let spans = stamp(
            &[("service.name", "my-app"), ("vercel.projectId", "prj_1")],
            "ai",
            app,
        );
        assert_eq!(spans[0]["maple_ai.vendor.id"], "vercel_ai_sdk");
        assert!(!spans[0].contains_key("gen_ai.usage.cost"));
    }

    #[test]
    fn cloudflare_gateway_spans_are_not_vercel() {
        let spans = stamp(
            &[("service.name", "ai-gateway")],
            "ai",
            vec![span(
                "cf.aig.request",
                SpanKind::Internal,
                &[],
                vec![text("gen_ai.operation.name", "chat")],
            )],
        );
        assert_eq!(spans[0]["maple_ai.vendor.id"], "cloudflare_ai_gateway");
    }
}
