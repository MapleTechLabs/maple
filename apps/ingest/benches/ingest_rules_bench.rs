use std::time::Duration;

use criterion::{black_box, criterion_group, criterion_main, BatchSize, Criterion, Throughput};
use maple_ingest::ingest_rules::{
    apply_logs, apply_traces, CompiledRules, IngestRuleSpec, RuleStats,
};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};
use serde_json::json;

const BATCH: usize = 10;

fn kv(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        key_strindex: 0,
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }),
    }
}

fn attrs(pairs: &[(&str, &str)]) -> Vec<KeyValue> {
    pairs.iter().map(|(k, v)| kv(k, v)).collect()
}

/// 15 attributes, a few of them carrying PII the detectors look for.
fn record_attrs(route: &str) -> Vec<KeyValue> {
    attrs(&[
        ("http.request.method", "POST"),
        ("http.route", route),
        ("url.path", "/api/checkout"),
        ("url.scheme", "https"),
        ("server.address", "api.example.com"),
        ("server.port", "443"),
        ("network.protocol.version", "1.1"),
        ("user_agent.original", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
        ("http.response.status_code", "200"),
        ("enduser.id", "user_8f14e45f"),
        ("user.email", "jane.doe@example.com"),
        ("payment.note", "paid with 4111 1111 1111 1111 on file"),
        ("db.query.text", "SELECT * FROM orders WHERE org_id = $1 AND status = 'open'"),
        ("client.address", "203.0.113.7"),
        ("app.message", "order ORD-12345 confirmed for the customer"),
    ])
}

/// Every fifth record is a health check, which the drop rule removes.
fn route(i: usize) -> &'static str {
    if i % 5 == 0 {
        "/health"
    } else {
        "/api/checkout"
    }
}

fn resource() -> Option<Resource> {
    Some(Resource {
        attributes: attrs(&[
            ("service.name", "checkout"),
            ("service.version", "1.4.2"),
            ("deployment.environment.name", "production"),
            ("maple_org_id", "org_bench"),
        ]),
        ..Default::default()
    })
}

fn scope() -> Option<InstrumentationScope> {
    Some(InstrumentationScope {
        name: "@opentelemetry/instrumentation-http".to_owned(),
        ..Default::default()
    })
}

fn trace_request() -> ExportTraceServiceRequest {
    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: resource(),
            scope_spans: vec![ScopeSpans {
                scope: scope(),
                spans: (0..BATCH)
                    .map(|i| Span {
                        name: if i % 5 == 0 { "GET /health" } else { "POST /api/checkout" }
                            .to_owned(),
                        trace_id: vec![u8::try_from(i).unwrap_or(0); 16],
                        attributes: record_attrs(route(i)),
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

fn log_request() -> ExportLogsServiceRequest {
    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: resource(),
            scope_logs: vec![ScopeLogs {
                scope: scope(),
                log_records: (0..BATCH)
                    .map(|i| LogRecord {
                        severity_number: if i % 5 == 0 { 5 } else { 9 },
                        severity_text: if i % 5 == 0 { "DEBUG" } else { "INFO" }.to_owned(),
                        body: Some(AnyValue {
                            value: Some(any_value::Value::StringValue(
                                "login from jane.doe@example.com via 203.0.113.7".to_owned(),
                            )),
                        }),
                        attributes: record_attrs(route(i)),
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

fn compile(rules: &[serde_json::Value]) -> CompiledRules {
    let specs = rules
        .iter()
        .enumerate()
        .map(|(i, rule)| {
            let spec: IngestRuleSpec =
                serde_json::from_value(rule.clone()).expect("bench rule spec");
            (format!("rule-{i}"), spec)
        })
        .collect();
    let (compiled, invalid) = CompiledRules::compile(specs, "bench-salt".to_owned());
    assert!(invalid.is_empty(), "bench rules must compile: {invalid:?}");
    compiled
}

/// Five rules: key masking, email + credit card detectors, a custom pattern, a hash, a drop.
fn five_rules() -> CompiledRules {
    let redact = |keys: serde_json::Value, detectors: serde_json::Value, patterns: serde_json::Value, method: &str| {
        json!({
            "signals": ["traces", "logs"],
            "conditions": [],
            "action": { "_tag": "redact", "keys": keys, "detectors": detectors, "patterns": patterns,
                "scopes": ["attributes", "body"], "method": method }
        })
    };
    compile(&[
        redact(json!(["*password*", "http.request.header.*"]), json!([]), json!([]), "mask"),
        redact(json!([]), json!(["email", "credit_card"]), json!([]), "mask"),
        redact(json!([]), json!([]), json!(["ORD-[0-9]+"]), "mask"),
        redact(json!(["enduser.id"]), json!([]), json!([]), "hash"),
        drop_rule(),
    ])
}

fn drop_rule() -> serde_json::Value {
    json!({
        "signals": ["traces", "logs"],
        "conditions": [{ "field": "service_name", "op": "eq", "value": "checkout" },
            { "field": "attribute", "key": "http.route", "op": "eq", "value": "/health" }],
        "action": { "_tag": "drop", "keepPercent": 0 }
    })
}

fn bench_signal<R: Clone>(
    c: &mut Criterion,
    group_name: &str,
    request: &R,
    apply: fn(&CompiledRules, &mut R, &mut RuleStats),
) {
    let mut group = c.benchmark_group(group_name);
    group.warm_up_time(Duration::from_millis(500));
    group.measurement_time(Duration::from_secs(2));
    group.throughput(Throughput::Elements(BATCH as u64));
    let cases = [
        ("no_rules", compile(&[])),
        ("five_rules_with_detectors", five_rules()),
        ("one_drop_rule", compile(&[drop_rule()])),
    ];
    for (name, rules) in &cases {
        group.bench_function(*name, |b| {
            b.iter_batched(
                || request.clone(),
                |mut request| {
                    let mut stats = RuleStats::default();
                    apply(black_box(rules), &mut request, &mut stats);
                    black_box((request, stats))
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

fn bench_traces(c: &mut Criterion) {
    bench_signal(c, "ingest_rules_traces_10_spans", &trace_request(), apply_traces);
}

fn bench_logs(c: &mut Criterion) {
    bench_signal(c, "ingest_rules_logs_10_records", &log_request(), apply_logs);
}

criterion_group!(benches, bench_traces, bench_logs);
criterion_main!(benches);
