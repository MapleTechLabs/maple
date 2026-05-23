/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * ClickHouse client implementation for Effect SQL, backed by
 * `@clickhouse/client`.
 *
 * This module exposes constructors and layers for providing both the
 * ClickHouse-specific `ClickhouseClient` service and the generic `SqlClient`
 * service. It is intended for analytical application queries, migrations,
 * background jobs, bulk inserts, and streaming reads that need Effect SQL query
 * compilation, scoped lifecycle management, interruption, and consistent
 * `SqlError` classification for ClickHouse failures.
 *
 * The client uses the ClickHouse HTTP client APIs for `query`, `command`, and
 * `insert` operations. Regular queries read JSON result sets, `executeValues`
 * requests `JSONCompact`, streams request `JSONEachRow`, and `insertQuery`
 * defaults inserts to `JSONEachRow`. Interrupting an operation aborts the
 * underlying HTTP request and attempts to kill the generated or supplied
 * `query_id`. The statement compiler emits ClickHouse typed placeholders such
 * as `{p1: Type}`; use `param` when the inferred type is too broad, and write
 * ClickHouse-specific clauses such as engines, `SETTINGS`, `FORMAT`, or
 * cluster directives explicitly.
 *
 * @since 4.0.0
 */
export * as ClickhouseClient from "./ClickhouseClient.ts"

/**
 * Utilities for applying Effect SQL migrations to ClickHouse databases.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through
 * the current ClickHouse `SqlClient`. It is typically used during application
 * startup, deployment, or integration tests that need to prepare analytical
 * tables before dependent services begin reading or writing data.
 *
 * Applied migrations are stored in `effect_sql_migrations` by default and use
 * the shared `<id>_<name>` loader convention. Only migrations with ids greater
 * than the latest recorded id are run. ClickHouse schema changes often depend
 * on engine, `ORDER BY`, database, and cluster settings, and many deployments
 * rely on explicit `ON CLUSTER` clauses or coordinated rollout tooling. This
 * adapter does not add a ClickHouse-specific table lock or schema dumper, so
 * coordinate concurrent migrators and do not expect `schemaDirectory` to emit a
 * ClickHouse schema snapshot.
 *
 * @since 4.0.0
 */
export * as ClickhouseMigrator from "./ClickhouseMigrator.ts"
