# Span attribute reference

The main custom span attribute keys Maple emits, grouped by namespace. Use these exact spellings in every language: Title Case status, dotted-lowercase keys, and the documented camelCase exceptions in the tenant block. The list is not exhaustive (`maple.*` alone has well over a hundred keys), so grep for an existing key before inventing one.

Columns:
- **Key**: exact attribute name to emit
- **Type**: JSON type (`string`, `int`, `bool`)
- **Set at**: file that sets it (the canonical example)
- **Meaning**: one-line description

---

## `WarehouseQueryService.executeSql`: the canonical span

Every SQL execution against Tinybird or ClickHouse emits these. When you add an attribute to a query path, extend this block instead of inventing a parallel set.

Source: `packages/query-engine/src/execution/executor.ts` (`executeSql`), wired into `WarehouseQueryService` in `packages/backend/src/services/warehouse/WarehouseQueryService.ts`.

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `orgId` | string | `executor.ts` | Tenant org UUID (camelCase, historical; do not rename) |
| `tenant.userId` | string | `executor.ts` | User ID within the tenant |
| `tenant.authMode` | string | `executor.ts` | `"api_key"` / `"user_login"` / etc. |
| `clientSource` | string | `executor.ts` | `"org_override"` or `"managed"` (which config resolved) |
| `db.client` | string | `executor.ts` | `"clickhouse"` or `"tinybird-sdk"` |
| `db.system.name` | string | `executor.ts` | `"clickhouse"` or `"tinybird"` (legacy spans: `db.system`) |
| `peer.service` | string | `executor.ts` | `"tinybird"`, `"clickhouse"`, or `"chdb"` (from `BackendDialect` in `backend.ts`) |
| `db.namespace` | string | `backend.ts` (`warehouseTargetAttributes`) | ClickHouse database name; omitted when empty |
| `server.address` | string | `backend.ts` (`warehouseTargetAttributes`) | Warehouse host; omitted when empty |
| `db.query.text` | string | `executor.ts` | Full compiled SQL, truncated to 16 KB (legacy spans: `db.statement`) |
| `db.query.length` | int | `executor.ts` | Pre-truncation length (legacy: `db.statement.length`) |
| `db.query.truncated` | bool | `executor.ts` | Whether SQL was capped at 16 KB (legacy: `db.statement.truncated`) |
| `db.query.fingerprint` | string | `executor.ts` | 32-bit FNV-1a hash with literals and numbers normalized (legacy: `db.statement.fingerprint`) |
| `db.duration_ms` | int | `executor.ts` | Warehouse execution time in ms (success and error paths) |
| `db.total_duration_ms` | int | `executor.ts` | Whole span duration, including config resolution and client setup |
| `db.retry.attempts` | int | `executor.ts` | Retries actually performed (not total attempts) |
| `query.pipe` | string | `executor.ts` | Pipe name passed to the executor |
| `query.context` | string | `executor.ts` | Semantic call-site label (e.g. `"errorsByType"`, `"spanHierarchy"`). Set via `SqlQueryOptions.context`; falls back to the pipe name. |
| `query.profile` | string | `executor.ts` | Execution profile (e.g. `"list"`, `"analytics"`). Set via `SqlQueryOptions.profile`; only emitted when set. |
| `query.routing` | string | `executor.ts` | Legacy `"ingest"` marker, dual-emitted with `warehouse.route` |
| `ch.settings` | string (JSON) | `executor.ts` | JSON-encoded ClickHouse settings applied to the query |
| `result.rowCount` | int | `executor.ts` | Number of rows returned |
| `db.response.returned_rows` | int | `executor.ts` | OTel spelling of `result.rowCount`, success only |
| `db.operation.name` | string | `executor.ts` | Leading SQL verb (`SELECT`, `INSERT`) from `summarizeSql` |
| `db.collection.name` | string | `executor.ts` | First table named by the statement |
| `db.query.summary` | string | `executor.ts` | `{operation} {collection}`, identical to what the shape rollup derives when absent |
| `error.type` | string | `errors.ts` (`warehouseFailureAttributes`) | Failure only: ClickHouse exception type (`UNKNOWN_TABLE`), else its code, else the error tag |
| `db.response.status_code` | string | `errors.ts` (`warehouseFailureAttributes`) | Failure only: the ClickHouse error code, else the upstream HTTP status |

`executeSql` is the one `Client` span per logical warehouse operation, retries included, as the OTel database conventions ask. The `Client` kind is load-bearing: the service-map DB-edge MV only counts `Client`/`Producer` spans. The drivers run on `warehouseHttpClient(...)` (`packages/query-engine/src/execution/driver-http.ts`), which disables the Effect `HttpClient` tracer for their round-trips. Do not let an `http.client POST` span reappear under it.

The sibling `WarehouseQueryService.ingest` span (same file) sets `datasource`, `orgId`, `rowCount`, `db.operation.name = "INSERT"`, `db.collection.name`, `db.query.summary`, and `db.operation.batch.size`.

## `warehouse.*` group

Routing metadata emitted by the shared executor for API and local-CLI queries.

| Key | Type | Meaning |
|---|---|---|
| `warehouse.backend` | string | Concrete backend kind: `tinybird`, `tinybird-gateway`, `clickhouse`, or `chdb` |
| `warehouse.route` | string | Route purpose: `read`, `raw`, or `ingest` |
| `warehouse.config_source` | string | Config source: `managed`, `org-byo`, or `org-jwt` |

The historical `clientSource` and `db.client` attributes remain on the same span. `clientSource` maps `org-byo` to `org_override` and every other source to `managed`. `db.client` records the driver family (`tinybird-sdk` or `clickhouse`).

**Rule:** When adding a query, always pass a `context` string in `SqlQueryOptions`. It becomes filterable as `query.context` in trace search. Don't invent new keys when a `query.*` key fits.

---

## `db.*` group (general)

Beyond `executeSql`, the same `db.system.name` / `db.duration_ms` keys appear wherever Maple talks to a warehouse. Put new DB-related attributes under `db.*`, never under `database.*` or `clickhouse.*`.

---

## `query.*` group (DSL query metadata)

Used by `packages/query-engine/src/runtime/query-engine.ts` for the higher-level DSL surface (not raw SQL).

| Key | Type | Meaning |
|---|---|---|
| `query.pipe` | string | Pipe / DSL function name |
| `query.context` | string | Semantic call-site label |
| `query.profile` | string | Execution profile (`"list"`, `"analytics"`, etc.) |
| `query.kind` | string | `"timeseries"` / `"breakdown"` / `"list"` |
| `query.metric` | string | Metric being queried (e.g. `"count"`, `"error_rate"`) |
| `query.source` | string | `"traces"` / `"logs"` / `"metrics"` |
| `query.reducer` | string | Aggregation function (e.g. `"sum"`, `"avg"`) |
| `query.bucketSeconds` | int | Bucket size for timeseries queries |
| `query.filter.serviceName` | string | Filter value for serviceName |
| `query.filter.spanName` | string | Filter value for spanName |
| `query.filter.metricName` | string | Filter value for metricName |

---

## `result.*` group

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `result.rowCount` | int | `executor.ts` | Rows returned by a query |
| `result.groupCount` | int | `query-engine.ts` | Distinct groups in a breakdown |
| `result.renderedSpanCount` | int | `apps/ai/src/mcp/tools/inspect-trace.ts` | Spans retained after trace-overview rendering limits |

---

## `tenant.*` group

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `tenant.userId` | string | `executor.ts` | User ID within the tenant |
| `tenant.authMode` | string | `executor.ts` | Authentication mode |

**Naming inconsistency to preserve:** `orgId` is camelCase, `tenant.userId` is dotted. `orgId` predates the `tenant.*` namespace, and renaming it would break existing trace search filters and dashboard queries. Do not unify them.

---

## `cache.*` group

Emitted by the bucket cache and the query-engine cache wrappers. Use them to debug hit ratios and segment behavior.

Source: `packages/query-engine/src/caching/bucket-cache.ts`, `packages/backend/src/services/warehouse/QueryEngineService.ts`

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `cache.fingerprint` | string | `bucket-cache.ts` | First 12 chars of the cache key fingerprint |
| `cache.bucketSeconds` | int | `bucket-cache.ts` | Bucket size for this cache request |
| `cache.rangeMs` | int | `bucket-cache.ts` | Request time range in ms |
| `cache.requestedBuckets` | int | `bucket-cache.ts` | Buckets the request covers |
| `cache.bucketsHit` | int | `bucket-cache.ts`, `QueryEngineService.ts` | Buckets served from cache |
| `cache.bucketsMissed` | int | `bucket-cache.ts`, `QueryEngineService.ts` | Buckets that had to be queried |
| `cache.missingRangeCount` | int | `bucket-cache.ts`, `QueryEngineService.ts` | Count of contiguous missing time ranges |
| `cache.warehouse_query_count` | int | `bucket-cache.ts` | Warehouse queries issued to fill misses |
| `cache.segments_hit` / `_missed` / `_timed_out` / `_skipped` / `_errored` | int | `bucket-cache.ts` | Per-segment outcomes |
| `cache.hit` | bool | `QueryEngineService.ts` | Cache hit or miss |
| `cache.ttlSeconds` | int | `QueryEngineService.ts` | TTL of the cached entry |
| `cache.path` | string | `QueryEngineService.ts` | `"blob"` or `"bucket"` |

---

## `email.*` group

Emitted by `EmailService` for outbound transactional email.

Source: `packages/backend/src/platform/EmailService.ts`

| Key | Type | Meaning |
|---|---|---|
| `email.subject` | string | Subject line |
| `email.provider` | string | `"cloudflare"` (Cloudflare Email Service Workers binding) |
| `email.message_id` | string | Provider message id returned after a successful send |

---

## `maple.*` vendor namespace

`maple.*` is reserved for Maple-specific metadata with no OTel semconv equivalent. Entity ids follow `maple.<entity>.id` (`maple.dashboard.id`, `maple.alert.rule_id`, `maple.investigation.id`, `maple.share.id`). Other live sub-namespaces include `maple.query.*`, `maple.chat.*`, `maple.pr_review.*`, `maple.mcp.*`, `maple.session.*`, and `maple.webhook.*`.

### API entity attributes

| Key | Type | Set at | Meaning |
|---|---|---|---|
| `maple.api_key.id` | string | `ApiKeysService.ts` | API key entity involved in an operation |
| `maple.api_key.last_used_memo_hit` | bool | `ApiKeysService.ts` | Whether a last-used write was skipped by the per-isolate memo |
| `maple.dashboard.id` | string | `DashboardPersistenceService.ts` | Dashboard entity involved in an operation |
| `maple.dashboard.version_id` | string | `DashboardPersistenceService.ts` | Dashboard history version involved in an operation |
| `maple.ingest_attribute_mapping.id` | string | `IngestAttributeMappingService.ts` | Ingest attribute mapping involved in an operation |
| `maple.organization.member.requested_count` | int | `OrgMembersService.ts` | Number of member ids requested for resolution |

These services live under `packages/backend/src/services/`.

### Ingest gateway

Custom attributes on the Rust ingest gateway's spans. Sources: `apps/ingest/src/main.rs` (`handle_signal` inbound span, `handle_cloudflare_logpush` inbound span) and `apps/ingest/src/otel.rs` (`forward_client_span`, `export_client_span`, `grpc_server_span`).

#### `maple.signal`
- **Type:** string (`"traces"`, `"logs"`, `"metrics"`)
- **Meaning:** Which OTel signal the request carries.

#### `maple.org_id`
- **Type:** string
- **Meaning:** Organization ID resolved from the ingest key.
- **Note:** Rust uses `maple.org_id` (vendor-namespaced). TypeScript uses `orgId` (camelCase, no namespace). Both are intentional; keep both.

#### `maple.ingest.*` sub-namespace

| Key | Type | Meaning |
|---|---|---|
| `maple.ingest.key_type` | string | `"public"` / `"private"` / `"connector"` / `"sentinel"` |
| `maple.ingest.self_managed` | bool | Org has a connected BYO ClickHouse (`org_clickhouse_settings.sync_status = 'connected'`) |
| `maple.ingest.destination` | string | Export destination: `"tinybird"` or `"clickhouse"` |
| `maple.ingest.payload_format` | string | `"json"` / `"protobuf"` |
| `maple.ingest.content_encoding` | string | Request `Content-Encoding`, or `"identity"` when absent |
| `maple.ingest.decoded_bytes` | int | Size after decompression |
| `maple.ingest.item_count` | int | Spans / logs / metrics in the payload |
| `maple.ingest.reject_reason` | string | Why a request or stage was rejected (always recorded, even when status stays `Ok`) |
| `maple.ingest.upstream_pool` | string | Downstream collector pool; always `"shared"` today |
| `maple.ingest.sampling_ratio` | float | Per-org trace sample ratio applied at ingest |

#### `maple.cloudflare.*` sub-namespace

| Key | Type | Meaning |
|---|---|---|
| `maple.cloudflare.connector_id` | string | Cloudflare Logpush connector UUID |
| `maple.cloudflare.dataset` | string | `"http_requests"` (only value today) |
| `maple.cloudflare.is_validation` | bool | Whether this is a Cloudflare validation ping |

---

## HTTP semconv (ingest gateway)

The Rust ingest gateway emits the stable OTel HTTP semconv keys on its Server-kind and Client-kind spans. Use these exact keys. Do not write `http.method` (legacy) or `http.url` in new code.

| Key | Direction | Meaning |
|---|---|---|
| `http.request.method` | both | Always `"POST"` for ingest |
| `http.route` | server | Logical route (`"/v1/traces"`, `"/v1/logpush/cloudflare/http_requests/{connector_id}"`) |
| `http.request.body.size` | both | Request body size in bytes |
| `http.response.status_code` | both | Final HTTP status code |
| `error.type` | both | Error category: `"auth"`, `"billing"`, `"throttle"`, `"payload_too_large"`, `"decode"`, `"enrich"`, etc. |
| `url.full` | client | Full downstream collector URL |
| `server.address` | client | Downstream collector host |

In a Rust `tracing` macro, field names that contain dots must be quoted: `"http.request.method" = "POST"`. The gateway also uses the reserved `otel.name`, `otel.kind`, `otel.status_code`, and `otel.status_description` fields. See `rules/status-and-kind.md`.

---

## Misc attributes (call-site-specific)

These appear on individual spans but do not form a reusable namespace. They are listed so you don't invent parallel keys.

| Key | Type | Where | Meaning |
|---|---|---|---|
| `datasource` | string | `executor.ts` (`ingest`) | Datasource being ingested into |
| `rowCount` | int | `executor.ts` (`ingest`) | Rows in the ingest payload |
| `pipe` | string | `executor.ts` (`query`) | Pipe name on the legacy `query()` method |
| `attributeKey` | string | attribute-explore routes | Attribute key being browsed |
| `service` | string | many routes | Service name from query params (not `service.name`, which is a resource attribute) |
| `spanId` | string | trace detail | Span being inspected |
| `traceId` | string | trace detail | Trace being inspected |
| `userId` | string | various | User ID context |
| `limit` | int | listing routes | Result limit |
| `rootOnly` | bool | trace queries | Filter to root spans only |
| `incidentCount`, `issueCount`, `errorCount`, `serviceCount`, `orgCount`, `eventCount`, `sentCount`, `totalRequests`, `totalErrors`, `resultCount` | int | various | Result-shape counters on enclosing routes |

**Rule:** Extend an existing namespace (`query.*`, `result.*`, `cache.*`, `maple.*`) instead of adding a new bare key. Bare keys make trace search harder.
