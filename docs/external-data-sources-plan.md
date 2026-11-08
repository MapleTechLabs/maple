# External data sources: plan

Status: **phase 1 in progress, 2026-11-08.** Core (storage, catalog, search, driver port, service) built on `feat/data-sources-core`.

## Goal

An org connects a system it already runs and uses it everywhere Maple uses data: dashboard
widgets, alert rules, the MCP tools and agents. **The data is never imported.** Maple stores only
the connection, runs the author's query against the source at read time, and renders or
evaluates the result.

Two kinds of source ship first, on purpose one of each shape: **ClickHouse** (SQL) and
**Clerk** (an HTTP API with no SQL). Building both at once keeps the port, the storage format,
the agent tools and the evals honest: nothing can quietly assume "a query is a SQL string".
PostgreSQL and MySQL follow; Stripe, GitHub, Linear and other API sources reuse the Clerk path.

Non-goals for v1:

- Ingesting, copying, syncing or caching the source's data beyond a short result cache.
- The visual query builder (traces/logs/metrics `QuerySpec`) over an external source. The
  builder assumes Maple's schema; external sources are queried in their own SQL dialect or,
  for API sources, with a resource query (below).
- Joining Maple telemetry with external data in one query, or formulas across a Maple query
  and an external one. (Possible later, see phase 6.)
- Writes of any kind to the source.

## Naming

`sources` (`packages/db/src/tables/sources.ts`) already means "something that sends telemetry
to Maple", and "BYO ClickHouse" (`org_clickhouse_settings`) already means "Maple's own warehouse
schema living in your cluster". Both stay as they are. The new concept is:

- **Data source** in the UI (Settings → Data sources), the term Grafana users expect.
- `external_data_sources` table, `ExternalDataSourceId` brand (`eds_...`), "external data
  source" in code, so it never collides with ingest `Source`.

BYO ClickHouse and an external ClickHouse data source are different things: BYO requires
Maple's schema applied and replaces the managed warehouse for every built-in page; an external
source has an arbitrary schema and is read only through the author's SQL. One cluster can be
both, as two separate configurations.

## What exists to build on

The raw-SQL path already gives most of the product surface for free, against Maple's warehouse:

| Piece                                                          | Where                                                                                                              | Reuse                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| v3 widget data sources (`query`, `raw_sql`, `route`, `static`) | `packages/widgets/src/dashboard/v3/data-source.ts`                                                                 | add an `external` kind                            |
| Display shapes (line, bar, table, stat, pie, heatmap, ...)     | `packages/widgets/src/raw-sql-display.ts`, `packages/query-engine/src/raw-sql-chart-rows.ts`                       | as is: every source returns a table               |
| Widget execution                                               | `DashboardWidgetDataService` (`path._tag === "RawSql"` is the model)                                               | new `External` path                               |
| Static validation + macros                                     | `packages/domain/src/raw-sql.ts` (`rawSqlIssue`), `packages/query-engine/src/runtime/raw-sql.ts` (`prepareRawSql`) | generalize per dialect                            |
| Raw-SQL alert rules                                            | `signalType: "raw_query"` in `AlertRuleModel.ts` / `AlertsService.ts`, reducers, group caps                        | model for `external_query`                        |
| Encrypted credentials + URL egress checks                      | `OrgClickHouseSettingsService` (`encryptAes256Gcm`, `validateExternalUrl` from `@maple/safe-fetch`)                | same helpers                                      |
| ClickHouse HTTP client                                         | `lib/effect-clickhouse-http`                                                                                       | CH driver                                         |
| MCP SQL tool                                                   | `apps/ai/src/mcp/tools/run-sql.ts`                                                                                 | stays Maple-only; pattern for `query_data_source` |

So the core of the work is: a connection store, a driver per source kind behind one port, two
query forms (SQL and resource queries) that both return a table, and an `external` widget and
alert target. `raw_sql` and `raw_query` stay Maple-warehouse-only, so their `$__orgFilter`
rules are untouched.

## Architecture

### Connection store

`packages/db/src/tables/external-data-sources.ts`:

```text
id                    ExternalDataSourceId (pk)
org_id                OrgId (tenant column)
name                  text, unique per org
kind                  "clickhouse" | "clerk" | "postgres" | "mysql"   (literal union, grows)
config                jsonb, schema per kind (host, port, database, user, tls mode; Clerk: instance label, environment)
secret_ciphertext/iv/tag   encrypted password, DSN secret or API key, never returned by any API
status                "unknown" | "ok" | "error"
last_checked_at, last_error
created_at/by, updated_at/by
```

`config` is a `Schema.TaggedUnion` on `kind` so each driver owns its config shape. Secrets use
the same AES-256-GCM helpers and key as BYO ClickHouse, with the AAD bound to the org and the
source id, so a ciphertext copied onto another row no longer decrypts.

### Driver port

New package `packages/data-sources` (Maple-aware: it knows the macros and result shapes):

```ts
// What a widget, alert or tool stores and sends. Tagged so a new form is a new arm, not a flag.
type ExternalQuery =
	| { _tag: "sql"; sql: string }
	| {
			_tag: "resource"
			resource: string
			measure?: Measure
			filters?: Filter[]
			groupBy?: GroupBy
			select?: string[]
			orderBy?: OrderBy
			limit?: number
	  }

interface DataSourceDriver<Config> {
	readonly kind: DataSourceKind
	// "sql:clickhouse" | "sql:postgres" | "sql:mysql" | "resource". Drives the editor, the
	// validator, the agent docs and which ExternalQuery arm the source accepts.
	readonly queryLanguage: QueryLanguage
	readonly configSchema: Schema.Schema<Config>
	readonly test: (conn: Connection<Config>) => Effect<TestResult, DataSourceError>
	// SQL sources introspect; API sources return a catalog declared in the driver's code.
	readonly catalog: (conn) => Effect<SourceCatalog, DataSourceError>
	// Dry run: what would execute (expanded SQL, or the list of API calls and scanned rows).
	readonly plan: (
		conn,
		query: ExternalQuery,
		window: TimeWindow,
		limits: QueryLimits,
	) => Effect<QueryPlan, DataSourceError>
	readonly execute: (
		conn,
		plan: QueryPlan,
	) => Effect<
		{ columns: ReadonlyArray<ColumnMeta>; rows: ReadonlyArray<Record<string, unknown>> },
		DataSourceError
	>
}
```

Every driver returns the same **table** (columns + rows), whatever it speaks. That is what lets
one display pipeline, one set of shape contracts, one alert evaluator and one agent tool serve
every kind. `plan` is separate from `execute` so the editor, the agents and the budget checks
can see the cost of a query (rows scanned, API calls) before anything runs.

A registry keyed by `kind` resolves the driver. A new SQL engine (BigQuery, Snowflake) is a
driver plus a dialect; a new API (Stripe, GitHub, Linear) is a driver plus a declared resource
catalog; a new query language (PromQL) is a new `ExternalQuery` arm.

`ExternalDataSourceQueryService` in `packages/backend/src/services/data-sources/` owns load +
decrypt + driver dispatch + limits + result cache + spans. It is deliberately **not**
`WarehouseQueryService`: the CLAUDE.md rule "all queries use the CH DSL" governs Maple's
warehouse; external sources are user-authored queries by definition. Document that exception.

### Drivers and transport (all run on Workers)

- **ClickHouse:** HTTP interface through `lib/effect-clickhouse-http`, URL checked with
  `validateExternalUrl` (DNS pinning, no private ranges). Every query sends
  `readonly=1`, `max_execution_time`, `max_result_rows`/`result_overflow_mode=break`,
  `max_result_bytes`, `max_memory_usage`.
- **PostgreSQL:** TCP via `cloudflare:sockets` with a Workers-compatible client (postgres.js),
  TLS required by default. One connection per invocation, closed in the scope finalizer, same
  rule as `withPgConnectionScope`. Each query runs as
  `BEGIN READ ONLY; SET LOCAL statement_timeout = ...; SET LOCAL idle_in_transaction_session_timeout = ...; <query>; ROLLBACK`.
  Host resolved and checked against private ranges before connecting.
- **MySQL:** same socket model with a Workers-compatible client,
  `START TRANSACTION READ ONLY` + `MAX_EXECUTION_TIME` hint/session var.

Hyperdrive is not usable here: its configs are static bindings, not per-tenant at runtime.

### Query language and macros

Queries are written in the source's own dialect. The macro set matches today's raw SQL so the
editor and docs stay one concept, with expansion per dialect:

| Macro                               | ClickHouse                                  | PostgreSQL                                         | MySQL                                           |
| ----------------------------------- | ------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| `$__timeFilter(col)`                | `col >= toDateTime(...) AND col < ...`      | `col >= timestamptz '...' AND col < ...`           | `col >= TIMESTAMP '...' AND ...`                |
| `$__timeGroup(col)`                 | `toStartOfInterval(col, INTERVAL n SECOND)` | `to_timestamp(floor(extract(epoch from col)/n)*n)` | `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(col)/n)*n)` |
| `$__interval_s`, `$__from`, `$__to` | literals                                    | literals                                           | literals                                        |
| dashboard variables                 | escaped literals per dialect                | same                                               | same                                            |

`$__orgFilter` does **not** apply: the data is the org's own, and isolation comes from the
org's credentials. Static validation splits into a shared part (single statement, length cap,
must be a read) and a dialect part (ClickHouse keeps the table-function deny list, since
`url()`/`s3()`/`remote()` from inside a customer VPC is still an SSRF primitive; Postgres
refuses `COPY`, `dblink`, `pg_read_file`, `lo_*`, `SET` outside our own). The read-only
transaction / `readonly=1` is the real boundary; the text checks give early, readable errors.

Docs and the connect form tell users to create a **read-only role**, and the connection test
reports when the role can write (CH: `SELECT * FROM system.grants`; PG: `has_table_privilege`
over a sample) as a warning.

### Resource queries (API sources)

An API has no query language, and exposing raw endpoints to authors and models would make every
widget a hand-built pagination loop. Instead each API driver declares a small **resource
catalog**, and queries are structured:

```jsonc
// "Signups per day"
{ "_tag": "resource", "resource": "users", "measure": { "fn": "count" },
  "groupBy": { "time": "created_at" } }

// "Users who signed in this week, newest first"
{ "_tag": "resource", "resource": "users",
  "filters": [{ "field": "last_sign_in_at", "op": "within_window" }],
  "select": ["id", "created_at", "last_sign_in_at"], "orderBy": { "field": "last_sign_in_at", "dir": "desc" }, "limit": 100 }
```

- `measure`: `count`, `count_distinct(field)`, `sum`/`avg`/`min`/`max(field)` where the field is
  numeric. No measure means list mode.
- `groupBy`: a time field (bucketed by the dashboard's interval, like `$__timeGroup`) and/or
  up to one categorical field.
- `filters`: `eq`, `in`, `contains`, `gt`/`lt`, `within_window` (bind to the dashboard or alert
  time window). Dashboard variables bind into filter values.
- The window binds to the resource's declared default time field when no filter names one.

Each resource declares per field: type, whether it can be filtered **server side** (pushed into
the API call), sorted, grouped or measured, PII, and a note. The driver's planner then picks
the cheapest plan and reports it from `plan`:

1. **Count pushdown:** the API returns a total for a filtered list (`limit=1`, read
   `total_count`). A per-day count over 30 days is 30 small calls, no rows fetched.
2. **Scan:** page through rows the API filtered and sorted as far as it can, then filter,
   group and aggregate in the Worker. Bounded by a scan budget (e.g. 10,000 rows and 50 calls).
3. **Refuse:** past the budget, the query fails before any call, with a fix ("this would read
   ~240k users; group by week, narrow the window, or filter by organization").

Results come back as the same table as SQL, so charts, alerts and shape contracts do not care.

### Clerk driver

Facts checked against Clerk's docs on 2026-11-08 (the raw Backend API reference page returned
404; these come from the Backend SDK pages and the rate-limit page, and must be re-checked
against Clerk's OpenAPI spec in phase 1):

- `GET /v1/users`: `limit` up to 500, `offset`, `order_by` (`created_at`, `updated_at`,
  `last_active_at`, `last_sign_in_at`, names, email, ...), range filters in epoch ms on
  `created_at`, `last_active_at` and `last_sign_in_at`, value filters (`email_address`,
  `external_id`, `organization_id`, `user_id`, `username`, up to 100 each) and `query`. The
  response carries a total count, so count pushdown works.
- Rate limit: **per Clerk instance, shared with the customer's own backend**: 1000 requests
  per 10 s in production, 100 in development. A 429 blocks further calls until `Retry-After`.
- No read-only or scoped secret keys were found. A Clerk secret key can write.

Design consequences:

- **Resources v1:** `users` (verified above), then `organizations`, `organization_memberships`
  and `invitations` once their filters and totals are confirmed. Unconfirmed resources ship
  in scan mode only, or not at all.
- **Read-only by construction:** the key is full access, so the driver is an allow list of
  `GET` paths with typed parameters, built on `HttpClient`, never a generic proxy. The connect
  form says plainly that the key can write and that Maple only reads.
- **Rate budget:** Maple must never cause a 429 in the customer's app. A per-source
  Cloudflare rate-limit binding (keyed by source id, shared by every worker that queries) caps
  Maple at a small share of the instance limit (default 5%, so 50 per 10 s in production and 5 in
  development), honours `Retry-After`, and makes the planner fail fast instead of queueing
  past a widget's timeout. The result cache matters more here than for SQL.
- **Alerts:** minimum interval 5 minutes on API sources.
- **Semantics trap, recorded in the catalog notes:** `last_active_at` is the latest activity
  only. "Users active in the window" is answerable; "daily active users for the last 30 days"
  is not, because past days are overwritten. The planner refuses a time-grouped count on
  `last_active_at` with that explanation, so neither a person nor a model draws a DAU chart that
  silently undercounts history.
- **PII:** email, phone and names are marked PII. Agents get counts and ids by default; PII
  fields need the source's "agents may read PII" switch. Public dashboard shares never return
  PII fields.
- **Dogfooding:** Maple runs on Clerk, so its own development instance is the first real source
  for local verification and previews (inside the 5-per-10-s development share).

### Limits, caching, failure semantics

- Reuse the raw-SQL caps (1,000 rows, 5 MB, cell length). Timeouts: 15 s dashboard, alert
  timeout from the rule interval as today.
- Per-source concurrency cap (e.g. 4 in flight per source per isolate, plus a per-source rate
  limit) so a busy dashboard cannot overload a customer's production database. Dashboard
  refresh fan-out is the main risk, so this ships in phase 2, not later.
- Short result cache keyed by `(sourceId, config version, expanded SQL, aligned window)` via
  `EdgeCacheService`, TTL tied to the window size. Editing a source bumps its config version.
- Typed errors (`Schema.TaggedError`, namespaced): `@maple/DataSourceNotFound`,
  `@maple/DataSourceConnectionError` (DNS, TLS, refused, auth), `@maple/DataSourceQueryError`
  (source rejected the SQL, message passed through), `@maple/DataSourceTimeout`,
  `@maple/DataSourceLimitExceeded`, `@maple/DataSourceValidationError`. Widgets show the
  source's error text; alerts map connection errors to the existing evaluation-error state,
  never to "resolved".

### Security and access

- Create/edit/delete/test: org admins. Query: any member through dashboards/alerts/MCP.
- Secrets never leave the backend; `GET` returns `hasPassword: true`.
- Public dashboard shares: a widget on an external source executes with the org's credentials
  on behalf of an anonymous viewer. v1 renders these widgets on shares only when the source has
  "allow on public shares" switched on (default off).
- Audit log entries for create, update, delete, test, and secret rotation.
- Spans: `maple.data_source.id`, `maple.data_source.kind`, `db.system`, row count, duration;
  never the expanded SQL's literal values on hot paths.

## Agents first: how models find, query and build on sources

Models (the MCP server, in-app chat, investigations) are a primary consumer, not a late add-on.
An org can have 18+ sources, some with hundreds of tables, in several SQL dialects plus APIs
that speak no SQL at all. A model must pick the right source and table, use the right query
form, and save a widget or alert that actually renders, without the whole catalog in its
context. The agent surface is therefore designed in phase 1 and every later phase is gated on
an agent eval, not only on UI checks.

### Failure modes we design against

1. **Wrong source.** `orders` exists in `shop-prod` (Postgres), `shop-staging` (Postgres) and
   `analytics` (ClickHouse). The model picks by table name and reads staging.
2. **Wrong language.** ClickHouse functions sent to Postgres, Postgres `date_trunc` sent to
   ClickHouse, or SQL sent to Clerk (`SELECT count(*) FROM users`).
3. **Guessed schema.** Column or field names invented (`created_at` when the column is
   `inserted`), timestamps stored as epoch ints, a Clerk filter the API cannot push down.
4. **Catalog flood.** A `describe` that returns 400 tables x 30 columns eats the context and
   buries the table that mattered.
5. **Saved but broken.** A widget saved with a query that errors, returns no time column for a
   line chart, or returns 50k rows. The model reports success; the user sees a broken tile.
6. **Plausible but wrong numbers.** A "DAU over 30 days" chart from Clerk's `last_active_at`,
   which only holds each user's latest activity.
7. **Name collision with Maple concepts.** The `list_sources` MCP tool already means ingest
   sources, and Maple itself signs in with Clerk. A model asked for "my data sources" or "our
   Clerk users" reaches for the wrong tool.

### 1. Metadata that carries meaning, stored in Postgres

Each source carries fields written for a model as much as for a human:

- `name`: short unique slug (`shop-prod`, `clerk-prod`), what tools take and what models write.
- `description`: one or two sentences: what lives here and what it is for ("Production
  Postgres for the storefront: orders, customers, payments. Source of truth for revenue.").
  The connect form asks for it and offers an AI-drafted one from the catalog.
- `environment` (`production` | `staging` | `development` | `other`) and free `tags`.
- `agentAccess`: `enabled` | `disabled`, plus `agentPii` for API sources with PII fields.
  Disabled sources are invisible to every agent tool.

**Catalog snapshot.** One catalog shape for every kind: entries are tables (SQL) or resources
(API), each with fields, types, a primary time field, notes and capabilities. SQL catalogs are
introspected on connect, refreshed daily and on demand; API catalogs come from the driver's
code, with notes the admin can add. Both are stored in Postgres
(`external_data_source_catalog`: source, entry, row estimate, time field, fields with type,
note, capabilities and a few sample values for low-cardinality text). Nothing is introspected
live during an agent turn. Admins can curate:

- **Exposed entries:** an allow list (default: all, but sources over ~200 tables prompt the
  admin to pick). Unexposed entries are hidden from search and describe, but not from
  execution.
- **Notes** on entries and fields ("amount is in cents", "status: paid, refunded, failed"),
  seeded from DB comments or the driver.
- **Primary time field** per entry, auto-detected, overridable. Macros and resource windows
  use it.
- **Example queries:** a few saved, verified queries per source, SQL or resource. They teach a
  model the conventions faster than any schema dump.

The same catalog powers the editor's autocomplete and the schema browser, so curation done
for humans also helps models, and the other way round.

### 2. Progressive disclosure tools

Four tools, each sized so the answer fits regardless of how many sources exist:

| Tool                                                          | Returns                                                                                                                                                                                                | Size bound                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `list_data_sources`                                           | per source: name, kind, query language, environment, description, entry count, status                                                                                                                  | one line each; paginated past 50        |
| `search_data_sources(query)`                                  | ranked `(source, entry, matching fields, why it matched)` across all catalogs: names, notes, sample values                                                                                             | top 10 hits                             |
| `describe_data_source(source, entries?)`                      | without `entries`: entry names + row estimates + notes. With `entries` (max 5): fields, types, time field, capabilities, notes, example queries, plus the cheat sheet for this source's query language | capped like `describe_warehouse_tables` |
| `query_data_source(data_source, sql? \| resource?, explain?)` | the table (columns, rows), the query language, and with `explain` the plan only: expanded SQL or the API calls and rows it would scan                                                                  | existing raw-SQL caps                   |

`query_data_source` is one tool for every external kind; the input arm it accepts follows the
source. Sending SQL to Clerk or a resource query to ClickHouse returns an error that shows the
right form, built from that source's catalog (`clerk-prod takes a resource query, for example
{"resource":"users","measure":{"fn":"count"},"groupBy":{"time":"created_at"}}`). `run_sql`
stays Maple's warehouse only, so every existing prompt and saved query is unchanged, and its
description points to `query_data_source` for connected sources.

The key to scale is `search_data_sources`: the model does not need to choose a source before it
knows where the data is. "Chart failed payments" searches `payments failed` and gets
`shop-prod.payments (status: paid, refunded, failed)` ranked above the staging copy; "how many
signups this week" gets `clerk-prod.users (created_at)`. Search ranks the stored catalogs in memory
(thousands of exposed entries at most), so it costs no source round trip and no API budget.

Naming: every tool says "data source" in full, and the existing `list_sources` is renamed
`list_ingest_sources` (old name kept as an alias) with a description that points to
`list_data_sources` for queryable systems.

### 3. Context the model gets without asking

- **Chat and investigations** (`apps/ai/src/chat/agents.ts`): the org-dynamic system prompt
  gets one line per agent-enabled source (`clerk-prod (clerk, resource query, production):
  Production user accounts and organizations...`). At 18 sources that is roughly 700 tokens.
  Above ~30, it switches to a count plus "use `search_data_sources`".
- **MCP clients**: server instructions (`server-instructions.ts`) gain one static sentence
  ("This org may connect external databases and APIs; find them with `list_data_sources` or
  `search_data_sources` and query them with `query_data_source`"), and a
  `maple://data-sources` resource carries the same per-source lines.

### 4. Query safety by construction

- Every `describe` and `query_data_source` response states the query language first.
- SQL macros (`$__timeFilter`, `$__timeGroup`, `$__interval_s`) are dialect-neutral, and
  resource queries bind the window and bucket the same way without macros. Time bucketing,
  the most error-prone part, never needs dialect knowledge.
- SQL failures run a mismatch detector before returning: a ClickHouse-only function on a
  Postgres source (and the reverse) returns "this source is PostgreSQL; `toStartOfInterval` is
  ClickHouse. Use `$__timeGroup(created_at)`." This follows the run_sql lesson that an
  auto-fix or a precise fix beats generic hint text.
- Resource queries are validated against the catalog before any call: unknown fields get a
  "did you mean", a filter that cannot push down says what it will cost, and refused queries
  (over budget, or the `last_active_at` history trap) explain why and what to ask instead.
- Unknown column errors from a SQL source get a "did you mean" from the catalog snapshot.

### 5. Create tools validate before they save

`add_dashboard_widget`, `create_dashboard`, `create_alert_rule` and `preview_alert_rule` take
`data_source` (name or id; a miss returns the closest names) and an `ExternalQuery`. Before
saving, the tool plans and runs the query on a short window and checks the resulting table
against the display's **shape contract**:

| Display           | Contract                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| line / area / bar | a time column (from `$__timeGroup` or a resource time group), at least one numeric column, optional one series column |
| stat / gauge      | one row, one numeric column                                                                                           |
| table             | any columns, at most 1,000 rows                                                                                       |
| pie / hbar        | one label column, one numeric column                                                                                  |
| alert             | numeric value column, optional group columns, within group caps; API sources also within the alert's call budget      |

A failing check refuses the save with what came back and what to change ("returned
columns `day, total` but `day` is a string; wrap it in `$__timeGroup(...)`"). A save that
passes returns the first rows and, for API sources, the calls per refresh, so the model can
describe what the user will see and what it costs. The contracts come from
`RawSqlDisplayType` and live in one place, used by these tools, the UI editor preview and
`describe_dashboard_schema`.

Connecting a source stays a UI/API action: credentials never go through a chat. A model asked
to connect one gets a `next` link to Settings → Data sources.

### 6. Evals from day one

Extend the tool playground (`apps/ai/scripts/tool-playground.sh`,
`apps/ai/src/evals/playground/`) with a **data source world**: 18 sources mixing ClickHouse,
Postgres, MySQL and two Clerk instances (production and development), deliberately
overlapping (`orders` in prod and staging), one source with 400 tables, one with epoch-int
timestamps, one disabled for agents. Postgres sources can run on PGlite, which the playground
already boots, so this is real SQL. Clerk runs as an `HttpClient` test layer serving seeded
users with Clerk's real pagination, totals, filters and 429s, so plans and budgets are real too.

Scenarios, written the way users ask:

- "Which database has our invoices?" (search, picks production)
- "How many people signed up this week?" (Clerk prod, count pushdown, 1 call)
- "Chart daily signups for the last 30 days." (Clerk line widget saved, renders, ~30 calls)
- "Show daily active users for the last month." (must explain the `last_active_at` limit and
  offer what is answerable, not draw a chart)
- "Alert me if nobody signs up for 6 hours." (Clerk alert on prod, not dev)
- "Alert me when failed payments go over 50 in 10 minutes." (SQL alert on prod, not staging)
- "Show revenue by country as a pie." (cents column note respected)
- "Put signups per day next to the checkout error rate." (mixed Maple + Clerk board)
- Negative: "How many 5xx errors today?" must not touch data sources.

Scored per run: right source, right query form on first try, calls to success, saved artifact
renders, API calls spent. Plus OpenRouter tool-selection evals (`apps/ai/src/evals/`) for
`list_sources` vs `list_data_sources` and `run_sql` vs `query_data_source`. A phase is done
when its scenarios pass, and the scores are recorded in `BASELINE.md`.

## Phases

Each phase ships and typechecks on its own. Phase 1 builds one SQL source and one API source
together, so the port, the storage format and the agent tools are general from the first PR.

### Phase 1: connections, catalog and the agent read path (ClickHouse + Clerk)

Stacked PRs:

1. Core: table + migration, `ExternalDataSourceId` brand, domain schemas (`ExternalQuery`,
   catalog, plan), typed errors, `packages/data-sources` port and registry,
   `ExternalDataSourceService` (CRUD, encrypt/decrypt, test, catalog capture + refresh),
   `external_data_source_catalog` with search index and curation fields.
2. ClickHouse driver.
3. Clerk driver: `users` resource, resource-query planner (count pushdown, bounded scan,
   refuse), per-source rate budget (Cloudflare rate-limit binding), PII marking. Confirm the remaining Clerk
   resources against Clerk's OpenAPI spec and add the confirmed ones.
4. Agent tools: `list_data_sources`, `search_data_sources`, `describe_data_source`,
   `query_data_source` with the language detector and explain mode, `list_sources` rename with
   alias, server instructions, `maple://data-sources`, chat system prompt lines.
5. v2 API (`GET/POST/PATCH/DELETE /v2/data-sources`, `POST .../test`, `GET .../catalog`,
   `POST .../catalog/refresh`) and Settings → Data sources (kit components only): list, connect
   forms per kind, description, environment, agent access, test result, catalog curation.
6. Playground data source world (ClickHouse + Clerk part) and the read scenarios.

Verify: connect a local ClickHouse with a non-Maple table and Maple's own Clerk development
instance; tests pass; a write-capable ClickHouse role shows the warning; a private-range host is
refused; the Clerk budget holds under a burst; the read scenarios pass in the playground.

### Phase 2: dashboards

- New v3 widget data source `ExternalWidgetDataSource` (`kind: "external"`,
  `dataSourceId`, `query: ExternalQuery`, display type). `raw_sql` is untouched.
- `DashboardWidgetDataService` gets an `External` path: plan, budget check, execute, then
  the same `rawSqlRowsForDisplay`.
- Shape contracts in one module; `add_dashboard_widget` / `create_dashboard` take
  `data_source` + `ExternalQuery` and validate before saving.
- Query panel: source picker; SQL editor (dialect from the driver, autocomplete from the
  catalog, macro help) or resource builder (resource, measure, group, filters, all from the
  catalog) depending on the source; preview with the same shape contracts and the plan's cost.
- Per-source concurrency and result cache; shared API budget across widgets on one board.
- Dashboard variables whose options come from an external query.

Verify: the chart scenarios pass in the playground; ClickHouse and Clerk widgets render; a
20-widget board stays within the per-source cap and the Clerk budget.

### Phase 3: alerts

- New `signalType: "external_query"` carrying `dataSourceId` + `ExternalQuery`;
  `raw_query` keeps its `$__orgFilter` rules.
- `AlertsService` evaluation dispatches to the external executor; reducers, group caps and
  `wholeRange` grouping reuse the raw path's code.
- `create_alert_rule` / `preview_alert_rule` take `data_source` with the alert shape contract.
- 5-minute minimum interval for API sources; budget checked at save time.
- Unreachable source or exhausted budget → evaluation error state + notification after N
  consecutive failures, never "resolved".
- Rule editor: same source picker, editors and preview as the widget editor.

Verify: the alert scenarios pass; SQL and Clerk threshold rules fire and resolve on seeded
data; stopping the source puts the rule in error, not resolved.

### Phase 4: PostgreSQL and MySQL

- Socket drivers, read-only transaction wrappers, dialect macro expanders + validators,
  catalog capture per dialect, language detector rules for both.
- Connect form variants (host/port/db/user/TLS mode, or a connection string).
- Workers socket test lane (`test:alchemy`) against real Postgres and MySQL containers.
- The full mixed playground world (all 18 sources) must pass before this ships.

### Phase 5: investigations

- Investigations read agent-enabled sources (e.g. the orders table or signups next to an
  error spike) through the same tools; `submit_diagnosis` can cite external query results.

### Phase 6: later

- Private networks: sources inside a VPC via Cloudflare Tunnel or Workers VPC services.
- More API sources on the Clerk path: Stripe, GitHub, Linear, PostHog.
- More SQL engines: BigQuery, Snowflake. Other languages: Prometheus (PromQL),
  Elasticsearch/OpenSearch.
- Cross-source formulas in the query set (`A` from Maple traces, `B` from Clerk signups).
- A schema-aware visual builder for SQL sources over the catalog.
- Maple Local (`apps/local-ui`) support.

## Open questions

1. Private-network reach in v1, or public endpoints only? (Plan assumes public only.)
2. Plan gating: which tiers get data sources, and is there a per-org source count limit?
3. Public dashboard shares: is the default-off toggle enough, or block external widgets on
   shares entirely in v1?
4. Is "MySQL" the second kind you want alongside Postgres, or a different one?
5. Agent access default for a new source: on (models useful immediately) or off (admin opts
   in per source)? The plan assumes on for non-production, asked at connect time for production.
6. Should the connect flow require a description, or only nudge for one? Agent accuracy with
   18 sources depends on it more than on anything else.
7. Clerk's budget share: is 5% of the instance rate limit the right default, and should admins
   be able to raise it?
8. Clerk PII: are counts and ids enough for agents by default, with emails and names behind
   the `agentPii` switch?
