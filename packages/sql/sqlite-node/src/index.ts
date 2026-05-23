/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Node.js SQLite client implementation for Effect SQL, backed by `better-sqlite3`.
 *
 * This module exposes constructors and layers for providing both the SQLite-specific `SqliteClient`
 * service and the generic `SqlClient` service. It is intended for file-backed or in-memory SQLite
 * databases in Node applications, local development tools, tests, migrations, and embedded
 * persistence use cases that need Effect SQL query compilation plus SQLite-specific operations such
 * as exporting a database, creating backups, or loading native SQLite extensions.
 *
 * Each client owns one scoped `better-sqlite3` connection and serializes access through it. WAL mode
 * is enabled by default, so set `disableWAL` when opening read-only databases or when the database
 * location cannot change journal mode. Prepared statements are cached by SQL text, safe integer
 * handling follows the `SqlClient` fiber-local setting, `executeStream` is not implemented, and
 * SQLite does not support `updateValues`.
 *
 * @since 4.0.0
 */
export * as SqliteClient from "./SqliteClient.ts"

/**
 * Utilities for applying Effect SQL migrations to Node.js SQLite databases.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through the
 * current SQLite `SqlClient`. It is typically used at application startup, in
 * tests that create temporary database files, or in layer graphs that must
 * ensure a file-backed SQLite schema exists before dependent services start.
 *
 * Migrations are recorded in `effect_sql_migrations` by default and are loaded
 * using the shared `<id>_<name>` file or record-key convention. Only migrations
 * with an id greater than the latest recorded id are applied, so every client
 * involved in startup should point at the same SQLite filename. Concurrent
 * writers can surface SQLite lock timeout errors, and this adapter does not
 * currently write SQLite schema dumps for `schemaDirectory`.
 *
 * @since 4.0.0
 */
export * as SqliteMigrator from "./SqliteMigrator.ts"
