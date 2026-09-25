# Maple instrumentation audit checklist

The full check registry for the `maple-audit` skill. Each check has a stable id, what to look for in the code, a severity, the Maple feature affected, and where to find the fix recipe. Maple's live `audit_setup` MCP tool reports findings under the same ids.

Severities:

- **critical**: breaks a Maple feature outright or is a data risk. Fix first.
- **warn**: the feature works degraded, or the data is harder to query than it should be.
- **info**: improves signal quality; nothing is broken.

Fix pointers reference the companion skills: `maple-onboarding-style` (general), `maple-nodejs-style`, `maple-nextjs-style`, `maple-python-style`, `maple-go-style`, `maple-rust-style`, `maple-java-style`, `maple-csharp-style`, `maple-kotlin-style`, `maple-effect-style`.

## RES: Resource attributes

Set once per process on the SDK resource, in the OTel bootstrap. Look for the resource construction (`resourceFromAttributes(...)` / `Resource.create(...)` in TS, `Resource(attributes={...})` in Python, `resource.NewWithAttributes(...)` in Go, `Resource::builder()` in Rust, `registerOTel({ attributes })` for `@vercel/otel`).

| Id     | Check                                                                                                                                                                              | Severity | Feature affected                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| RES-01 | `service.name` is set explicitly per service (not the SDK default).                                                                                                                 | critical | Without it spans land in a synthetic `unknown_service` bucket; the services list, map, and alerts are all blind. |
| RES-02 | `service.version` is set (release/semver or commit short-SHA).                                                                                                                      | warn     | Per-version slices on service overview.                                                              |
| RES-03 | `deployment.environment.name` is set (the current semconv key). Maple also accepts the legacy `deployment.environment`; emitting either works, dual-emit is what Maple's SDKs do.   | warn     | Environment filtering/slicing everywhere (`env =` alias, per-env throughput/latency/error rate).      |
| RES-04 | `vcs.repository.url.full` is set to the canonical https repo URL (not SSH, not a local path).                                                                                       | warn     | Links telemetry back to source; repo context in error debugging.                                      |
| RES-05 | `vcs.ref.head.revision` is set best-effort from build/runtime env (`VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, `RAILWAY_GIT_COMMIT_SHA`, …). Never shell out to `git` at runtime.        | warn     | Release markers and per-deploy metrics. Skipping the SHA is fine; skipping the URL (RES-04) is not.    |
| RES-06 | No invented parallel keys: `git.repo`, `app.repo_url`, `deployment.commit_sha`, `env`, `environment` as resource keys. Use the semconv keys from RES-03/04/05 exactly.              | warn     | Invented keys don't power any Maple feature; the data exists but nothing reads it.                     |
| RES-07 | `service.instance.id` set when the service runs multiple replicas.                                                                                                                  | info     | Distinguishing replicas in trace queries.                                                              |
| RES-08 | Cloud/platform attrs (`cloud.provider`, `cloud.platform`, `cloud.region`, `process.runtime.name`) present where the SDK's auto-detectors don't already supply them. Keep `process.runtime.name` values consistent across services (`nodejs` everywhere, not `nodejs` + `node`). | info | Platform badge + runtime icon on the service map. |

Fix: `maple-onboarding-style` → "VCS resource attributes", plus the per-language style skill's bootstrap section.

## STAT: Span status & kind

These are span **fields**, not attributes, and both spellings are load-bearing on the Maple side: stored values must be Title Case (`Ok` / `Error` / `Unset`, `Server` / `Client` / `Producer` / `Consumer` / `Internal`).

| Id      | Check                                                                                                                                                                                                  | Severity | Feature affected                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| STAT-01 | Status is set via the SDK's status API (`span.setStatus({ code: SpanStatusCode.ERROR })`, `span.set_status(StatusCode.ERROR)`, `span.SetStatus(codes.Error, …)`). Never a hand-stamped string attribute or a hand-built OTLP value like `"ERROR"`/`"error"`. | critical | Error analytics filter `WHERE StatusCode = 'Error'`; wrong casing silently yields **zero errors** everywhere. |
| STAT-02 | Failure paths actually set Error status + `span.recordException(err)` (or language equivalent) before rethrowing. A span that swallows errors as `Unset` hides them.                                      | critical | Error rate, error issues, error-debug context.                                                             |
| STAT-03 | Outbound network calls (HTTP clients, DB drivers, queue producers) are `Client`/`Producer` kind spans, not `Internal`. Auto-instrumentation usually gets this right; hand-rolled spans often don't.        | warn     | The service map only draws edges from `Client`/`Producer` spans; an `Internal` call is invisible in the map.  |
| STAT-04 | Inbound request handlers produce `Server` (or `Consumer`) spans.                                                                                                                                          | warn     | Route rendering, throughput attribution, Apdex.                                                              |

Fix: `maple-onboarding-style` + per-language style skill ("record exceptions" pattern; in TS/JS `withSpan` from `@maple-dev/otel-helpers` handles status + exception recording).

## SPAN: Trace coverage

These checks ask whether everything that should be traced is traced. Read the code the way an on-call operator would: when this service misbehaves, which operations would they need to see? Auto-instrumentation covers HTTP in/out, DB queries, and framework lifecycle. That is the floor. Anything above it with real latency or a failure mode needs its own span (the same bar `maple-onboard` Step 3 applies when installing).

| Id      | Check                                                                                                                                                                                                                  | Severity | Feature affected                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| SPAN-01 | Auto-instrumentation is registered for every framework and client library the service actually uses: HTTP server, HTTP client, DB driver, queue client. A used dependency with no instrumentation package/hook means that whole traffic category emits nothing. | warn     | Entire categories of work (e.g. all DB queries, all outbound HTTP) invisible in traces, latency breakdowns, and the service map. |
| SPAN-02 | Critical business operations are wrapped in spans: payment/order/signup flows, batch jobs, LLM calls, anything a human would ask "how long did it take and did it fail?" about. Span names are `domain.verb` with entity-ID attributes (order.id, tenant.id) and branch outcomes. | warn     | The trace shows one opaque parent span; no per-operation latency, error attribution, or top-operations view for the work that matters. |
| SPAN-03 | Background jobs, cron tasks, and queue consumers start their own root spans (or continue propagated context). They must not run untraced just because no inbound HTTP request started a trace.                             | warn     | Async work is completely absent from Maple; failures in jobs surface nowhere.                                  |
| SPAN-04 | Trace context propagates across async boundaries the code crosses: queue publish→consume carries context (or links), fire-and-forget tasks inherit the active span, internal service calls send `traceparent`.            | info     | Traces fragment at the boundary: the consumer's work appears as a disconnected trace instead of one end-to-end view. |
| SPAN-05 | No span noise at the other extreme: trivial getters, pure transforms, and per-item spans inside tight loops don't each get a span.                                                                                        | info     | Trace waterfalls become unreadable; span volume (and cost) inflates without signal.                            |

Static heuristics for SPAN-01/02: compare the dependency manifest (HTTP frameworks, DB drivers, queue clients, LLM SDKs) against the instrumentation registered in the bootstrap; grep entry points for job/consumer handlers with no `startActiveSpan`/`withSpan`/decorator in their call path.

Fix: `maple-onboard` Step 3 + `maple-onboarding-style` (span naming, attributes, `withSpan`); per-language style skill for the auto-instrumentation package list.

## MAP: Service-map attribution

Maple draws a service-to-service edge by joining a `Client`/`Producer` span to its child `Server`/`Consumer` span in the downstream service (same trace, `ParentSpanId` = the client span's id). `peer.service` does not draw edges. Database nodes key on `db.system.name` (legacy `db.system` accepted) plus `db.namespace`. Other outbound `Client`/`Producer` calls become external nodes keyed on `messaging.*`, `rpc.*`, or `server.address`.

| Id     | Check                                                                                                                                                                       | Severity | Feature affected                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| MAP-01 | Every call to another **internal** service is a `Client`/`Producer` span that injects `traceparent`, and the callee is instrumented so its `Server`/`Consumer` span is a child of that span. | critical | No child span in the callee ⇒ no edge; the call shows at most as an external host node.                    |
| MAP-02 | DB client spans set `db.system.name` (e.g. `postgresql`, `redis`, `clickhouse`; legacy `db.system` is accepted) and `db.namespace` (the database name).                         | critical | No `db.system.name` ⇒ no DB node; the call renders as a generic external host. No `db.namespace` ⇒ every database behind that driver collapses into one anonymous node. |
| MAP-03 | Dependency-naming values (`db.system.name`, `messaging.system`, `rpc.system`, `peer.service` where emitted) are spelled consistently across services (`clickhouse`, not `clickhouse` + `ClickHouse`). | warn     | Each spelling becomes its own node, fragmenting one logical dependency.                                    |
| MAP-04 | Queue/RPC dependencies set `messaging.system` + `messaging.destination.name` (queues) or `rpc.system` + `rpc.service` (RPC). Outbound HTTP to third parties sets `server.address` (auto-instrumentation does). | warn     | External-dependency nodes and edges on the map.                                                           |

Fix: `maple-onboarding-style` plus the per-language style skill (use the framework's instrumented HTTP client so `Client` spans and `traceparent` injection come for free).

## REN: Deprecated / non-conforming attribute keys

<!-- This table mirrors ATTRIBUTE_RENAMES in packages/domain/src/recommendations.ts (the engine
     behind Maple's in-product Recommendation Issues). When the Maple MCP is connected, the
     get_instrumentation_recommendations tool is AUTHORITATIVE: it reconciles against live span
     data. This static table only powers the code-side audit. -->

Maple keeps fallback chains for the common legacy HTTP keys (legacy and current names feed the same fast columns), so these renames are for forward compatibility and clean querying. They are `warn`, not breakage. Search the codebase for the deprecated key in `setAttribute`/`set_attribute`/attribute-map literals.

| Id     | Deprecated key                  | Canonical key                  |
| ------ | -------------------------------- | ------------------------------- |
| REN-01 | `http.method`                    | `http.request.method`           |
| REN-02 | `http.status_code`               | `http.response.status_code`     |
| REN-03 | `http.url`                       | `url.full`                      |
| REN-04 | `http.target`                    | `url.path`                      |
| REN-05 | `http.scheme`                    | `url.scheme`                    |
| REN-06 | `http.host`                      | `server.address`                |
| REN-07 | `http.flavor`                    | `network.protocol.version`      |
| REN-08 | `http.request_content_length`    | `http.request.body.size`        |
| REN-09 | `http.response_content_length`   | `http.response.body.size`       |
| REN-10 | `http.user_agent`                | `user_agent.original`           |
| REN-11 | `net.peer.name`                  | `server.address`                |
| REN-12 | `net.peer.port`                  | `server.port`                   |
| REN-13 | `net.host.name`                  | `server.address`                |
| REN-14 | `net.host.port`                  | `server.port`                   |
| REN-15 | `net.sock.peer.addr`             | `network.peer.address`          |
| REN-16 | `net.sock.peer.port`             | `network.peer.port`             |
| REN-17 | `net.transport`                  | `network.transport`             |
| REN-18 | `net.protocol.name`              | `network.protocol.name`         |
| REN-19 | `net.protocol.version`           | `network.protocol.version`      |
| REN-20 | `db.statement`                   | `db.query.text`                 |
| REN-21 | `db.operation`                   | `db.operation.name`             |
| REN-22 | `db.system`                      | `db.system.name`                |
| REN-23 | `db.name`                        | `db.namespace`                  |
| REN-24 | `db.sql.table`                   | `db.collection.name`            |
| REN-25 | `messaging.destination`          | `messaging.destination.name`    |
| REN-26 | `messaging.url`                  | `server.address`                |
| REN-27 | `messaging.protocol`             | `network.protocol.name`         |
| REN-28 | `messaging.protocol_version`     | `network.protocol.version`      |
| REN-29 | `faas.execution`                 | `faas.invocation_id`            |
| REN-30 | `enduser.id`                     | `user.id`                       |
| REN-31 | `httpMethod`                     | `http.request.method`           |
| REN-32 | `httpStatusCode`                 | `http.response.status_code`     |
| REN-33 | `httpUrl`                        | `url.full`                      |
| REN-34 | `httpRoute`                      | `http.route`                    |
| REN-35 | `dbStatement`                    | `db.query.text`                 |
| REN-36 | `dbOperation`                    | `db.operation.name`             |
| REN-37 | `userId`                         | `user.id`                       |

All REN checks are **warn**. Two extra rules:

- **REN-DUAL (warn):** if a service emits *both* the deprecated and the canonical key on the same spans (double-emission), standardize on the canonical key at the SDK. An ingest mapping cannot merge them: the canonical key already exists, so the mapping would silently no-op.
- **Fix routes:** pure renames can be fixed either at the SDK (preferred) or by accepting the corresponding recommendation in Maple under Settings → Ingestion (creates an ingest attribute mapping). Double-emission and naming issues can only be fixed at the SDK.

## LOG: Logs

| Id     | Check                                                                                                                                                                                                | Severity | Feature affected                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| LOG-01 | An OTLP log bridge/handler is wired under the app's existing logger (OTel `LoggerProvider` + the language's bridge: `logs` SDK + winston/pino transport, Python `LoggingHandler`, Rust `tracing` layer). Stdout-only logging never reaches Maple. | critical | Logs don't exist in Maple at all: no log search, no trace-correlated logs.                             |
| LOG-02 | Logs emitted inside an active span carry `trace_id`/`span_id`. Most bridges inject them automatically; verify the bridge sits on the path the app actually logs through.                                   | critical | Log↔trace correlation: jumping from a trace to its logs and back.                                      |
| LOG-03 | Logs are structured: fields like `order_id`, `user_id` are attributes, not interpolated into the message string.                                                                                        | warn     | Attribute chips, filtering, log pattern mining.                                                         |
| LOG-04 | Severity uses the standard levels (`TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR`/`FATAL`). Error-level logs are reserved for unrecoverable conditions needing intervention.                                     | warn     | Severity row coloring; `ERROR`/`FATAL` drive the error banner.                                          |

Fix: `maple-onboarding-style` "Signals" + per-language style skill's log-bridge section.

## MET: Metrics

| Id     | Check                                                                                                                                                                  | Severity | Feature affected                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| MET-01 | Metric labels are low-cardinality: no user IDs, order IDs, request IDs, or raw URLs as dimensions (tenant-like bounded IDs are fine if the repo already treats them that way). | warn     | High-cardinality labels explode series counts and slow every metrics query. |
| MET-02 | Business state transitions have counters (created/completed/failed/retried) and key operations have latency histograms.                                                      | info     | Dashboards and alerts on business health, not just HTTP plumbing.            |
| MET-03 | Meters/instruments are created once at module scope, not per call.                                                                                                            | info     | Avoids churn and duplicate instrument registration.                          |

Fix: `maple-onboarding-style` "Signals" / "Metrics" sections.

## NAME: Naming conventions

| Id      | Check                                                                                                                                       | Severity | Feature affected                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| NAME-01 | Attribute keys are lowercase `dotted.snake_case` and namespaced: no camelCase, no bare un-namespaced keys (covered keys: see REN-31…37).      | info     | Un-namespaced keys score lowest in the chip strip; inconsistent keys fragment queries. |
| NAME-02 | Span names are low-cardinality `domain.verb` (`order.process`, `payment.charge`). Never put IDs or full URLs in the span name.                    | warn     | High-cardinality span names break operation grouping and top-operations views.         |
| NAME-03 | No `maple_*`-prefixed attributes. That namespace is reserved for Maple platform internals and hidden from the UI.                             | warn     | Attributes silently hidden from chips.                                                 |

## PII: Sensitive data

| Id     | Check                                                                                                                                                          | Severity | Feature affected                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------- |
| PII-01 | No emails, passwords, tokens, API keys, auth headers, or full request/response bodies in span/log attributes. Grep attribute call sites for these value sources.    | critical | Data risk: telemetry is broadly visible and retained. |

## LLM: gen_ai conventions

Only applies when the project calls an LLM provider (OpenAI, Anthropic, Google, …).

| Id     | Check                                                                                                                                                                            | Severity | Feature affected                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------- |
| LLM-01 | LLM calls are observed by provider instrumentation (OpenInference packages) or carry `gen_ai.*` attributes (`gen_ai.provider.name`, `gen_ai.request.model`, token usage).              | info     | Agent Sessions' model and token views. |
| LLM-02 | Cost, when recorded, is the provider's billed amount on `gen_ai.usage.cost`; no `llm.cost_usd`-style metrics; no duplicate token counters where provider instrumentation already captures usage; no invented parallel `llm.*` keys. | info     | Maple never prices tokens, so `gen_ai.usage.cost` is its only cost source; duplicates skew totals. |

Fix: `maple-onboarding-style` "LLM calls".
