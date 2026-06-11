# Maple instrumentation audit checklist

The full check registry for the `maple-audit` skill. Each check has a stable id, what to look for in the code, a severity, the Maple feature affected, and where to find the fix recipe.

Severities:

- **critical** — breaks a Maple feature outright or is a data risk. Fix first.
- **warn** — the feature works degraded or the data is harder to query than it should be.
- **info** — nice-to-have; improves signal quality but nothing is broken.

Fix pointers reference the companion skills: `maple-onboarding-style` (general), `maple-nodejs-style`, `maple-nextjs-style`, `maple-python-style`, `maple-go-style`, `maple-rust-style`, `maple-java-style`, `maple-csharp-style`, `maple-kotlin-style`, `maple-effect-style`.

## RES — Resource attributes

Set once per process on the SDK resource, in the OTel bootstrap. Look for the resource construction (`resourceFromAttributes(...)` / `Resource.create(...)` in TS, `Resource(attributes={...})` in Python, `resource.NewWithAttributes(...)` in Go, `Resource::builder()` in Rust, `registerOTel({ attributes })` for `@vercel/otel`).

| Id     | Check                                                                                                                                                                              | Severity | Feature affected                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| RES-01 | `service.name` is set explicitly per service (not the SDK default).                                                                                                                 | critical | Without it spans land in a synthetic `unknown_service` bucket — services list, map, alerts all blind. |
| RES-02 | `service.version` is set (release/semver or commit short-SHA).                                                                                                                      | warn     | Per-version slices on service overview.                                                              |
| RES-03 | `deployment.environment.name` is set (the current semconv key). Maple also accepts the legacy `deployment.environment`; emitting either works, dual-emit is what Maple's SDKs do.   | warn     | Environment filtering/slicing everywhere (`env =` alias, per-env throughput/latency/error rate).      |
| RES-04 | `vcs.repository.url.full` is set to the canonical https repo URL (not SSH, not a local path).                                                                                       | warn     | Links telemetry back to source; repo context in error debugging.                                      |
| RES-05 | `vcs.ref.head.revision` is set best-effort from build/runtime env (`VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, `RAILWAY_GIT_COMMIT_SHA`, …). Never shell out to `git` at runtime.        | warn     | Release markers and per-deploy metrics. Skipping the SHA is fine; skipping the URL (RES-04) is not.    |
| RES-06 | No invented parallel keys: `git.repo`, `app.repo_url`, `deployment.commit_sha`, `env`, `environment` as resource keys. Use the semconv keys from RES-03/04/05 exactly.              | warn     | Invented keys don't power any Maple feature; the data exists but nothing reads it.                     |
| RES-07 | `service.instance.id` set when the service runs multiple replicas.                                                                                                                  | info     | Distinguishing replicas in trace queries.                                                              |
| RES-08 | Cloud/platform attrs (`cloud.provider`, `cloud.platform`, `cloud.region`, `process.runtime.name`) present where the SDK's auto-detectors don't already supply them. Keep `process.runtime.name` values consistent across services (`nodejs` everywhere, not `nodejs` + `node`). | info | Platform badge + runtime icon on the service map. |

Fix: `maple-onboarding-style` → "VCS resource attributes" + the per-language style skill's bootstrap section.

## STAT — Span status & kind

These are span **fields**, not attributes, and both spellings are load-bearing on the Maple side: stored values must be Title Case (`Ok` / `Error` / `Unset`, `Server` / `Client` / `Producer` / `Consumer` / `Internal`).

| Id      | Check                                                                                                                                                                                                  | Severity | Feature affected                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| STAT-01 | Status is set via the SDK's status API (`span.setStatus({ code: SpanStatusCode.ERROR })`, `span.set_status(StatusCode.ERROR)`, `span.SetStatus(codes.Error, …)`) — never a hand-stamped string attribute or a hand-built OTLP value like `"ERROR"`/`"error"`. | critical | Error analytics filter `WHERE StatusCode = 'Error'` — wrong casing silently yields **zero errors** everywhere. |
| STAT-02 | Failure paths actually set Error status + `span.recordException(err)` (or language equivalent) before rethrowing. A span that swallows errors as `Unset` hides them.                                      | critical | Error rate, error issues, error-debug context.                                                             |
| STAT-03 | Outbound network calls (HTTP clients, DB drivers, queue producers) are `Client`/`Producer` kind spans — not `Internal`. Auto-instrumentation usually gets this right; hand-rolled spans often don't.       | warn     | The service map only draws edges for `Client`/`Producer` spans; an `Internal` call is invisible in the map.   |
| STAT-04 | Inbound request handlers produce `Server` (or `Consumer`) spans.                                                                                                                                          | warn     | Route rendering, throughput attribution, Apdex.                                                              |

Fix: `maple-onboarding-style` + per-language style skill ("record exceptions" pattern; in TS/JS `withSpan` from `@maple/otel-helpers` handles status + exception recording).

## MAP — Service-map attribution

| Id     | Check                                                                                                                                                                       | Severity | Feature affected                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| MAP-01 | Every `Client`/`Producer` span calling another **internal** service sets `peer.service`, and its value exactly matches the target's `service.name`.                            | critical | No `peer.service` (or `peer.service` on a `Server` span) ⇒ no edge drawn; the call path is invisible.        |
| MAP-02 | DB client spans set `db.system` (e.g. `postgresql`, `redis`, `clickhouse`) **and** `peer.service` on the same span — both are required for a database node.                     | critical | No DB node on the map; DB calls render as generic external HTTP.                                             |
| MAP-03 | `peer.service` spelling is consistent across all emitting services (`tinybird`, not `tinybird` + `Tinybird` + `tb`). Pick one canonical name per peer.                          | warn     | Inconsistent names fragment one logical dependency into multiple map nodes.                                   |
| MAP-04 | Queue/RPC dependencies set `messaging.system` + `messaging.destination.name` (queues) or `rpc.system` + `rpc.service` (RPC).                                                    | warn     | External-dependency edges and the External Dependencies tab.                                                  |

Fix: `maple-onboarding-style`; the public reference is the "Service map" section of Maple's attributes docs (https://maple.dev/docs/concepts/otel-conventions).

## REN — Deprecated / non-conforming attribute keys

<!-- This table mirrors ATTRIBUTE_RENAMES in packages/domain/src/recommendations.ts (the engine
     behind Maple's in-product Recommendation Issues). When the Maple MCP is connected, the
     get_instrumentation_recommendations tool is AUTHORITATIVE — it reconciles against live span
     data. This static table only powers the code-side audit. -->

Maple keeps fallback chains for the common legacy HTTP keys (legacy and current names feed the same fast columns), so these are renames for forward-compatibility and clean querying — `warn`, not breakage. Search the codebase for the deprecated key in `setAttribute`/`set_attribute`/attribute-map literals.

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

- **REN-DUAL (warn):** if a service emits *both* the deprecated and the canonical key on the same spans (double-emission), standardize on the canonical key at the SDK. An ingest mapping cannot merge them — the canonical key already exists, so the mapping would silently no-op.
- **Fix routes:** pure renames can be fixed either at the SDK (preferred) or by accepting the corresponding Recommendation Issue in Maple Settings → Ingestion (creates an ingest attribute mapping). Double-emission and naming issues can only be fixed at the SDK.

## LOG — Logs

| Id     | Check                                                                                                                                                                                                | Severity | Feature affected                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| LOG-01 | An OTLP log bridge/handler is wired under the app's existing logger (OTel `LoggerProvider` + the language's bridge: `logs` SDK + winston/pino transport, Python `LoggingHandler`, Rust `tracing` layer). Stdout-only logging never reaches Maple. | critical | Logs don't exist in Maple at all — no log search, no trace-correlated logs.                            |
| LOG-02 | Logs emitted inside an active span carry `trace_id`/`span_id` (most bridges inject automatically — verify the bridge sits on the path the app actually logs through).                                   | critical | Log↔trace correlation: jumping from a trace to its logs and back.                                      |
| LOG-03 | Logs are structured — fields like `order_id`, `user_id` as attributes, not interpolated into the message string.                                                                                        | warn     | Attribute chips, filtering, log pattern mining.                                                         |
| LOG-04 | Severity uses the standard levels (`TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR`/`FATAL`). Error-level logs are reserved for unrecoverable conditions needing intervention.                                     | warn     | Severity row coloring; `ERROR`/`FATAL` drive the error banner.                                          |

Fix: `maple-onboarding-style` "Signals" + per-language style skill's log-bridge section.

## MET — Metrics

| Id     | Check                                                                                                                                                                  | Severity | Feature affected                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| MET-01 | Metric labels are low-cardinality — no user IDs, order IDs, request IDs, raw URLs as dimensions (tenant-like bounded IDs are fine if the repo already treats them that way). | warn     | High-cardinality labels explode series counts and slow every metrics query. |
| MET-02 | Business state transitions have counters (created/completed/failed/retried) and key operations have latency histograms.                                                      | info     | Dashboards and alerts on business health, not just HTTP plumbing.            |
| MET-03 | Meters/instruments are created once at module scope, not per call.                                                                                                            | info     | Avoids churn and duplicate instrument registration.                          |

Fix: `maple-onboarding-style` "Signals" / "Metrics" sections.

## NAME — Naming conventions

| Id      | Check                                                                                                                                       | Severity | Feature affected                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| NAME-01 | Attribute keys are lowercase `dotted.snake_case` and namespaced — no camelCase, no bare un-namespaced keys (covered keys: see REN-31…37).      | info     | Un-namespaced keys score lowest in the chip strip; inconsistent keys fragment queries. |
| NAME-02 | Span names are low-cardinality `domain.verb` (`order.process`, `payment.charge`) — never IDs or full URLs in the span name.                    | warn     | High-cardinality span names break operation grouping and top-operations views.         |
| NAME-03 | No `maple_*`-prefixed attributes — that namespace is reserved for Maple platform internals and hidden from the UI.                             | warn     | Attributes silently hidden from chips.                                                 |

## PII — Sensitive data

| Id     | Check                                                                                                                                                          | Severity | Feature affected                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------- |
| PII-01 | No emails, passwords, tokens, API keys, auth headers, or full request/response bodies in span/log attributes. Grep attribute call sites for these value sources.    | critical | Data risk — telemetry is broadly visible and retained. |

## LLM — gen_ai conventions

Only applies when the project calls an LLM provider (OpenAI, Anthropic, Google, …).

| Id     | Check                                                                                                                                                                            | Severity | Feature affected                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------- |
| LLM-01 | LLM calls are observed by provider instrumentation (OpenInference packages) or carry `gen_ai.*` attributes (`gen_ai.provider.name`, `gen_ai.request.model`, token usage).              | info     | LLM usage/cost views; Maple computes estimated cost from these centrally. |
| LLM-02 | No app-side pricing tables or `llm.cost_usd`-style cost math; no duplicate token counters where provider instrumentation already captures usage; no invented parallel `llm.*` keys.    | info     | Cost belongs in Maple's central pricing layer; duplicates skew totals.     |

Fix: `maple-onboarding-style` "LLM metrics".
