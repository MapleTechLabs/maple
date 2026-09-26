---
name: maple-telemetry-conventions
description: "Maple's OpenTelemetry conventions: custom span attribute keys (`maple.*` vendor namespace, `query.context`, `db.query.*`, `result.*`, `cache.*`, `tenant.*`), Title Case status codes (`Ok`/`Error`/`Unset`), resource attribute dual-emit (`deployment.environment` + `deployment.environment.name`), span kinds, Tinybird MV pre-extracted columns, loop-prevention filters, and sampling. Use whenever writing or reviewing instrumentation code in any language (TypeScript, Rust, Python) in this repo: adding `setAttribute`/`setAttributes`/`record`/`#[instrument(fields(...))]` calls, setting span status, configuring an OTLP exporter, defining a new resource attribute, or wiring a new query through `WarehouseQueryService.compiledQuery()`."
version: "1.0.0"
---

# Maple Telemetry Conventions

Reference for the language-agnostic OpenTelemetry conventions Maple uses across TypeScript (`apps/api` and the other Workers, via `@maple-dev/effect-sdk` in `packages/effect-sdk/`), Rust (`apps/ingest`), and any future Python service. These conventions are load-bearing. Tinybird materialized views pre-extract some attribute keys into columns, dashboards filter on Title Case status strings, and throughput math depends on the `SampleRate` column. Use the exact attribute spellings here in every language.

## When to apply

- Adding `setAttribute` / `Effect.annotateCurrentSpan` / `Span::current().record(...)` / `#[instrument(fields(...))]` to any code path
- Setting span status (Ok / Error / Unset)
- Wiring a new query through `WarehouseQueryService.compiledQuery()` (the `context` and `profile` options become span attributes)
- Configuring an OTLP exporter, tracer provider, or resource builder
- Introducing a new pre-extracted MV column or a new vendor attribute under `maple.*`
- Reviewing a PR that touches `packages/query-engine/src/execution/executor.ts`, `apps/ingest/src/main.rs`, `apps/ingest/src/otel.rs`, `apps/api/src/http/api-observability.ts`, `packages/effect-sdk/src/cloudflare/`, `packages/infra/src/cloudflare/worker-telemetry.ts`, or `packages/domain/src/tinybird/materializations.ts`

## Index

- `rules/span-attributes.md`: the main custom attribute keys Maple emits, grouped by namespace, with the file that sets each.
- `rules/status-and-kind.md`: Title Case status codes (`Ok`/`Error`/`Unset`), the server-span 4xx rule, and span kinds (`Server` / `Client` / `Internal`).
- `rules/resource-attributes.md`: `service.*` identity, `deployment.environment.name` resolution order, the deprecated `deployment.environment` dual-emit and read-side coalesce, and `maple_org_id`.
- `rules/language-bindings.md`: parallel TypeScript / Rust / Python snippets that emit the same attribute keys.
- `rules/mv-first-class-columns.md`: which span and resource attributes Tinybird MVs pre-extract into columns, and the rule for adding new ones.
- `rules/service-map-attribution.md`: what the service map needs to draw service edges, database nodes, runtime icons, and platform badges, plus the `peer.service` naming registry.
- `rules/loop-prevention.md`: the guards that keep Maple's self-traffic from feeding back on itself: the API `TracerDisabledWhen` filter, the ingest loopback guard, and sampling.

## Quick reference

| Topic | Rule |
|---|---|
| Status codes | Always Title Case: `"Ok"`, `"Error"`, `"Unset"`. Never `OK`, `ERROR`, `SUCCESS`, `FAILED`. |
| Vendor namespace | Custom attributes go under `maple.*`. Sub-namespaces include `maple.ingest.*`, `maple.cloudflare.*`, `maple.query.*`. |
| Standard semconv | Use OTel semconv keys verbatim: `service.name`, `http.request.method`, `db.system.name`, `error.type`. |
| Org identity | `orgId` (camelCase) in TypeScript spans, `maple.org_id` (dotted) in Rust spans. Don't unify until MVs migrate. |
| Deployment env | Emit `deployment.environment.name` (our SDKs dual-emit the deprecated `deployment.environment` too). **Read** both via `DEPLOYMENT_ENV_SQL` / `deploymentEnvExpr`, never a bare map lookup. |
| Warehouse SQL spans | Every `WarehouseQueryService.executeSql` span (a `Client` span) carries `db.system.name`, `peer.service`, `db.query.text`, `db.query.fingerprint`, `db.duration_ms`, `result.rowCount`, `orgId`, `query.context`, and `query.profile` when set. Legacy spans (pre 2026-06) use `db.statement*`/`db.system`; warehouse readers coalesce both. |
| Service map | Service-to-service edges come from joining a `Client`/`Producer` span to its child `Server`/`Consumer` span in another service, so propagate trace context and set span kinds. Database nodes need `db.system.name` (plus `db.namespace`) on a `Client`/`Producer` span. Runtime icon and platform badge need `process.runtime.name`, `cloud.platform`, `maple.sdk.type` on the resource. See `rules/service-map-attribution.md`. |
| Loop prevention | Never remove `HttpMiddleware.TracerDisabledWhen` (`apps/api/src/http/api-observability.ts`) or the ingest loopback guard (`init_tracing` in `apps/ingest/src/main.rs`). |

## Canonical references (do not modify from this skill)

- `packages/query-engine/src/execution/executor.ts`: `WarehouseQueryService.executeSql` span emission, the canonical TS example.
- `apps/ingest/src/otel.rs`: resource builder (`build_resource`), platform detection, and the client-span helpers (`forward_client_span`, `export_client_span`). The canonical Rust example for resource and outbound-span attribution.
- `apps/ingest/src/main.rs`: `handle_signal` and `handle_cloudflare_logpush` open the Server-kind `tracing::info_span!` for inbound OTLP and Logpush.
- `apps/api/src/http/api-observability.ts`: the `TracerDisabledWhen` filter and header redaction list.
- `packages/effect-sdk/src/cloudflare/index.ts`: `MapleCloudflareSDK` tracer setup. Maple's own Workers wrap it with `WorkerTelemetry` in `packages/infra/src/cloudflare/worker-telemetry.ts`.
- `packages/domain/src/tinybird/materializations.ts`: MV `SELECT` lists that pre-extract attribute keys into columns.
