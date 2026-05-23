/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Provides an Effect SQL client for Cloudflare Durable Object SQLite storage.
 *
 * This module adapts a Durable Object `SqlStorage` handle into both the
 * Durable Object-specific `SqliteClient` service and the generic Effect
 * `SqlClient` service. Use it from inside a Durable Object to run local
 * per-object queries, repositories, migrations, transactional read/write
 * workflows, and tests that exercise Cloudflare's SQLite-backed storage API.
 *
 * Durable Object SQLite storage is scoped to one object id, so each object
 * instance has its own database and callers should pass the same `SqlStorage`
 * handle that the object uses for normal reads and writes. This adapter
 * serializes Effect SQL access through one connection; a transaction holds that
 * permit for the lifetime of its scope, so keep transactions short, avoid
 * suspending them across unrelated work, and use them when multi-statement
 * writes must commit atomically. `SqlStorage.exec` returns `ArrayBuffer` values
 * for SQLite blobs, which this client normalizes to `Uint8Array`, and SQLite
 * does not support `updateValues`.
 *
 * @since 4.0.0
 */
export * as SqliteClient from "./SqliteClient.ts"

/**
 * Utilities for applying Effect SQL migrations to Cloudflare Durable Object SQLite storage.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers that execute ordered migrations through the
 * current Durable Object `SqlStorage`-backed `SqlClient`. Use it when a Durable
 * Object needs to create or upgrade its local schema during construction, before
 * repositories or request handlers use the object storage, or in tests that
 * exercise Durable Object persistence.
 *
 * Migrations are recorded in `effect_sql_migrations` by default and are loaded
 * using the shared `<id>_<name>` file or record-key convention. The underlying
 * storage is scoped to a Durable Object id, so running migrations for one object
 * does not update any other object instance; run the migrator against the same
 * `SqlStorage` handle that the object uses for normal queries. These SQL
 * migrations are separate from Cloudflare's Durable Object class migrations, and
 * the Durable Object must already be configured with SQLite storage before this
 * module can apply schema changes. Repeated startup runs are expected and are
 * guarded by the migrations table, but request handling should wait until the
 * migration layer has finished. This adapter does not currently write SQLite
 * schema dumps for `schemaDirectory`.
 *
 * @since 4.0.0
 */
export * as SqliteMigrator from "./SqliteMigrator.ts"
