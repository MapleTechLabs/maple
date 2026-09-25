# Attributes Maple recognizes

Maple stores every OTel attribute you send verbatim. A curated set gets special treatment: pre-extracted into fast columns at ingest, exposed as short filter aliases, rendered as colored badges, used to draw the service map, or scored higher in the log attribute chips. This page is organized by **the feature you want to unlock**, so you can pick the attributes worth instrumenting and skip the rest.

Most of these follow the [OTel semantic conventions](https://opentelemetry.io/docs/specs/semconv/). If your SDK emits standard attributes you usually don't need to do anything extra.

The [`maple-audit` skill](../skills/maple-audit/SKILL.md) encodes this registry as an auditable checklist (`checks.md`). Keep the two in sync when adding attributes here.

## Service identity

The bare minimum every span needs. `service.name` is the primary axis Maple groups by. Without it, OTel SDKs fall back to `unknown_service:<process>`, which Maple's setup audit flags.

| Attribute             | Example                | What Maple does with it                                                                                     |
| --------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `service.name`        | `api`, `ingest`, `web` | **Required.** Primary grouping for services list, service map, dashboards, alerts. Filter alias: `service`. |
| `service.version`     | `1.4.2`, `c0b92f68`    | Per-version slices on service overview. Skipped from log chips but always queryable.                        |
| `service.namespace`   | `payments`             | Logical grouping above `service.name`. Skipped from log chips.                                              |
| `service.instance.id` | UUID per process       | Distinguishes replicas of the same service. Skipped from log chips.                                         |

## Deployment & version tracking

Tag every span with these to get per-environment and per-version slices across the services table, service map, and per-service overview.

| Attribute                     | Example      | What Maple does with it                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment.environment.name` | `production` | The current OTel key. Filterable everywhere; per-env throughput / latency / error rate; environment chips in span detail.                                                                                                                                                       |
| `deployment.environment`      | `production` | The deprecated spelling of the same attribute. Read everywhere the `.name` key is, so older instrumentation keeps working.                                                                                                                                                      |
| `vcs.ref.head.revision`       | `c0b92f68…`  | The commit a service was built from. Release markers, the deploy list and per-version metrics in service overview; exposed as the `commit_sha` discovery facet so you can pivot by deploy. (`deployment.commit_sha`, Maple's former vendor key, is retired and no longer read.) |

OpenTelemetry renamed this attribute (`deployment.environment` → `deployment.environment.name`). Maple reads whichever one your spans carry and prefers `.name` when both are present, so emitting either is fine. Maple's own SDKs dual-emit both. The same holds for `messaging.destination` → `messaging.destination.name` on messaging spans. The shared expressions live in [semconv-renames.ts](../packages/domain/src/tinybird/semconv-renames.ts). In the search bar, `env`, `environment`, and `commit_sha` are short aliases; see [Filter aliases](#filter-aliases) below.

## Span status & kind

Two span-level fields (not attributes) that Maple reads directly. Both spellings are load-bearing: typos silently drop spans out of dashboards.

### Status code: **Title Case is required**

| Value   | When to set it                          |
| ------- | --------------------------------------- |
| `Ok`    | Successful operation                    |
| `Error` | Failed operation                        |
| `Unset` | OTel default; status not explicitly set |

Use the strings `"Ok"`, `"Error"`, `"Unset"` exactly. The error-rate widget filters on `StatusCode = 'Error'`, so uppercase (`ERROR`) or lowercase (`error`) variants silently produce zero rows. Most OTel SDKs serialize the status enum correctly. Don't hand-stamp the wire value.

The trace UI maps these to colored badges via `getSpanStatusBadgeClass` in [span-kind.ts](../packages/ui/src/lib/span-kind.ts).

### Span kind

| Value      | Set it on                                                               |
| ---------- | ----------------------------------------------------------------------- |
| `Server`   | Inbound network request handlers (HTTP/gRPC servers)                    |
| `Client`   | Outbound network calls (HTTP clients, DB drivers, message producers)    |
| `Producer` | Queue producers                                                         |
| `Consumer` | Queue consumers                                                         |
| `Internal` | In-process work (default; cache lookups, validation, query compilation) |

`Client` spans get a small outgoing-arrow icon in HTTP labels and render their route as `host+path`, so the destination is visible. `Server` spans render path-only. The [service map](#service-map) only draws edges from `Client` / `Producer` spans. A network call left on `Internal` is invisible in the map.

## HTTP requests

The most heavily instrumented namespace. Maple extracts three fields into columns of `trace_list_mv` (root spans) at write time, then renders method, route, and status code in trace rows.

### Fast columns

Filtering on these scans a small column instead of doing a per-row map lookup. The legacy and current OTel semconv names map to the same column, and the first non-empty source wins, so you don't need to migrate just for fast filtering.

| Attribute(s)                                    | MV column        |
| ----------------------------------------------- | ---------------- |
| `http.method`, `http.request.method`            | `HttpMethod`     |
| `http.route`, `url.path`, `http.target`         | `HttpRoute`      |
| `http.status_code`, `http.response.status_code` | `HttpStatusCode` |

### Method color pills

`http.method` / `http.request.method` drives a colored pill on the span row. Colors come from `HTTP_METHOD_COLORS` in [http.ts](../packages/ui/src/lib/http.ts):

| Method  | Color     |
| ------- | --------- |
| GET     | Blue      |
| POST    | Orange    |
| PUT     | Green     |
| PATCH   | Gray      |
| DELETE  | Red       |
| HEAD    | Gray      |
| OPTIONS | Dark gray |

### Status badge tiers

`http.status_code` / `http.response.status_code` renders as a colored badge in the trace list (`HttpStatusBadge` in [traces-table.tsx](../apps/web/src/components/traces/traces-table.tsx)):

| Status range | Tone                          |
| ------------ | ----------------------------- |
| 5xx          | Error (red)                   |
| 4xx          | Warn (amber)                  |
| 3xx          | Chart color (`chart-p50`)     |
| 1xx–2xx      | Info (blue)                   |

In log chips the same value scores 95 (top of the chips, just below `exception.*`). See [Attribute prominence](#appendix-attribute-prominence-scoring).

### Route extraction & fallback chain

For full HTTP info (`getHttpInfo` in [http.ts](../packages/ui/src/lib/http.ts)), Maple tries each source in order until one matches:

**Method:** `http.method` → `http.request.method` → span name (e.g. `http.server GET /path`, or bare `GET /path`).

**Route on server spans:** `http.route` → `http.target` → `url.path`.

**Route on client spans:** `http.route` → parsed `url.full` / `http.url` (host+path) → `server.address` / `net.peer.name` combined with `url.path` / `http.target`.

**Status:** `http.status_code` → `http.response.status_code`.

So `url.full` (e.g. `https://api.tinybird.co/v0/sql`) on a `Client` span lights up route rendering automatically. Prefer `http.route`: it is a semantic path (`/api/users/:id`) instead of a high-cardinality URL.

## Service map

The map renders nodes for services and edges for the calls between them. Three layers feed it; see [service-map-architecture.md](service-map-architecture.md) for the data path.

### 1. Service-to-service edges

An edge is drawn when a `Client` or `Producer` span has a child `Server` or `Consumer` span in a different service. Maple joins the two on `TraceId` and `ParentSpanId`, and the target is the child span's `service.name`. The scheduled `ServiceMapRollupService` rolls these joins into `service_map_edges_hourly`.

```
GET /v1/users  (service.name=api, span.kind=Client)
  └─ child: GET /v1/users  (service.name=users-service, span.kind=Server)
                            └──> draws an edge api → users-service
```

Two things must hold. The caller must propagate trace context (`traceparent`) so the callee's span is a child of the client span. The callee must be instrumented and export to the same org. A network call left on `Internal`, or a callee that starts a new trace, draws no edge. `peer.service` is not read for these edges, because modern instrumentation no longer emits it.

### 2. Database nodes

Emit `db.system.name` (or the legacy `db.system`) on the `Client` span. The `service_map_db_edges_hourly_mv` materialized view ([materializations.ts](../packages/domain/src/tinybird/materializations.ts)) groups those spans by system and namespace. The namespace resolves `db.namespace` → `db.name` → `server.address` → `net.peer.name`, so two databases of the same system become two nodes. Services calling the same database share one node.

```
SELECT * FROM users  (span.kind=Client, db.system.name=postgresql, db.namespace=app)
                            └──> draws an edge api → postgresql (app) DB node
```

### 3. External targets

`Client` and `Producer` spans without `db.system.name` land in `service_external_edges_hourly` and show on the service's Dependencies tab. The target is the messaging destination (or `messaging.system`), then `rpc.service` (or `rpc.system`), then `server.address` → `http.host` → `url.authority`.

Keep `service.name` spelling consistent across deployments of the same service. `users`, `Users` and `users-svc` become three separate nodes.

## Database queries

Besides the service map, these drive the log chips and the AI error-debug prompt context. The current semconv name and its legacy spelling score the same.

| Attribute                            | What Maple does with it                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `db.system.name`, `db.system`        | Scored 70 in log chips; toned `info`; database identity for service map DB nodes.                     |
| `db.query.text`, `db.statement`      | Scored 70; rendered in span detail; included as context in the error-debug prompt.                    |
| `db.operation.name`, `db.operation`  | Scored 70 (e.g. `"SELECT"`, `"INSERT"`).                                                              |

Source: `scoreKey` in [log-attributes.ts](../packages/ui/src/lib/log-attributes.ts).

## Caching

Maple treats a span as a cache span when it carries `cache.system` or `cache.result`. The trace UI then renders a hit/miss badge and an operation pill (GET / SET / DELETE) on the span row.

| Attribute                | Example                | What Maple does with it                                                       |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------- |
| `cache.system`           | `redis`, `memcached`   | Identifies the cache backend; presence triggers cache-span detection.         |
| `cache.result`           | `hit` \| `miss`        | Drives the hit/miss badge color; presence also triggers cache-span detection. |
| `cache.name`             | `user-sessions`        | Logical cache name shown in span detail.                                      |
| `cache.operation`        | `GET`, `SET`, `DELETE` | Drives the operation pill color.                                              |
| `cache.lookup_performed` | `true` \| `false`      | Whether a lookup was actually executed (string, not bool).                    |

Source: `getCacheInfo` in [cache.ts](../packages/ui/src/lib/cache.ts).

## Errors & exceptions

Drives the error banner in the log detail view ([log-error-banner.tsx](../apps/web/src/components/logs/log-error-banner.tsx)) and the highest-priority log chip.

| Attribute           | What Maple does with it                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `exception.message` | Banner body. Falls back to `error.message`, then to the log body.                                               |
| `exception.type`    | Banner top-right monospace badge. Falls back to `error.type`.                                                   |
| `error.message`     | Same as `exception.message` (legacy fallback).                                                                  |
| `error.type`        | Same as `exception.type` (legacy fallback). Also used by Maple-internal services to categorize failure reasons. |

Any attribute matching `exception.*` scores 100 (top of the chips) and is toned `error` (red) in log chips. See `scoreKey` and `getChipTone` in [log-attributes.ts](../packages/ui/src/lib/log-attributes.ts).

If the message runs past 3 lines or 160 characters, the banner collapses by default and shows a "Show more" toggle.

## RPC

For gRPC and other RPC frameworks.

| Attribute              | What Maple does with it                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `rpc.service`          | Scored 68 in log chips; toned `info`.                                    |
| `rpc.method`           | Scored 68; toned `info`.                                                 |
| `rpc.grpc.status_code` | Scored 90 (just below HTTP status). Non-zero values are toned `error`.   |

Source: [log-attributes.ts](../packages/ui/src/lib/log-attributes.ts).

## User identity

Promotes user and customer context into the log chips so it's visible at a glance on every log row.

| Attribute                                             | What Maple does with it                          |
| ----------------------------------------------------- | ------------------------------------------------ |
| `user.id`, `enduser.id`, `customer.id`, `customer_id` | All scored 66 in log chips (equal priority).     |

Source: [log-attributes.ts](../packages/ui/src/lib/log-attributes.ts).

## Log severity

For log records (not spans). Drives the per-row color in the log list and the trace detail timeline.

| `log.severityText` value | Color theme    |
| ------------------------ | -------------- |
| `TRACE`                  | severity-trace |
| `DEBUG`                  | severity-debug |
| `INFO`                   | severity-info  |
| `WARN`, `WARNING`        | severity-warn  |
| `ERROR`                  | severity-error |
| `FATAL`                  | severity-fatal |

Matching is case-insensitive. Source: `SEVERITY_COLORS` in [severity.ts](../packages/ui/src/lib/severity.ts). `ERROR` and `FATAL` also render the error banner at the top of the log detail view ([log-detail-sheet.tsx](../apps/web/src/components/logs/log-detail-sheet.tsx)).

## Kubernetes & infrastructure

Tag spans with `k8s.*` to light up the service map's pod-count badges and the Infrastructure tab. The `maple-k8s-infra` Helm chart ([deploy/k8s-infra](../deploy/k8s-infra/README.md)) sets most of these through the OTel operator and the `k8sattributes` processor. See [service-map-infrastructure.md](service-map-infrastructure.md) for the full enrichment lifecycle.

### Workload identity (joins to `service.name`)

| Attribute              | What Maple does with it                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `k8s.deployment.name`  | Primary workload identity; joins to `service.name` to populate the Infrastructure tab. |
| `k8s.statefulset.name` | Same join, for stateful workloads.                                                     |
| `k8s.daemonset.name`   | Same join, for DaemonSets.                                                             |
| `k8s.job.name`         | Same join, for Jobs.                                                                   |

### Promoted to log chips

Resource attributes that appear in the log chips when present.

| Attribute            | What Maple does with it                   |
| -------------------- | ----------------------------------------- |
| `k8s.pod.name`       | Promoted to log attribute chips.          |
| `k8s.namespace.name` | Promoted to log attribute chips.          |
| `k8s.cluster.name`   | Cluster column on the Infrastructure tab. |
| `cloud.region`       | Promoted to log attribute chips.          |

### Node detail metadata

| Attribute             | What Maple does with it                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `k8s.node.name`       | Required to match node metrics from kubelet; node-list and node-detail views. |
| `k8s.node.uid`        | Display in node metadata panel.                                               |
| `k8s.pod.uid`         | Used to count distinct pods per workload.                                     |
| `k8s.kubelet.version` | Display in node metadata panel.                                               |
| `container.runtime`   | Display in K8s node metadata (containerd, cri-o, etc.).                       |

### Containers (Docker)

The Maple Docker agent's `docker_stats` receiver ([deploy/docker-agent](../deploy/docker-agent/README.md)) stamps these on container metrics. `/infra/containers` groups on `(container.name, host.name)`, because Docker names are only unique per host. Rows carrying a `k8s.pod.name` are treated as Kubernetes, not Docker.

| Attribute              | What Maple does with it                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `container.name`       | Container identity: list/detail views and the span/log Infrastructure tab detect key.   |
| `container.id`         | Facet cardinality (recreated containers keep their name, not their id) and correlation. |
| `container.image.name` | Image facet and display chip.                                                           |
| `compose.project`      | From the `com.docker.compose.project` label, promoted to resource by the agent; facet.  |
| `compose.service`      | From the `com.docker.compose.service` label, promoted to resource by the agent; facet.  |

To correlate **app telemetry** with containers, the app's spans must also carry `container.id`
(or at least `container.name`). `@maple-dev/effect-sdk` detects Docker identity best-effort
(mountinfo/cgroup/hostname). The reliable path is explicit:
`OTEL_RESOURCE_ATTRIBUTES=container.id=$(hostname),container.name=myservice` in the compose file
(Docker's default hostname is the short container id).

## Cloud & platform badges

These set the platform badge and runtime icon next to a service on the service map. SDKs on common platforms auto-detect most of them. The keys are listed here so self-instrumenters can match.

| Attribute              | Example values                                           | What Maple does with it                               |
| ---------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| `cloud.provider`       | `aws`, `gcp`, `azure`, `cloudflare`, `vercel`, `railway` | Provider icon / badge resolution.                     |
| `cloud.platform`       | `aws_lambda`, `cloudflare.workers`, `gcp_cloud_run`      | More granular platform badge.                         |
| `cloud.region`         | `us-west-2`, `iad1`                                      | Promoted to log chips (see Kubernetes section above). |
| `process.runtime.name` | `nodejs`, `bun`, `deno`, `workerd`, `rust`, `jvm`        | Runtime icon on the service map.                      |
| `faas.name`            | Lambda function name, Cloud Run service name             | Function-name badge on FaaS deployments.              |
| `faas.version`         | Function version / revision                              | Per-version slicing on FaaS.                          |
| `faas.instance`        | Function execution / instance ID                         | Replica identifier on FaaS.                           |

Keep `process.runtime.name` values consistent across services on the same runtime. If one service emits `nodejs` and another `node`, you get two runtime icons for the same fleet.

## Sampling-aware throughput

Maple reads the W3C `tracestate: ot=th:<threshold>` header to extrapolate throughput counts when you sample traces. See [sampling-throughput.md](sampling-throughput.md) for the math and SDK setup. There is no attribute to emit: this is a header on the trace context.

## Filter aliases

In Maple's WHERE-clause search bar (trace list, log search, dashboard widgets), a short alias resolves to the canonical attribute. Source of truth: `normalizeKey` in [packages/domain/src/where-clause.ts](../packages/domain/src/where-clause.ts).

| Alias                                 | Resolves to                                       |
| ------------------------------------- | ------------------------------------------------- |
| `service`                             | `service.name`                                    |
| `span`                                | `span.name`                                       |
| `environment`, `env`                  | `deployment.environment`                          |
| `commit_sha`, `deployment.commit_sha` | `vcs.ref.head.revision`                           |
| `root.only`                           | `root_only` (synthetic boolean: root spans only)  |
| `errors_only`                         | `has_error` (synthetic boolean: error spans only) |

So `env = "production"` and `deployment.environment = "production"` mean the same thing.

## Reserved namespace

`maple_*` is reserved for Maple platform internals (org routing, ingest auth keys). Do not use this prefix for your own attributes. The UI hides anything starting with `maple_` from the log attribute chips.

## Attributes Maple hides from log chips

These are stored on the row but skipped from the log attribute chips because they're noisy or already shown elsewhere (service column, etc.). Source: `SKIP_KEYS` / `SKIP_PREFIXES` in [log-attributes.ts](../packages/ui/src/lib/log-attributes.ts).

- `service.name`, `service.namespace`, `service.instance.id`, `service.version`
- `telemetry.sdk.*`
- `process.runtime.*`, `process.executable.*`
- `os.*`
- `host.arch`, `host.name`
- `maple_*`

The data is still queryable. You can filter or group by these in the search bar; they're just not promoted into the row's chips.

## Appendix: Attribute prominence scoring

Each log row shows its non-pinned attributes as chips, sorted by score (ties break alphabetically). Higher score = more prominent. Source: `scoreKey` in [log-attributes.ts](../packages/ui/src/lib/log-attributes.ts).

| Score | Attributes                                                                       |
| ----- | -------------------------------------------------------------------------------- |
| 100   | `error`, `exception`, `exception.*` (anything)                                   |
| 95    | `http.status_code`, `http.response.status_code`                                  |
| 90    | `rpc.grpc.status_code`                                                           |
| 80    | `http.method`, `http.request.method`                                             |
| 70    | `db.system(.name)`, `db.statement`, `db.query.text`, `db.operation(.name)`       |
| 68    | `rpc.service`, `rpc.method`                                                      |
| 66    | `user.id`, `enduser.id`, `customer.id`, `customer_id`                            |
| 60    | `duration_ms`, `latency_ms`, `http.duration`                                     |
| 55    | `http.url`, `http.route`, `url.path`                                             |
| 40    | Other `http.*`, `url.*`                                                          |
| 38    | Other `db.*`                                                                     |
| 36    | Other `rpc.*`                                                                    |
| 34    | `messaging.*`                                                                    |
| 32    | Other `user.*`, `enduser.*`                                                      |
| 25    | Anything with a dot (`namespace.key`)                                            |
| 20    | Bare keys (no namespace)                                                         |

Resource attributes appear in chips only if they're in the `PROMOTED_RESOURCE_KEYS` set (deployment env in both spellings, k8s pod/namespace, cloud region), and they score 10 lower than the same key as a log attribute.

## See also

- [sampling-throughput.md](sampling-throughput.md): sampling-aware throughput math and `tracestate: ot=th:` reading.
- [service-map-architecture.md](service-map-architecture.md): the service map's data path.
- [service-map-infrastructure.md](service-map-infrastructure.md): full lifecycle for `k8s.*` enrichment.
- [self-hosted-clickhouse.md](self-hosted-clickhouse.md): schema and column layout for self-hosters.
