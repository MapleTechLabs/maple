/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * MySQL client implementation for Effect SQL, backed by the `mysql2` driver.
 *
 * This module exposes constructors and layers for providing both the MySQL-specific
 * `MysqlClient` service and the generic `SqlClient` service. It is intended for server
 * applications, background workers, migrations, and tests that need Effect SQL query
 * compilation, scoped resource management, streaming queries, and consistent `SqlError`
 * classification for MySQL driver failures.
 *
 * Each client owns a scoped mysql2 pool, validates connectivity with `SELECT 1` during
 * acquisition, and closes the pool when the surrounding scope is released. You can configure
 * the pool from a connection URI or discrete connection fields; when `url` is supplied it
 * takes precedence over the host, port, database, username, and password fields. Regular
 * queries run through the shared pool, while transactions acquire a dedicated pooled
 * connection for their lifetime, so long-running transactions and streams can occupy pool
 * capacity. Size `maxConnections`, `connectionTTL`, and any mysql2 `poolConfig` with that in
 * mind.
 *
 * @since 4.0.0
 */
export * as MysqlClient from "./MysqlClient.ts"

/**
 * Utilities for applying Effect SQL migrations to MySQL databases through the
 * mysql2-backed `SqlClient`.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations using the
 * currently configured MySQL `SqlClient`. It is commonly used during application
 * startup, in integration tests that provision a temporary schema, or in layer
 * graphs where dependent services should not start until the database schema is
 * current.
 *
 * Applied migrations are stored in `effect_sql_migrations` by default and use
 * the shared `<id>_<name>` loader convention. Only migrations with ids greater
 * than the latest recorded id are run. MySQL DDL can cause implicit commits, and
 * this adapter relies on migration table constraints to detect concurrent
 * runners, so coordinate startup runners and write migrations to tolerate
 * MySQL's transactional semantics. Schema dump support is not enabled in this
 * adapter, so `schemaDirectory` does not emit a MySQL dump.
 *
 * @since 4.0.0
 */
export * as MysqlMigrator from "./MysqlMigrator.ts"
