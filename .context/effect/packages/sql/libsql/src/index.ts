/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * libSQL client implementation for Effect SQL, backed by `@libsql/client`.
 *
 * This module creates or wraps a libSQL SDK client and exposes it as both the
 * libSQL-specific `LibsqlClient` service and the generic Effect `SqlClient`.
 * Use it for Turso-hosted libSQL databases, local `file:` databases, embedded
 * replicas configured with `syncUrl`, migrations, tests, and application code
 * that wants SQLite-compatible SQL through Effect services and layers.
 *
 * When connection options are supplied the SDK client is scoped and closed by
 * the layer; when `liveClient` is supplied ownership stays with the caller.
 * Top-level `withTransaction` blocks open a libSQL write transaction, nested
 * transactions use SQLite savepoints, and only statements run through the same
 * Effect client participate in that transaction. Keep Turso or remote libSQL
 * transactions short, because the transaction holds the client reservation
 * until commit or rollback; direct SDK calls made outside this service are not
 * coordinated with Effect SQL transactions. Row streaming is not implemented.
 *
 * @since 4.0.0
 */
export * as LibsqlClient from "./LibsqlClient.ts"

/**
 * Utilities for applying Effect SQL migrations to libSQL and Turso databases.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through the
 * current libSQL-backed `SqlClient`. It is typically used at application
 * startup, in deployment or setup scripts for Turso databases, in tests that
 * create temporary `file:` databases, or in layer graphs that must ensure the
 * schema exists before dependent services are acquired.
 *
 * Migrations are recorded in `effect_sql_migrations` by default and are loaded
 * using the shared `<id>_<name>` file or record-key convention. Because libSQL
 * uses SQLite-compatible SQL, migrations should avoid dialect features that are
 * not supported by libSQL or the configured Turso deployment. Remote Turso
 * databases, local `file:` databases, and embedded replicas can each observe
 * different state until replication has caught up, so run schema-changing
 * migrations against the intended writer and wait for replicas to sync before
 * serving code that depends on the new schema. Concurrent migrators rely on the
 * migrations table primary key to detect races, and this adapter does not
 * currently write schema dumps for `schemaDirectory`.
 *
 * @since 4.0.0
 */
export * as LibsqlMigrator from "./LibsqlMigrator.ts"
