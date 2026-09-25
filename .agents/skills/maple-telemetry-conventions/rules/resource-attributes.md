# Resource attributes

Resource attributes are set once per process on the OTel `Resource` and apply to every span, log, and metric the process emits. They identify the service and its deployment environment. The canonical Rust implementation is `build_resource` in `apps/ingest/src/otel.rs`. The TypeScript equivalent is `resolveResourceFromEnv` in `packages/effect-sdk/src/server/resource.ts`, shared by the server and Cloudflare SDKs.

## Required identity attributes

| Key | Type | Source | Example | Notes |
|---|---|---|---|---|
| `service.name` | string | static (per service) | `"ingest"`, `"maple-api"`, `"alerting"` | Canonical name. The Rust gateway hard-codes `"ingest"`. |
| `service.namespace` | string | static (per service) | `"core"` | Optional logical group for `service.name`. Extracted to the `ServiceNamespace` column (`service_overview_spans`, `service_overview_hourly`/`_minutely`, `trace_list_mv`, `logs_aggregates_hourly`) and surfaced in the services table and trace/log filters. Maple's own services all use `core`: Workers get it from `workerTelemetryConfig` (`packages/infra/src/cloudflare/worker-telemetry.ts`), the Rust gateway from `ResourceConfig.service_namespace`. Set it through the SDK `serviceNamespace` config field in TS. It is not defaulted; external apps choose their own. |
| `service.version` | string | build time | `env!("CARGO_PKG_VERSION")` in Rust, package version in TS | Used for release correlation. |
| `service.instance.id` | string | runtime | one UUID per process | Generated at startup. Lets dashboards distinguish replicas. |

Both SDKs also stamp `vcs.repository.url.full` and, when the deploy platform provides a commit SHA, `vcs.ref.head.revision` (extracted to the `CommitSha` column).

## Deployment environment: read both, emit both

OTel renamed this attribute. The registry lists `deployment.environment.name` as stable and plain `deployment.environment` as deprecated ("Replaced by `deployment.environment.name`").

| Key | Status |
|---|---|
| `deployment.environment.name` | OTel-canonical. Emit this one from new code. |
| `deployment.environment` | Deprecated. Maple still emits it, and still **reads** it. |

**Reading is the rule that matters.** Anything that pulls the environment out of `ResourceAttributes` (an MV body, a query-engine filter, a facet) uses the shared coalesce, never a bare map lookup:

```ts
import { DEPLOYMENT_ENV_SQL, deploymentEnvExpr } from "@maple/domain/tinybird/semconv-renames"
```

```sql
coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''),
         ResourceAttributes['deployment.environment'])
```

A bare lookup on either key drops the environment for half the fleet. Our own SDKs dual-emit, a current OTel SDK sends only `.name`, and an older one sends only the legacy key. `packages/domain/src/tinybird/semconv-renames.test.ts` fails if any MV extracts `DeploymentEnv` another way. The same module carries `MESSAGING_DESTINATION_SQL` for the `messaging.destination` -> `messaging.destination.name` rename. Any future rename Maple *keys on* belongs there too.

Source: `build_resource` in `apps/ingest/src/otel.rs`

```rust
KeyValue::new("deployment.environment.name", cfg.deployment_env.clone()),
// Dual-emit the deprecated `deployment.environment` key (see below).
KeyValue::new("deployment.environment", cfg.deployment_env),
```

The TS SDK dual-emits the same pair whenever an environment resolves (`resolveResourceFromEnv`).

### Resolution order (priority)

The value comes from the first env var that resolves:

1. `MAPLE_ENVIRONMENT`: set by alchemy from `resolveDeploymentEnvironment(stage)` (`selfObservabilityEnv` in `packages/infra/src/env.ts`)
2. `RAILWAY_ENVIRONMENT_NAME`: Railway's runtime label
3. `DEPLOYMENT_ENV`: manual override of last resort
4. Default: `"development"`

`resolve_deployment_env` in `apps/ingest/src/main.rs` has the exact precedence:

```rust
std::env::var("MAPLE_ENVIRONMENT")
    .or_else(|_| std::env::var("RAILWAY_ENVIRONMENT_NAME"))
    .or_else(|_| std::env::var("DEPLOYMENT_ENV"))
    .unwrap_or_else(|_| "development".to_owned())
```

The TS SDK resolves the same chain, with the same default, in `environment` (`packages/effect-sdk/src/server/config.ts`). An explicit `environment` config field wins over it. Any new service must follow the same order. Don't read `NODE_ENV` or `ENV`.

### When can the dual-emit be dropped?

ClickHouse migration 0020 (`packages/domain/src/clickhouse/migrations/0020_semconv_key_renames.ts`) moved every MV onto the coalesce, so our own rollups no longer depend on the legacy emit. Two things still do: rows those MVs materialized before 0020 (they age out with the target TTL), and BYO-ClickHouse orgs whose schema is still pre-0020. Dropping the legacy emit is a follow-up gated on both.

## `maple_org_id`: the owning org

| Key | Type | Source | Default | Notes |
|---|---|---|---|---|
| `maple_org_id` | string | the resolved ingest key, or env `MAPLE_INTERNAL_ORG_ID` for the gateway itself | none (required) | The `OrgId` every row is scoped to. |

For telemetry that arrives through the ingest gateway, the gateway strips any client-supplied `org_id` / `maple_org_id` resource attribute and sets `maple_org_id` from the resolved ingest key (`apps/ingest/src/main.rs`). No SDK or Worker sets it by hand; Maple's own Workers get their org from the self-observability ingest key.

The gateway's own telemetry skips that path: it exports straight to the downstream collector. So `build_resource` stamps `maple_org_id` from `MAPLE_INTERNAL_ORG_ID`, and `AppConfig::from_env` refuses to boot without it. There used to be an `"internal"` fallback. It was removed (2026-08-23) because an unset value shipped the gateway's traces, logs, and metrics under an `OrgId` no org owns and no UI can read.

This is intentionally not `maple.org_id`. Resource-level `maple_org_id` is the org that owns the row. The span-level `maple.org_id` on the gateway's own spans is the customer org whose request the gateway is handling. The underscore-vs-dot spellings keep them apart in trace search.

## Effect SDK: Cloudflare Workers

TypeScript Workers get resource attributes from `MapleCloudflareSDK.make(config)` in `packages/effect-sdk/src/cloudflare/index.ts`. The config accepts `serviceName`, `serviceVersion`, `serviceNamespace`, `environment`, `repositoryUrl`, and `attributes` for extra resource keys. Unset fields fall back to env (`OTEL_SERVICE_NAME`, `MAPLE_ENVIRONMENT` chain, `OTEL_RESOURCE_ATTRIBUTES`).

When wiring a new Maple Worker:

- Use `WorkerTelemetry({ serviceName })` (or `eventTelemetry` for background work) from `packages/infra/src/cloudflare/worker-telemetry.ts`. It sets `serviceNamespace: "core"`, the repo URL, and the anticipated-4xx list.
- Deploy it with `selfObservabilityEnv(stage)` in its env so `MAPLE_ENVIRONMENT`, the ingest key, and `OTEL_RESOURCE_ATTRIBUTES=maple.region=<region>` resolve. The SDK then dual-emits `deployment.environment(.name)` itself.
- Do not pass `deployment.environment*` or `maple_org_id` through `attributes`.

## What goes here vs. on the span

| Information | Where |
|---|---|
| Identity of the service emitting the span | Resource attribute (`service.name`, `service.version`) |
| Deployment environment of the process | Resource attribute (`deployment.environment.name` + legacy) |
| Per-request data (org, user, route, status) | Span attribute (`orgId`, `tenant.userId`, `http.route`, etc.) |
| Per-request data that came in over the network | Span attribute (`maple.org_id`, `maple.signal`) |

**Rule of thumb:** if it's the same for every span the process emits, it's a resource attribute. If it varies per request, it's a span attribute.
