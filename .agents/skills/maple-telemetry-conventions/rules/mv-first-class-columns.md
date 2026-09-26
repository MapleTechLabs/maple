# Tinybird MV pre-extracted columns

Some span and resource attributes are extracted into typed columns at write time by Tinybird materialized views. These columns are first-class: they sit in sorting keys and projections, work in `WHERE` / `GROUP BY` without a Map lookup, and drive dashboard widgets directly. Everything else stays in the `SpanAttributes` / `ResourceAttributes` Map columns.

This file is the inventory. When a query filters on one of these keys, use the column. When you add an MV column, follow the source-spelling rule at the bottom.

Source: `packages/domain/src/tinybird/materializations.ts` (search for the MV name). Read `docs/warehouse-rollups.md` before adding an MV.

---

## `service_map_spans_mv`

Projection of `Client`/`Producer`/`Server`/`Consumer` spans for the service map. The parent side of the edge join.

| Column | Extracted from |
|---|---|
| `DeploymentEnv` | `DEPLOYMENT_ENV_SQL` |

No attribute decides the edge. The downstream service comes from the join (see `service_map_edges_hourly` below).

## `service_map_children_mv`

`Server`/`Consumer` spans that have a parent. The child side of the edge join.

| Column | Extracted from |
|---|---|
| `DeploymentEnv` | `DEPLOYMENT_ENV_SQL` |

## `service_map_edges_hourly` (not an MV extraction)

Hourly service-to-service edges. `ServiceMapRollupService` (`packages/backend/src/services/dashboards/ServiceMapRollupService.ts`) fills it on a schedule by joining each `Client`/`Producer` span to its child `Server`/`Consumer` span (`serviceMapEdgeJoinQuery` in `packages/query-engine/src/ch/queries/service-map.ts`). An incremental MV cannot express that cross-span join. `service_map_edges_hourly_ingest_mv` only forwards the rollup's rows from the Null ingest source into the aggregate target.

| Column | Derived from |
|---|---|
| `SourceService` | parent span's `ServiceName` |
| `TargetService` | child span's `ServiceName` |

## `service_map_db_edges_hourly_mv`

Hourly service-to-database edges from `Client`/`Producer` spans with a database system set.

| Column | Extracted from |
|---|---|
| `DbSystem` | `DB_SYSTEM_ATTR_SQL`: `db.system.name`, fallback `db.system` |
| `DbNamespace` | `DB_NAMESPACE_ATTR_SQL`: `db.namespace` -> `db.name` -> `server.address` -> `net.peer.name` ('' when none) |
| `DeploymentEnv` | `DEPLOYMENT_ENV_SQL` |

Both fragments live in `packages/domain/src/tinybird/db-query-shape-sql.ts`. `service_map_db_query_shapes_hourly_mv` uses the same `DbSystem` / `DbNamespace` expressions.

## `service_external_edges_hourly_mv`

Hourly edges from `Client`/`Producer` spans without `db.system.name` to external targets (the service-detail Dependencies tab).

| Column | Extracted from |
|---|---|
| `TargetType` | `messaging` if a messaging destination or `messaging.system` is set, else `rpc` if `rpc.service`/`rpc.system` is set, else `http` |
| `TargetSystem` | `messaging.system` or `rpc.system` ('' for http) |
| `TargetName` | messaging destination (`MESSAGING_DESTINATION_SQL`), `rpc.service`, or for http `server.address` -> `http.host` -> `url.authority` |
| `DeploymentEnv` | `DEPLOYMENT_ENV_SQL` |

## `service_overview_spans_mv`, `service_overview_hourly_mv`, `service_overview_minutely_mv`

Service-overview projection and rollups over entry-point spans.

| Column | Extracted from |
|---|---|
| `DeploymentEnv` | `DEPLOYMENT_ENV_SQL` |
| `CommitSha` | `ResourceAttributes['vcs.ref.head.revision']` |
| `ServiceNamespace` | `ResourceAttributes['service.namespace']` |

## `service_platforms_hourly_mv`

Per-service hosting-platform attributes for the service map's runtime-icon and platform-badge resolver. Each column is `max()` of the attribute, so any non-empty value in the hour wins.

| Column | Extracted from |
|---|---|
| `DeploymentEnv` | `DEPLOYMENT_ENV_SQL` |
| `K8sCluster` | `ResourceAttributes['k8s.cluster.name']` |
| `K8sPodName` | `ResourceAttributes['k8s.pod.name']` |
| `K8sDeploymentName` | `ResourceAttributes['k8s.deployment.name']` |
| `K8sStatefulSetName` | `ResourceAttributes['k8s.statefulset.name']` |
| `K8sDaemonSetName` | `ResourceAttributes['k8s.daemonset.name']` |
| `K8sNamespaceName` | `ResourceAttributes['k8s.namespace.name']` |
| `CloudPlatform` | `ResourceAttributes['cloud.platform']` |
| `CloudProvider` | `ResourceAttributes['cloud.provider']` |
| `FaasName` | `ResourceAttributes['faas.name']` |
| `MapleSdkType` | `ResourceAttributes['maple.sdk.type']` |
| `ProcessRuntimeName` | `ResourceAttributes['process.runtime.name']` |

## `error_events_mv` / `error_events_by_time_mv`

Built from `traces WHERE StatusCode = 'Error'` with one shared `SELECT`. Unwraps the first OTel `exception` event from the `EventsName` / `EventsAttributes` arrays.

| Column | Extracted from |
|---|---|
| `ExceptionType` | first `exception` event's `exception.type`, with fallbacks (see the file) |
| `ExceptionMessage` | first `exception` event's `exception.message` |
| `ExceptionStacktrace` | first `exception` event's `exception.stacktrace` |
| `TopFrame` | computed from the stacktrace |
| `FingerprintHash` | `cityHash64` of org, service, type, top-3 normalized frames, and message signature |
| `DeploymentEnv` | `DEPLOYMENT_ENV_SQL` |

The fingerprint normalization is mirrored in `packages/domain/src/tinybird/fingerprint.ts`. Read `docs/error-issue-lifecycle.md` before changing it.

## `trace_list_mv_mv` (target `trace_list_mv`)

Trace list for the trace search UI, pre-filtered to entry-point spans.

| Column | Extracted from |
|---|---|
| `HttpMethod` | `SpanAttributes['http.method']`, fallback `http.request.method` |
| `HttpRoute` | `SpanAttributes['http.route']`, fallbacks `url.path`, `http.target` |
| `HttpStatusCode` | `SpanAttributes['http.status_code']`, fallback `http.response.status_code` |
| `DeploymentEnv` | `DEPLOYMENT_ENV_SQL` |
| `ServiceNamespace` | `ResourceAttributes['service.namespace']` |

## `traces_aggregates_hourly_mv`

Hourly trace-shape rollup.

| Column | Extracted from |
|---|---|
| `DeploymentEnv` | `DEPLOYMENT_ENV_SQL` |

It also groups by `ServiceName`, `SpanName`, `SpanKind`, `StatusCode`, and `IsEntryPoint`.

## `logs_aggregates_hourly_mv`

Extracts `DeploymentEnv` through `DEPLOYMENT_ENV_SQL` and `ServiceNamespace` from `ResourceAttributes['service.namespace']`.

## Other MVs

`service_operations_*`, `ai_trace_index_mv`, `span_metrics_calls_hourly_mv`, and the attribute key/value catalogs also extract columns. Read their `SELECT` in `materializations.ts` before filtering on them.

---

## Cardinal rule: consistent source spellings

**If you add a pre-extracted MV column, emit the source attribute with exactly that spelling.** Don't introduce a parallel spelling the MV won't match.

Example: if a new MV column `HttpUserAgent` extracts `SpanAttributes['user_agent.original']`, every service must emit `user_agent.original`. If one service emits `user_agent.original` and another `userAgent`, only one populates the column.

Corollary: every MV extracts `DeploymentEnv` through the shared `DEPLOYMENT_ENV_SQL` fragment (`packages/domain/src/tinybird/semconv-renames.ts`), which coalesces `deployment.environment.name` over the deprecated `deployment.environment`. `MESSAGING_DESTINATION_SQL` does the same for `messaging.destination(.name)` in the external-edge MV. A bare lookup on either key alone materializes an empty environment for half the instrumentation in the wild. See `rules/resource-attributes.md`.

## When NOT to extract into a column

- **Keys you will never filter or group by.** Leave them in the Map.
- **Per-request data that varies per span.** Leave it in `SpanAttributes`. The Map column is queryable; extraction is for fields dashboards hit on every request.
- **Anything still being designed.** Pre-extraction is a one-way door once backfilled. Wait until the attribute name is stable.
