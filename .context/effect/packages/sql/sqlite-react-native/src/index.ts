/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Provides a React Native SQLite `SqlClient` backed by `@op-engineering/op-sqlite`.
 *
 * Use this module to open an on-device SQLite database, expose it as both the
 * React Native-specific `SqliteClient` and the generic Effect `SqlClient`, and
 * run application queries, migrations, and transactional reads or writes from
 * Effect services and layers.
 *
 * The client uses one serialized connection. Regular queries and transactions
 * share that handle, and a transaction holds it for the lifetime of its scope,
 * so keep mobile transactions short and wrap multi-statement writes in a
 * transaction to avoid partial updates. By default statements use the driver's
 * synchronous API, which can block the JavaScript thread; `withAsyncQuery`
 * switches a fiber to the asynchronous driver API when UI responsiveness is more
 * important than sync execution.
 *
 * @since 4.0.0
 */
export * as SqliteClient from "./SqliteClient.ts"

/**
 * Utilities for applying Effect SQL migrations to React Native SQLite databases.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers that execute ordered migrations through the
 * current React Native SQLite `SqlClient`. Use it when a mobile app needs to
 * bring its on-device database schema up to date during startup, before opening
 * repositories or sync services, or in integration tests that create app-local
 * database files.
 *
 * React Native SQLite databases are scoped by the client configuration, so the
 * migrator should be run with the same `filename`, `location`, and encryption
 * key as the rest of the application. Migrations run through the package's
 * single serialized connection; by default statements use the synchronous
 * driver API and can block the JS thread, so long migration sets may want to run
 * under `SqliteClient.withAsyncQuery`. Mobile upgrades can be interrupted by app
 * suspension or process death, so keep migrations transaction-aware and avoid
 * assuming a fresh database on every launch.
 *
 * @since 4.0.0
 */
export * as SqliteMigrator from "./SqliteMigrator.ts"
