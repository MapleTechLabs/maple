# Database query observability

Maple treats database calls as first-class using the standard
[OpenTelemetry database semantic conventions](https://opentelemetry.io/docs/specs/semconv/db/database-spans/).
If your services use an OTel-aware database client (most SDKs enable one
automatically), you get the following with **no extra configuration**:

- **Query timing inline in every trace.** A database call's client span shows up
  in the waterfall like any other span. Its detail panel renders a database
  summary block (system, namespace, table, operation, rows returned, batch size,
  server, error outcome) derived from the `db.*` attributes
  (`packages/ui/src/lib/cloud-platforms/database.ts`).
- **Query shapes per database.** Selecting a database node on the service map
  opens a detail panel with "Query Activity" and "Top Query Shapes". Every
  distinct query _shape_ (the query with literals normalized to `?`) is
  aggregated across the calling services with call volume, error rate, and
  p50/p95 latency, plus a sample statement. The shapes come from the
  `service_map_db_query_shapes_hourly` rollup, with the in-progress hour read
  from raw traces.

This works for **any** database (PostgreSQL, MySQL, ClickHouse, Redis, MongoDB,
and more) because it reads only the vendor-neutral semantic conventions.

## Attributes Maple reads

| Attribute                                                  | Used for                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `db.system.name` (legacy `db.system`)                      | Identifies the database; drives the summary block and per-system grouping. |
| `db.query.text` (legacy `db.statement`)                    | The query; normalized into a low-cardinality **shape** for grouping.       |
| `db.query.summary`                                         | Preferred human label for a query shape (e.g. `SELECT users`).             |
| `db.operation.name`, `db.collection.name`, `db.namespace`  | Compose a label when `db.query.summary` is absent.                         |
| `db.query.fingerprint` (legacy `db.statement.fingerprint`) | Explicit grouping key when the instrumentation provides one.               |
| `db.response.returned_rows`                                | Rows returned, shown in the span summary.                                  |
| `db.operation.batch.size`                                  | Batch size (only present for batches).                                     |
| `server.address` / `server.port`                           | The database endpoint.                                                     |
| `error.type`, `db.response.status_code`                    | Failure outcome.                                                           |

Query text is grouped by _shape_: literals are stripped to `?` and `IN (...)`
lists are collapsed, so `WHERE id = 1` and `WHERE id = 2` are the same shape.
The shared SQL lives in `packages/domain/src/tinybird/db-query-shape-sql.ts`.
Prefer emitting parameterized `db.query.text` (the OTel spec says parameterized
text should **not** be sanitized) so shapes stay clean.

## Correlating server-side query logs with traces (SQLCommenter)

The client span captures the query _as the caller sees it_: duration and query
text. It cannot see server-side detail such as memory used or rows/bytes
scanned. **SQLCommenter** is the OpenTelemetry-standard way to bridge that gap.
It propagates trace context into the database by appending a comment to the
query:

```sql
SELECT * FROM events WHERE ts > ? /*traceparent='00-<trace_id>-<span_id>-01'*/
```

Most OTel database instrumentations can inject this comment (it is opt-in; see
your SDK's SQLCommenter or "DB statement comment" option). The database then
records the full query text, comment included, in its query log, so a reader of
that log can match each server-side query to the client span that issued it.

Maple does not read database query logs today. An earlier SQLCommenter parser in
`@maple/domain` was removed in the repo restructure (#328) because nothing used it.

> Note: SQLCommenter comments can defeat statement caching for MySQL prepared
> statements, Oracle, and SQL Server. Consult the OTel guidance before enabling
> it broadly on those engines.

## Resource allocation (not built)

Server-side **resource allocation** (peak memory, rows/bytes read, CPU time,
ProfileEvents) is not available from client spans. The original plan was a
ClickHouse integration that polls `system.query_log`, forwards each sampled
query as a span nested under the app's trace via the SQLCommenter `traceparent`,
and emits aggregate metrics. That poller does not exist yet.
