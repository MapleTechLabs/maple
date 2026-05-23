/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * PostgreSQL client implementation for Effect SQL, backed by `pg`.
 *
 * This module exposes constructors for creating a scoped `PgClient` from a
 * managed `pg` pool, a single managed `pg` client, or lower-level connection
 * acquirers. The resulting service can be provided as both `PgClient` and the
 * generic `SqlClient`, and is intended for application database access,
 * migrations, transactional workflows, row streaming, JSON parameters, and
 * PostgreSQL LISTEN/NOTIFY integration.
 *
 * Pool-backed clients acquire connections per operation and reserve dedicated
 * connections for transactions and cursor streams. Clients built from one
 * `pg.Client` serialize shared access; enable `acquireForStream` when streams
 * or listeners need their own client instead of sharing the query connection.
 * LISTEN uses a scoped long-lived client and automatically issues `UNLISTEN`
 * when the stream scope closes, so listeners should be scoped for as long as
 * notifications are needed.
 *
 * @since 4.0.0
 */
export * as PgClient from "./PgClient.ts"

/**
 * Utilities for applying Effect SQL migrations to PostgreSQL databases.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through
 * the current PostgreSQL `SqlClient` and `PgClient`. It is typically used at
 * application startup, during deployment, in integration tests that provision a
 * temporary PostgreSQL database, or in layer graphs that must prepare the
 * schema before dependent services are acquired.
 *
 * Migrations are recorded in `effect_sql_migrations` by default and are loaded
 * using the shared `<id>_<name>` file or record-key convention. Only migrations
 * with an id greater than the latest recorded id are applied, so concurrent
 * application instances should coordinate startup against the same database and
 * avoid racing to install the same changes. When `schemaDirectory` is enabled,
 * this adapter shells out to `pg_dump` using the active `PgClient`
 * configuration, so `pg_dump` must be available on `PATH` and the layer must
 * provide child process, filesystem, and path services. The generated dumps
 * intentionally strip comments, session settings, ownership, and privilege
 * statements to keep schema snapshots portable across PostgreSQL environments.
 *
 * @since 4.0.0
 */
export * as PgMigrator from "./PgMigrator.ts"
