# OpenTelemetry Specification Map

An internal, source-linked map of the OpenTelemetry specifications. It has three uses:

1. **Spec-compliance checks**, mainly for the ingest gateway (`apps/ingest`). It is an OTLP
   server and must honor the server-side MUSTs in [otlp.md](otlp.md).
2. **Best-practices material.** The normative rules here are the raw input for an internal
   best-practice skill (instrumentation hygiene, status semantics, attribute rules).
3. **Fact-checking reference.** Every section in every file carries inline `Source:` deep links
   to the official spec pages, so claims can be re-verified as the spec moves.

**Snapshot:** researched 2026-07-05 against specification **v1.58.0** (released 2026-06-22,
per the [spec CHANGELOG](https://github.com/open-telemetry/opentelemetry-specification/blob/main/CHANGELOG.md)).
Method: each file was written from freshly fetched official pages (opentelemetry.io/docs/specs,
the specification/semconv/proto GitHub repos, W3C TRs), not from model memory. Stability labels
are the spec's own, recorded per section.

## Files

| File                                                       | Scope                                                                                                                               | Headline stability                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [traces.md](traces.md)                                     | Trace API & SDK: span model, SpanKind, status, samplers, processors, span limits, ID generators                                     | Stable (several subsections Development)                                                     |
| [metrics.md](metrics.md)                                   | Metrics API, SDK & data model: instruments, temporality, exemplars, views, exponential histograms, cardinality                      | Stable (reset-detection notes Development)                                                   |
| [logs.md](logs.md)                                         | Log data model, severity, bridge API, SDK, events-as-logs                                                                           | Data model & bridge API Stable; events Development                                           |
| [context-propagation.md](context-propagation.md)           | Context, W3C traceparent/tracestate, baggage, B3/Jaeger interop                                                                     | Stable (OTel `ot=` tracestate extension Development)                                         |
| [otlp.md](otlp.md)                                         | OTLP protocol: transports, partial success, retry semantics, JSON encoding, exporter env vars                                       | Stable for traces/metrics/logs; profiles Development                                         |
| [resource-and-config.md](resource-and-config.md)           | Resource spec & merge rules, resource semconv, consolidated SDK env-var table, declarative config, entities                         | Resource Stable; declarative config Stable (`OTEL_CONFIG_FILE`); entities Development        |
| [semantic-conventions.md](semantic-conventions.md)         | Naming rules, requirement levels, HTTP/DB/messaging/RPC/exceptions/code/gen-ai domains, schema-URL migrations                       | HTTP & DB Stable; RPC RC; messaging & gen-ai Development                                     |
| [stability-and-compliance.md](stability-and-compliance.md) | Stability taxonomies, versioning guarantees, compliance matrix, error-handling & performance principles, instrumentation guidelines | Meta-spec (see per-section labels)                                                           |
| [emerging-and-compat.md](emerging-and-compat.md)           | Profiles signal, telemetry schemas deep-dive, Prometheus/OpenMetrics interop, OpenTracing/OpenCensus shims                          | Profiles Alpha/Development; schemas Stable (file format 1.1.0 Development); shims Deprecated |

## Maple's three compliance surfaces

**1. Ingest gateway as an OTLP server** ([otlp.md](otlp.md) is the contract):

- Partial-success responses are a MUST. A partially bad batch gets 200 with `rejected_*` counts;
  never fail the whole batch for a few bad items. Return 400 only for fully undecodable requests.
- The retryable HTTP status set is exactly {429, 502, 503, 504}.
- Every 4xx/5xx body MUST be a protobuf `Status`.
- gzip decoding is a server MUST.
- OTLP/JSON uses hex IDs, lowerCamelCase fields, and numeric enums. Unknown fields MUST be ignored.

**2. Self-instrumentation as an SDK consumer** ([traces.md](traces.md),
[resource-and-config.md](resource-and-config.md), [stability-and-compliance.md](stability-and-compliance.md)):

- Use per-component instrumentation scopes over one global tracer.
- SDKs MUST NOT throw at runtime.
- SERVER-span status is Error only on 5xx. `apps/ingest` already implements this in
  `otel_status_for_rejection` (`apps/ingest/src/main.rs`).
- `deployment.environment.name` is the canonical key. The legacy `deployment.environment` is
  formally deprecated; our dual emission is a migration bridge, not the end state.

**3. UI/query semantics as a data consumer** ([semantic-conventions.md](semantic-conventions.md),
[logs.md](logs.md), [metrics.md](metrics.md)):

- Span status stored as `"Ok"/"Error"/"Unset"` matches the spec enum spelling. The wire form
  `STATUS_CODE_*` is translated once at the OTLP boundary.
- Log error classification should key on `SeverityNumber >= 17`, not string matching on
  `SeverityText`.
- Warehouse reads coalesce `db.statement` to `db.query.text` and `db.system` to `db.system.name`.
  This mirrors the official DB-semconv stabilization renames.
- An "event" is now a LogRecord with `EventName` set. Span events and `RecordException()` are on a
  deprecation path toward log-based events.

## Known gaps / items to re-verify

Residue from the research pass. Each is also flagged inline in its file.

- **Jaeger `uber-trace-id` format** was sourced via search synthesis (the official page returned
  404). Spot-check against current Jaeger docs before quoting externally
  ([context-propagation.md](context-propagation.md)).
- **W3C Baggage document-track status** (Editor's Draft vs Candidate Recommendation) can shift.
  Re-check before citing externally.
- **Global metrics cardinality-limit env var**: none found in the general spec. Recorded as
  unverified absence, not confirmed absence ([metrics.md](metrics.md)).
- **Env-var vs declarative-config precedence** when both are present is not precisely specified
  by the spec yet ([resource-and-config.md](resource-and-config.md)).
- **Semconv general-naming and registry landing pages** were partially sourced from search
  snippets after URL churn ([semantic-conventions.md](semantic-conventions.md)).
- ~~Attribute value-type unification~~: resolved 2026-07-05 against raw
  `specification/common/README.md`. Attribute values are full `AnyValue` (nested maps/arrays
  allowed); older SDKs emit the stricter primitives + homogeneous-arrays subset.

## Canonical sources

- Spec hub: https://opentelemetry.io/docs/specs/otel/
- Semantic conventions: https://opentelemetry.io/docs/specs/semconv/ ·
  registry repo: https://github.com/open-telemetry/semantic-conventions
- OTLP: https://opentelemetry.io/docs/specs/otlp/ ·
  proto: https://github.com/open-telemetry/opentelemetry-proto
- Specification repo (raw markdown is the ground truth when the website summarizes):
  https://github.com/open-telemetry/opentelemetry-specification
- W3C Trace Context: https://www.w3.org/TR/trace-context/ · W3C Baggage: https://www.w3.org/TR/baggage/
- Compliance matrix (SDK conformance, not receiver conformance):
  https://github.com/open-telemetry/opentelemetry-specification/blob/main/spec-compliance-matrix.md
