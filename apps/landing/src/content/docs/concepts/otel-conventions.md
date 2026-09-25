---
title: "OpenTelemetry Conventions"
description: "Maple's expected OpenTelemetry attributes, status codes, span kinds, and data model conventions."
group: "Concepts"
order: 1
---

Maple is fully compatible with the OpenTelemetry Protocol (OTLP). This document describes the conventions and attributes that Maple uses to power its dashboards, service maps, and analytics.

Maple stores every OTel attribute you send verbatim. A curated set gets special treatment: pre-extracted into indexed columns at ingest, exposed as short filter aliases, rendered as colored badges, used to draw the service map, or ranked higher in the log attribute chips. Most of these follow the [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/). If your SDK emits standard attributes, you usually don't need to do anything extra.

> **Audit with Claude Code:** `maple-audit` reviews an existing setup against these conventions per service, with severities, and fixes the gaps. See the [maple-audit skill](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit).

## Ingest Endpoints

Send telemetry to Maple using standard OTLP HTTP endpoints:

| Signal  | Endpoint      |
| ------- | ------------- |
| Traces  | `/v1/traces`  |
| Logs    | `/v1/logs`    |
| Metrics | `/v1/metrics` |

**Base URL:** `https://ingest.maple.dev` (EU organizations: `https://ingest.eu.maple.dev`). See [Data regions](/docs/instrumentation#data-regions).

**Content types:**

- `application/x-protobuf` (recommended)
- `application/json`

**Compression:** gzip supported via `Content-Encoding: gzip` header.

## Authentication

Include your ingest key in the request headers:

```
Authorization: Bearer YOUR_INGEST_KEY
```

Alternatively, use the `x-maple-ingest-key` header:

```
x-maple-ingest-key: YOUR_INGEST_KEY
```

Find your keys under **Settings → Ingestion** in the dashboard. Use the public key (`maple_pk_...`) in browsers and mobile apps, and the private key (`maple_sk_...`) on servers. See the [Ingest API reference](/docs/reference/ingest) for details.

## Service identity

The bare minimum every span needs. `service.name` is the primary axis Maple groups by. Without it, spans go to a synthetic `unknown_service` bucket.

| Attribute             | Example                | What Maple does with it                                                                                     |
| --------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `service.name`        | `api`, `ingest`, `web` | **Required.** Primary grouping for services list, service map, dashboards, alerts. Filter alias: `service`. |
| `service.version`     | `1.4.2`, `c0b92f68`    | Per-version slices on service overview. Hidden from log chips but always queryable.                         |
| `service.namespace`   | `payments`             | Logical grouping above `service.name`. Hidden from log chips.                                               |
| `service.instance.id` | UUID per process       | Distinguishes replicas of the same service. Hidden from log chips.                                          |

## Deployment & version tracking

Tag every span with these and you get per-environment and per-version slices across the services table, service map, and per-service overview.

| Attribute                     | Example                       | What Maple does with it                                                                             |
| ----------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `deployment.environment.name` | `production`                  | Filterable everywhere; per-env throughput / latency / error rate; environment chips in span detail. |
| `deployment.environment`      | `production`                  | Legacy alias, treated as the same value. Either spelling is accepted.                               |
| `vcs.ref.head.revision`       | `c0b92f68`                    | Git commit SHA. Enables release markers on charts and per-version metrics.                          |
| `vcs.repository.url.full`     | `https://github.com/acme/api` | Canonical repo URL. Links telemetry to source.                                                      |

`vcs.repository.url.full` and `vcs.ref.head.revision` are the OpenTelemetry semantic-convention keys. Use them exactly as named. Legacy spellings like `deployment.commit_sha`, `git.repo`, or `app.repo_url` are not read.

Set resource attributes via environment variable:

```bash
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/api,vcs.ref.head.revision=abc123"
```

In the search bar, `env`, `environment`, and `commit_sha` are short aliases. See [Filter aliases](#filter-aliases) below.

## Span Status Codes

Maple stores span status codes as title-case strings. Maple's ingest converts the OTLP status enum on the way in:

| OTLP value | Stored as | Meaning                         |
| ---------- | --------- | ------------------------------- |
| `0`        | `"Unset"` | Default. No explicit status set |
| `1`        | `"Ok"`    | Explicitly marked successful    |
| `2`        | `"Error"` | Span encountered an error       |

Set status through your SDK's status API. You don't need to convert anything yourself.

Title case matters when you filter or write queries. `StatusCode = 'Error'` matches. Uppercase (`ERROR`) or lowercase (`error`) variants match zero rows.

Only spans with status `Error` appear in error analytics.

## Span Kinds

| Kind         | Description                          | How Maple Uses It                                                                                         |
| ------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `"Server"`   | Incoming request handler             | Throughput and error rate calculations. Callee side of a service map edge. Renders path-only HTTP routes. |
| `"Client"`   | Outgoing request to another service  | Caller side of a service map edge; database and external nodes. Renders host+path HTTP routes.            |
| `"Producer"` | Async message producer               | Caller side of a service map edge; messaging nodes.                                                       |
| `"Consumer"` | Async message consumer               | Throughput calculations. Callee side of a `Producer` edge.                                                |
| `"Internal"` | Default, synchronous in-process work | Trace detail view.                                                                                        |

`Client` spans get a small outgoing-arrow icon in HTTP labels and render their route as `host+path` so the destination is visible. `Server` spans render path-only. The [Service Map](#service-map) builds edges and dependency nodes only from `Client` and `Producer` spans. A network call left on `Internal` does not appear on the map.

## HTTP Attributes

The most heavily instrumented namespace. Maple extracts three fields into indexed columns at write time, then renders method, route, and status code in trace rows.

### Fast columns

Filtering on these scans a small column instead of doing a per-row map lookup. The legacy and current OTel semconv names map to the same column. The first non-empty source wins, so you don't need to migrate just for fast filtering.

| Attribute(s)                                    | Indexed column   |
| ----------------------------------------------- | ---------------- |
| `http.method`, `http.request.method`            | `HttpMethod`     |
| `http.route`, `url.path`, `http.target`         | `HttpRoute`      |
| `http.status_code`, `http.response.status_code` | `HttpStatusCode` |

### Method color pills

`http.method` / `http.request.method` drives a colored pill on the span row:

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

`http.status_code` / `http.response.status_code` is rendered as a colored badge in the trace list:

| Status range | Tone         |
| ------------ | ------------ |
| 5xx          | Error (red)  |
| 4xx          | Warn (amber) |
| 3xx          | Blue         |
| 1xx–2xx      | Info (green) |

In log chips, the same key scores 95, just below `exception.*`. See [Attribute prominence scoring](#appendix-attribute-prominence-scoring).

### Route extraction & fallback chain

For full HTTP info, Maple tries each source in order until one matches:

- **Method:** `http.method` → `http.request.method` → span name (e.g. `http.server GET /path`, or bare `GET /path`).
- **Route on server spans:** `http.route` → `http.target` → `url.path`.
- **Route on client spans:** `http.route` → parsed `url.full` / `http.url` (host+path) → `server.address` / `net.peer.name` combined with `url.path` / `http.target`.
- **Status:** `http.status_code` → `http.response.status_code`.

If none of the route attributes are set, Maple falls back to the route in the span name.

So `url.full` (e.g. `https://api.stripe.com/v1/charges`) on a `Client` span lights up route rendering automatically. Emitting `http.route` is still preferred, because it's a semantic path (`/api/users/:id`) instead of a high-cardinality URL.

## Service Map

The map renders nodes for services and their dependencies, and edges for the calls between them. Four rules make sure your spans show up correctly.

### 1. Service-to-service edges

Maple draws an edge when a `Client` or `Producer` span in one service has a child `Server` or `Consumer` span in another service, in the same trace. Two things make that work:

- The callee is instrumented, so it records its own `Server` or `Consumer` span.
- The caller propagates trace context (the `traceparent` header), so the callee's span becomes a child of the client span.

Instrumented HTTP and RPC clients do both for you.

```
api:    GET /v1/users  (span.kind=Client, span_id=a1)
users:  GET /v1/users  (span.kind=Server, parent_span_id=a1)
                            └──> draws an edge api → users
```

`peer.service` does not draw edges. If the callee is not instrumented, or the caller drops `traceparent`, no edge is drawn. The call shows up at most as an external node (see rule 3).

### 2. Database nodes

Set `db.system.name` and `db.namespace` on database `Client` spans. The legacy `db.system` spelling is also accepted. Maple keys each database node on the pair, so services that call the same database share one node.

```
SELECT * FROM users  (span.kind=Client, db.system.name=postgresql, db.namespace=users_db)
                            └──> draws an edge api → postgresql users_db
```

Without `db.system.name`, the call renders as a generic external host. Without `db.namespace`, Maple falls back to the legacy `db.name`, then to the host (`server.address`). With none of these set, every database behind that driver collapses into one node.

### 3. External dependencies

Other outbound `Client` and `Producer` spans become external nodes. Maple picks the key in this order:

| Call type   | Attributes                                       | Node name                                  |
| ----------- | ------------------------------------------------ | ------------------------------------------ |
| Messaging   | `messaging.system`, `messaging.destination.name` | Destination name, or the system if missing |
| RPC         | `rpc.system`, `rpc.service`                      | `rpc.service`, or the system if missing    |
| HTTP, other | `server.address`                                 | Host                                       |

HTTP client instrumentation sets `server.address` automatically.

### 4. Pick canonical names

Keep `db.system.name`, `messaging.system`, and `rpc.system` values spelled the same across services. If one service emits `db.system.name=postgresql` and another emits `PostgreSQL`, they become separate nodes. Use the OpenTelemetry well-known values where one exists.

## Database queries

Besides the service map, these drive the log chips and the AI error-debug prompt context.

| Attribute                                   | What Maple does with it                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `db.system.name` (legacy `db.system`)       | Scored 70 in log chips; with `db.namespace`, keys the service map database node; toned `info` in log chips. |
| `db.namespace`                              | Names the database node on the service map.                                                                 |
| `db.query.text` (legacy `db.statement`)     | Scored 70; rendered in span detail; included as context in the error-debug prompt.                          |
| `db.operation.name` (legacy `db.operation`) | Scored 70 (e.g. `"SELECT"`, `"INSERT"`).                                                                    |

## Caching

Maple detects a cache span when `cache.system` or `cache.result` is present. When detected, the trace UI renders a hit/miss badge and an operation pill (GET / SET / DELETE) on the span row.

| Attribute                | Example                | What Maple does with it                                                       |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------- |
| `cache.system`           | `redis`, `memcached`   | Identifies the cache backend; presence triggers cache-span detection.         |
| `cache.result`           | `hit` \| `miss`        | Drives the hit/miss badge color; presence also triggers cache-span detection. |
| `cache.name`             | `user-sessions`        | Logical cache name shown in span detail.                                      |
| `cache.operation`        | `GET`, `SET`, `DELETE` | Drives the operation pill color.                                              |
| `cache.lookup_performed` | `true` \| `false`      | Whether a lookup was actually executed (string, not bool).                    |

## Errors & exceptions

Drives the error banner in the log detail panel and the highest-priority chip on every log row.

| Attribute           | What Maple does with it                                              |
| ------------------- | -------------------------------------------------------------------- |
| `exception.message` | Banner body. Falls back to `error.message`, then to the log body.    |
| `exception.type`    | Monospace badge beside the banner title. Falls back to `error.type`. |
| `error.message`     | Same as `exception.message` (legacy fallback).                       |
| `error.type`        | Same as `exception.type` (legacy fallback).                          |

Any attribute matching `exception.*` scores 100 (top of the log chips) and is toned `error` (red).

If the message runs past 3 lines or 160 characters, the banner collapses by default and shows a "Show more" toggle.

## RPC

For gRPC and other RPC frameworks.

| Attribute              | What Maple does with it                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `rpc.system`           | Names RPC dependency nodes on the service map when `rpc.service` is missing. |
| `rpc.service`          | Scored 68 in log chips; toned `info`. Names RPC nodes on the service map.    |
| `rpc.method`           | Scored 68; toned `info`.                                                     |
| `rpc.grpc.status_code` | Scored 90 (just below HTTP status). Non-zero values are toned `error` (red). |

## User identity

Promotes user/customer context to the log chips so it's visible at a glance on every log row.

| Attribute                                             | What Maple does with it                      |
| ----------------------------------------------------- | -------------------------------------------- |
| `user.id`, `enduser.id`, `customer.id`, `customer_id` | All scored 66 in log chips (equal priority). |

## Logs

### Severity Levels

`SeverityText` drives the per-row text color in the log list and the trace detail timeline.

| SeverityText | SeverityNumber | Color theme    |
| ------------ | -------------- | -------------- |
| `TRACE`      | 1-4            | severity-trace |
| `DEBUG`      | 5-8            | severity-debug |
| `INFO`       | 9-12           | severity-info  |
| `WARN`       | 13-16          | severity-warn  |
| `ERROR`      | 17-20          | severity-error |
| `FATAL`      | 21-24          | severity-fatal |

`ERROR` and `FATAL` severities also show the error banner at the top of the log detail panel.

### Trace Correlation

Logs are automatically correlated with traces when `TraceId` and `SpanId` fields are present. Most OTel SDKs inject these fields when a span is active.

## Kubernetes & infrastructure

Kubernetes resource attributes power the service map's pod-count badges and the Infrastructure pages. The `maple-k8s-infra` Helm chart sets most of these for you via the OTel operator and the `k8sattributes` processor.

### Workload identity (joins to `service.name`)

| Attribute              | What Maple does with it                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `k8s.deployment.name`  | Primary workload identity. With `k8s.namespace.name`, joins to `service.name` for infrastructure data. |
| `k8s.statefulset.name` | Same join, for stateful workloads.                                                                     |
| `k8s.daemonset.name`   | Same join, for DaemonSets.                                                                             |
| `k8s.job.name`         | Job filter and pod detail on the Infrastructure pages. Not part of the service join.                   |
| `k8s.cluster.name`     | Cluster shown on the Infrastructure pages. Not part of the service join.                               |

### Promoted to log chips

Resource attributes normally stay out of log chips. These are the exceptions, along with `deployment.environment`.

| Attribute            | What Maple does with it          |
| -------------------- | -------------------------------- |
| `k8s.pod.name`       | Promoted to log attribute chips. |
| `k8s.namespace.name` | Promoted to log attribute chips. |
| `cloud.region`       | Promoted to log attribute chips. |

### Node detail metadata

| Attribute             | What Maple does with it                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `k8s.node.name`       | Required to match node metrics from kubelet; node-list and node-detail views. |
| `k8s.node.uid`        | Display in node metadata panel.                                               |
| `k8s.pod.uid`         | Used to count distinct pods per workload.                                     |
| `k8s.kubelet.version` | Display in node metadata panel.                                               |
| `container.runtime`   | Display in K8s node metadata (containerd, cri-o, etc.).                       |

## Cloud & platform badges

These set the platform badge and runtime icon next to a service on the service map. SDKs running on common platforms detect most of them automatically. The keys are listed here so self-instrumenters can match.

| Attribute              | Example values                                    | What Maple does with it                                                                                                  |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `cloud.provider`       | `cloudflare`                                      | `cloudflare` sets the Cloudflare badge.                                                                                  |
| `cloud.platform`       | `cloudflare.workers`, `aws_lambda`                | `cloudflare.workers` sets the Cloudflare badge; `aws_lambda` sets the Lambda badge.                                      |
| `cloud.region`         | `us-west-2`, `iad1`                               | Promoted to log chips (see Kubernetes section above).                                                                    |
| `process.runtime.name` | `nodejs`, `bun`, `deno`, `workerd`, `rust`, `jvm` | Runtime mark on the service map.                                                                                         |
| `faas.name`            | Lambda function name, Worker script name          | Any value sets the Lambda badge unless the service is on Cloudflare. Matches Cloudflare Worker scripts to their service. |
| `faas.version`         | Function version / revision                       | Shown as the script version on Cloudflare Workers.                                                                       |

A service with `k8s.pod.name` or `k8s.deployment.name` gets the Kubernetes badge. Cloudflare takes precedence over Lambda, and Lambda over Kubernetes.

`nodejs`, `bun`, `deno`, `workerd`, `rust`, `python` (or `cpython`), `ruby`, and the JVM
(`jvm`, `java`, or the OTel-canonical `OpenJDK Runtime Environment`) render as their logo next to
the service name. `go`, `dotnet`, `php`, and anything unrecognized render as a short text chip
instead, since their logos are wordmarks that don't survive being drawn at icon size. A runtime the
platform badge already implies (`workerd` on a Cloudflare service) is dropped rather than shown
twice.

Common aliases are folded together (`node`/`nodejs`, `go`/`golang`). Keep the value consistent across services on the same runtime anyway. An unlisted variant falls through to the text chip, and one fleet ends up wearing two different marks.

## Filter aliases

In Maple's WHERE-clause search bar (trace list, log search, dashboard widgets), you can type a short alias and it resolves to the canonical attribute:

| Alias                | Resolves to                                       |
| -------------------- | ------------------------------------------------- |
| `service`            | `service.name`                                    |
| `span`               | `span.name`                                       |
| `environment`, `env` | `deployment.environment`                          |
| `commit_sha`         | `vcs.ref.head.revision`                           |
| `root.only`          | `root_only` (synthetic boolean, root spans only)  |
| `errors_only`        | `has_error` (synthetic boolean, error spans only) |

So `env = "production"` and `deployment.environment = "production"` mean the same thing. Pick whichever is shorter.

## Reserved namespace

`maple_*` is reserved for Maple platform internals (org routing, ingest auth keys). Do not use this prefix for your own attributes. The UI hides anything starting with `maple_` from log attribute chips.

## Attributes Maple hides from log chips

These are stored on the row but skipped from the log attribute chips because they're noisy or already shown elsewhere (service column, etc.):

- `service.name`, `service.namespace`, `service.instance.id`, `service.version`
- `telemetry.sdk.*`
- `process.runtime.*`, `process.executable.*`
- `os.*`
- `host.arch`, `host.name`
- `maple_*`

The data is still queryable. You can filter or group by these in the search bar. They just don't appear in the row's attribute chips.

## Appendix: Attribute prominence scoring

Each log row shows every attribute that isn't hidden as a chip, ordered by score. Higher score comes first.

| Score | Attributes                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------- |
| 100   | `error`, `exception`, `exception.*` (anything)                                                      |
| 95    | `http.status_code`, `http.response.status_code`                                                     |
| 90    | `rpc.grpc.status_code`                                                                              |
| 80    | `http.method`, `http.request.method`                                                                |
| 70    | `db.system.name`, `db.system`, `db.query.text`, `db.statement`, `db.operation.name`, `db.operation` |
| 68    | `rpc.service`, `rpc.method`                                                                         |
| 66    | `user.id`, `enduser.id`, `customer.id`, `customer_id`                                               |
| 60    | `duration_ms`, `latency_ms`, `http.duration`                                                        |
| 55    | `http.url`, `http.route`, `url.path`                                                                |
| 40    | Other `http.*`, `url.*`                                                                             |
| 38    | Other `db.*`                                                                                        |
| 36    | Other `rpc.*`                                                                                       |
| 34    | `messaging.*`                                                                                       |
| 32    | Other `user.*`, `enduser.*`                                                                         |
| 25    | Anything with a dot (`namespace.key`)                                                               |
| 20    | Bare keys (no namespace)                                                                            |

Resource attributes appear in chips only if they're in the promoted set (`deployment.environment`, `deployment.environment.name`, `k8s.pod.name`, `k8s.namespace.name`, `cloud.region`). A promoted resource attribute scores 10 lower than the same key on the log itself.

## Metrics

Maple accepts OTLP metrics at `/v1/metrics`: sums (counters), gauges, histograms, and exponential histograms. Summary data points are not supported and are dropped at ingest.

For accurate RED (Rate, Error, Duration) metrics alongside sampled traces, use the OpenTelemetry Collector [SpanMetrics Connector](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetrics):

```yaml
connectors:
    spanmetrics:
        namespace: span.metrics

service:
    pipelines:
        traces:
            receivers: [otlp]
            exporters: [otlp/maple, spanmetrics]
        metrics:
            receivers: [spanmetrics]
            exporters: [otlp/maple]
```

This derives metrics from every span before sampling reduces the trace volume. See [Sampling & Throughput Estimation](/docs/concepts/sampling-throughput) for details.

## Data Retention

| Signal          | Retention |
| --------------- | --------- |
| Traces and logs | 30 days   |
| Metrics         | 90 days   |

## Environment Variable Reference

The recommended setup is to **inline the endpoint and ingest key directly in your bootstrap source**. The ingest key is write-only and scoped to your organization. Source-level configuration also removes deploy failures where OTel never starts because an env var wasn't set. The per-language guides show this shape.

If your existing setup uses the standard OpenTelemetry environment variables, those are also supported:

```bash
# Required
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"   # https://ingest.eu.maple.dev for EU orgs
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_SERVICE_NAME="my-service"

# Recommended
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/api,vcs.ref.head.revision=abc123"
```

These variables are supported by all official OpenTelemetry SDKs.
