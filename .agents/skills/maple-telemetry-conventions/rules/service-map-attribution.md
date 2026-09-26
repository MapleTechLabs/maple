# Service-map attribution

The service map (`apps/web/src/routes/service-map.tsx`) is built from span kinds, trace context, and a few attributes that the warehouse rollups read at write time. If a span has the wrong kind or an attribute is spelled differently, the edge, node, or badge silently disappears. There is no fallback and no warning. Read `docs/service-map-architecture.md` before changing the map itself.

## What the map renders, and what feeds each part

| Rendered element | Source | Required on the spans | Lives on |
|---|---|---|---|
| Service-to-service edge | `service_map_edges_hourly`, filled by `ServiceMapRollupService` | A `Client`/`Producer` span in service A whose child is a `Server`/`Consumer` span in service B, in the same trace | Span kind + propagated trace context |
| Database node + edge | `service_map_db_edges_hourly_mv` | `db.system.name` (legacy fallback `db.system`) on a `Client`/`Producer` span; `db.namespace` splits databases of one system into separate nodes | Span |
| External dependency (service detail) | `service_external_edges_hourly_mv` | `server.address` (HTTP), `messaging.system` + `messaging.destination.name`, or `rpc.system` + `rpc.service` on a `Client`/`Producer` span without `db.system.name` | Span |
| Platform badge (Cloudflare / AWS / Railway / k8s) | `service_platforms_hourly_mv` | `cloud.platform`, `cloud.provider`, optional `faas.name`, optional `k8s.*` | Resource |
| Runtime icon (node / bun / deno / workerd / rust) | `service_platforms_hourly_mv` | `process.runtime.name` | Resource |
| SDK badge | `service_platforms_hourly_mv` | `maple.sdk.type` | Resource |

Sources: `packages/query-engine/src/ch/queries/service-map.ts` and `packages/domain/src/tinybird/materializations.ts`.

**`peer.service` does not draw edges.** Modern OTel instrumentation rarely emits it, so the map recovers the downstream service by joining the `Client` span to its child `Server` span (`serviceMapEdgeJoinQuery`). ClickHouse migration 0002 dropped the old `peer.service` MV and the `PeerService` column. An edge needs three things: the caller's outbound span is `Client`/`Producer`, the callee's inbound span is `Server`/`Consumer`, and trace context (W3C `traceparent`) propagates between them. Both services must also export to the same Maple org.

## Resource attributes: set once at startup

Every service must publish these on its OTel `Resource`. Skip any of them and the service shows empty badges.

### TypeScript (Effect server)

Use `Maple.layer({ serviceName, serviceVersion })` from `packages/effect-sdk/src/server/index.ts`. Platform detection lives in `packages/effect-sdk/src/server/platform.ts`: it resolves `cloud.*` / `faas.*` / `process.runtime.name` from `std-env` plus per-platform env vars. Nothing else is needed.

### TypeScript (Cloudflare Workers)

Use `MapleCloudflareSDK` from `packages/effect-sdk/src/cloudflare/index.ts` (Maple's own Workers go through `WorkerTelemetry` in `packages/infra/src/cloudflare/worker-telemetry.ts`). On workerd it resolves `cloud.provider="cloudflare"`, `cloud.platform="cloudflare.workers"`, `process.runtime.name="workerd"`, and sets `maple.sdk.type="cloudflare"`.

### Rust

Use `build_resource` from `apps/ingest/src/otel.rs`:

```rust
use maple_ingest::otel::{build_resource, ResourceConfig};

let resource = build_resource(ResourceConfig {
    service_name: "ingest",
    service_namespace: "core",
    service_version: env!("CARGO_PKG_VERSION"),
    service_instance_id: uuid::Uuid::new_v4().to_string(),
    deployment_env,
    internal_org_id,
});
```

The helper sets `process.runtime.name="rust"` and `maple.sdk.type="server"`, dual-emits `deployment.environment(.name)`, and runs the same platform-detection cascade as the TS SDK (Cloudflare, AWS Lambda, Railway, Vercel, Cloud Run, Render, Fly, k8s). To add a platform, extend `detect_platform()` and mirror the env-var sources in `packages/effect-sdk/src/server/platform.ts`.

### Python (forward-looking)

Mirror the TS detection. Set the same keys with the same values. Never invent Python-specific spellings.

## Span attributes: set per outbound call

| Call type | Span kind | Required attributes | Notes |
|---|---|---|---|
| Outbound HTTP / RPC to another instrumented service | `Client` | `server.address`, `http.request.method` (or `rpc.system` / `rpc.service`) | Propagate `traceparent` so the callee's `Server` span becomes the child; that join draws the edge |
| Outbound HTTP to an uninstrumented third party | `Client` | `server.address` | Shows up as an external dependency, not a service node |
| Database call | `Client` | `db.system.name` (e.g. `clickhouse`, `tinybird`, `postgresql`), `db.namespace` | `db.system.name` makes the DB node; `db.namespace` (else `server.address`) separates databases of the same system |
| Message bus produce | `Producer` | `messaging.system`, `messaging.destination.name` | |

Maple's own code also sets `peer.service` on outbound spans (registry below). It keeps trace search consistent; the map does not read it.

### TypeScript

```typescript
const executeSql = Effect.fn("WarehouseQueryService.executeSql", { kind: "client" })(function* (/* ... */) {
    yield* Effect.annotateCurrentSpan("db.system.name", "tinybird")
    yield* Effect.annotateCurrentSpan("peer.service", "tinybird")
    // ...
})
```

Canonical example: `executeSql` in `packages/query-engine/src/execution/executor.ts`. It sets `db.system.name`, `peer.service`, and (via `warehouseTargetAttributes`) `db.namespace` / `server.address` from the resolved warehouse backend, on a `Client` span.

### Rust

For the ingest forward to the downstream collector, use `forward_client_span`:

```rust
use maple_ingest::otel::forward_client_span;

let span = forward_client_span("collector", body_size, signal.path());
forward_to_collector(...).instrument(span).await
```

The helper bakes in `peer.service`, `otel.kind="client"`, and the `http.*` field set. `url.full` and `server.address` are recorded later inside `forward_to_collector`, once the URL is resolved. Warehouse writes use `export_client_span`, which also declares `db.system.name`, `db.namespace`, and `db.collection.name`. Without `db.system.name` a warehouse write never becomes a database node.

For a new outbound peer, use `tracing::info_span!` with `otel.kind = "client"`, `"server.address"`, and `"peer.service" = <name from the registry>`.

## `peer.service` naming registry

Maple's code emits these values. Reuse them so trace search stays consistent, and add new peers here.

| Peer name | What it is |
|---|---|
| `tinybird` | Tinybird hosted warehouse |
| `clickhouse` | ClickHouse warehouse (BYO or Tinybird's ClickHouse gateway) |
| `chdb` | Embedded chDB behind the local Maple binary |
| `collector` | Maple ingest's downstream OTLP collector |
| `ingest` | Maple ingest gateway (as called by the scraper and the Cloudflare analytics poller) |
| `maple-api` | Maple API (as called by the web app) |
| `planetscale-postgres` | PlanetScale Postgres |
| `electric` | Electric sync |
| `clerk` | Clerk auth |
| `autumn` | Autumn metering |
| `github` | GitHub REST API |
| `slack`, `discord` | Chat platform APIs |
| `apns` | Apple Push Notification service |
| `planetscale-metrics` | PlanetScale per-branch `/metrics` endpoint (scraper) |
| `scrape-target` | Any other user-configured Prometheus scrape target (scraper) |

The last two are deliberately generic. Scrape targets are user-configured and unbounded, so bucket them by target type.

## Anti-patterns

- **Don't leave an outbound call as an `Internal` span.** The edge join and the DB and external MVs only read `Client`/`Producer` spans.
- **Don't break trace context across a hop.** A `Client` span whose request does not carry `traceparent` has no child `Server` span, so no edge.
- **Don't wrap a DB call's `Client` span in a second `Client` span** (e.g. an HTTP client span under `executeSql`). Maple's warehouse drivers disable the `HttpClient` tracer for this reason.
- **Don't invent platform values.** Use the OTel semconv `cloud.platform` strings (`aws_lambda`, `cloudflare.workers`, `gcp_cloud_run`, etc.) so badges match across services.
- **Don't pick a different `process.runtime.name` than TS emits for the same runtime.** TS uses `nodejs`, `bun`, `deno`, `workerd`. Rust uses `rust`. New Python services use `cpython` (the OTel semconv value). Mismatched values produce duplicate runtime icons.
- **Set attributes at span declaration, not only on success.** Failed calls must still land on the edge so the map shows per-edge error rates.

## Verification

After deploying a new service or peer:

1. Send a representative request that exercises the outbound call.
2. The service-to-service rollup runs on a schedule, and the DB/external MVs bucket hourly. The read path unions in the current partial hour from raw spans (see the live branch in `packages/query-engine/src/ch/queries/service-map.ts`), so recent traffic should appear.
3. Open the service map and confirm the expected nodes, edges, and badges.
4. If anything is missing, run the Maple MCP `inspect_trace` tool on a recent trace and compare the span kinds, parent/child links, and attributes against this rule.
