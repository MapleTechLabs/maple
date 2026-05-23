/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Bun SQLite client implementation for Effect SQL, backed by `bun:sqlite`.
 *
 * This module provides constructors and layers for using a Bun-managed SQLite database as both the
 * SQLite-specific `SqliteClient` service and the generic `SqlClient` service. It is intended for
 * file-backed or in-memory databases in Bun applications, local development tools, migrations,
 * integration tests, and embedded persistence use cases that need Effect SQL query compilation plus
 * SQLite-specific helpers such as database export and native extension loading.
 *
 * Each client owns one scoped `bun:sqlite` `Database` handle and serializes access through it, which
 * is important because Bun executes SQLite statements synchronously. WAL mode is enabled by default,
 * so set `disableWAL` when opening read-only databases or when the database file or directory cannot
 * be updated with SQLite's WAL side files. A transaction holds the serialized connection permit for
 * the transaction scope, so concurrent fibers using the same client wait until it completes, while
 * separate database handles or processes can still contend for SQLite write locks. Safe integer
 * handling follows the `SqlClient` fiber-local setting, `executeStream` is not implemented, and
 * SQLite does not support `updateValues`.
 *
 * @since 4.0.0
 */
export * as SqliteClient from "./SqliteClient.ts"

/**
 * Utilities for applying Effect SQL migrations to Bun SQLite databases.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through
 * the current Bun-backed SQLite `SqlClient`. It is typically used at
 * application startup, in deployment or setup scripts that prepare a local
 * SQLite file, in integration tests with temporary database files, or in layer
 * graphs that must install the schema before dependent services are acquired.
 *
 * Migrations are recorded in `effect_sql_migrations` by default and are loaded
 * using the shared `<id>_<name>` file or record-key convention. Only migrations
 * with an id greater than the latest recorded id are applied, so every client
 * involved in startup should point at the same SQLite filename and use a
 * writable Bun SQLite configuration. The Bun client enables WAL by default and
 * serializes access through a single `bun:sqlite` database handle, but separate
 * handles or processes can still contend for SQLite write locks. Bun's SQLite
 * driver runs statements synchronously, so large migration sets can block the
 * invoking runtime thread, and this adapter does not currently write SQLite
 * schema dumps for `schemaDirectory`.
 *
 * @since 4.0.0
 */
export * as SqliteMigrator from "./SqliteMigrator.ts"
