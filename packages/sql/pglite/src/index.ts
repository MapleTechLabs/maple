/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Embedded PostgreSQL client implementation for Effect SQL, backed by
 * `@electric-sql/pglite`.
 *
 * This module exposes constructors and layers for providing a `PgliteClient`
 * as both the PGlite-specific service and the generic `SqlClient`. It can
 * create a scoped `PGlite` instance from constructor options or wrap a
 * caller-owned `liveClient`, making it useful for local-first browser storage,
 * web worker databases, tests, demos, migrations, and development tools that
 * want PostgreSQL syntax without connecting to a separate PostgreSQL server.
 *
 * The client uses the PostgreSQL statement compiler and adds PGlite-specific
 * access to the underlying instance, JSON fragments, LISTEN/NOTIFY streams,
 * data directory dumps, and array type refresh. Because PGlite is embedded in
 * the current JavaScript runtime, operations share the supplied instance and
 * are serialized by this client; a `liveClient` remains caller-owned and is not
 * closed by the layer. In browsers or workers, persistence, durability,
 * extension availability, and lifecycle all follow the selected PGlite
 * `dataDir`/runtime rather than a hosted PostgreSQL process.
 *
 * @since 4.0.0
 */
export * as PgliteClient from "./PgliteClient.ts"

/**
 * Utilities for applying Effect SQL migrations to embedded PGlite databases.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through the
 * current PGlite-backed `SqlClient`. It is typically used to bootstrap schemas
 * for local-first applications, browser or Node.js integration tests, examples,
 * and layer graphs that need an embedded PostgreSQL-compatible database to be
 * ready before dependent services start.
 *
 * Migrations are recorded in `effect_sql_migrations` by default and are loaded
 * using the shared `<id>_<name>` file or record-key convention. PGlite uses
 * PostgreSQL semantics inside the embedded database, so migrations run in a
 * transaction and the shared migrator uses PostgreSQL table locking to avoid
 * concurrent runners. Coordinate every process or layer using the same
 * `liveClient` or `dataDir`, and remember that in-memory PGlite clients start
 * with no recorded migrations. This adapter does not currently write schema
 * dumps for `schemaDirectory`; use PGlite data-directory persistence or
 * `PgliteClient.dumpDataDir` when a portable embedded database snapshot is
 * needed.
 *
 * @since 4.0.0
 */
export * as PgliteMigrator from "./PgliteMigrator.ts"
