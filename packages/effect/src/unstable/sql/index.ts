/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Effect SQL migration helpers for loading, ordering, and running schema
 * changes against a `SqlClient`.
 *
 * This module provides a migrator constructor plus loaders for common migration
 * layouts, including dynamic glob imports, Babel-style glob records, in-memory
 * records, and filesystem directories. It is intended for applications and
 * libraries that need to apply numbered SQL migrations on startup, in tests, or
 * as part of deployment tooling while keeping migration effects inside the
 * Effect environment.
 *
 * The migrator tracks applied migrations in a configurable table, defaults that
 * table to `effect_sql_migrations`, rejects duplicate migration ids, and only
 * runs migrations with an id greater than the latest recorded id. Pending
 * migrations are recorded and executed inside a `SqlClient` transaction; on
 * PostgreSQL the migrations table is explicitly locked, while other dialects
 * rely on the table's primary key or unique constraint to detect concurrent
 * runners. Migration effects should therefore be written to be transaction-aware,
 * and callers should account for dialect-specific DDL transaction behavior and
 * custom table names when coordinating schema dumps or external migration
 * tooling.
 *
 * @since 4.0.0
 */
export * as Migrator from "./Migrator.ts"

/**
 * Defines the `SqlClient` service, the central runtime entry point for Effect's
 * unstable SQL support.
 *
 * A `SqlClient` combines the tagged-template statement constructor with a
 * scoped connection acquirer, dialect compiler, tracing attributes, optional row
 * transforms, reactive query helpers, and transaction management. Applications
 * typically consume it from `Context` to build parameterized queries, stream
 * rows, run raw driver operations, reserve a connection for lower-level work, or
 * wrap several query effects in `withTransaction`.
 *
 * Transactions are tracked through a per-client context service. Top-level
 * transactions acquire the configured transaction connection and issue the
 * dialect's begin/commit/rollback SQL; nested transactions reuse that
 * connection and rely on dialect-provided savepoint SQL. A query only joins a
 * transaction when it is run with the same client service, so avoid mixing
 * clients or manually reserved connections when atomicity matters. Dialect
 * integrations are also responsible for the compiler and transaction
 * statements, which means placeholder syntax, identifier escaping, row
 * transforms, savepoint support, and unprepared/raw statement behavior can
 * differ by database.
 *
 * @since 4.0.0
 */
export * as SqlClient from "./SqlClient.ts"

/**
 * Defines the low-level SQL connection service and shared row/acquirer types
 * used by Effect's unstable SQL driver integrations.
 *
 * A `Connection` is the driver-facing layer underneath `SqlClient`: it executes
 * already-compiled SQL with positional parameters and exposes transformed row
 * results, raw driver results, streams, value arrays, and unprepared statement
 * execution. Most applications should work through `SqlClient`, while driver
 * integrations and advanced code use this module to provide scoped connection
 * acquisition, implement pooling, reserve a connection for a workflow, or adapt
 * a dialect-specific client into Effect.
 *
 * Connections are resources and should be acquired through an `Acquirer` in a
 * `Scope` so pool checkout, transaction pinning, and release semantics are
 * preserved. Transaction coordination lives at the `SqlClient` layer, so mixing
 * manually reserved connections with transactional client queries can bypass the
 * expected atomic boundary. Raw, unprepared, streaming, parameter, and row
 * transformation behavior ultimately comes from the driver and dialect; check
 * each integration for differences in placeholders, prepared statement support,
 * cursor lifetime, and result shapes.
 *
 * @since 4.0.0
 */
export * as SqlConnection from "./SqlConnection.ts"

/**
 * Structured SQL errors used by the unstable SQL APIs.
 *
 * This module defines the top-level `SqlError` wrapper, the concrete
 * `SqlErrorReason` variants used by drivers and adapters, and helpers for
 * recognizing and classifying database failures. It is useful when turning
 * native driver errors into typed Effect failures, choosing retry policies from
 * `isRetryable`, or distinguishing user-facing query problems such as syntax
 * and constraint failures from infrastructure problems such as connection,
 * lock, statement timeout, deadlock, and serialization failures.
 *
 * Query, connection, and migration code should preserve the original cause and
 * operation metadata when constructing these errors. Retrying can be appropriate
 * for transient connection and concurrency failures, but syntax, authorization,
 * authentication, and constraint failures generally require changing the query,
 * credentials, permissions, or migration data. When classifying SQLite errors,
 * the helpers inspect `code` and `errno` values and extract unique constraint
 * names when available.
 *
 * @since 4.0.0
 */
export * as SqlError from "./SqlError.ts"

/**
 * Builds SQL repositories and request resolvers from Effect schema models.
 *
 * Use this module when a `Model` describes rows in a concrete SQL table and
 * you want the common insert, update, find-by-id, and delete operations without
 * hand-writing the schema encoding, row decoding, and resolver batching each
 * time. The helpers are intended for model-backed tables where the model field
 * names line up with the encoded table columns and the chosen `idColumn` is
 * present in both the model fields and update schema.
 *
 * Returned rows are decoded with the full model schema, while insert and update
 * requests are encoded with the model's dedicated input schemas. Soft deletes
 * are opt-in via `softDeleteColumn`: reads and updates only see rows where that
 * column is `null`, and deletes set it to `CURRENT_TIMESTAMP` instead of
 * removing the row. Dialects with `returning` support return changed rows
 * directly; MySQL performs a follow-up `select`, so generated ids, defaults,
 * and trigger-updated values must be observable from that query.
 *
 * @since 4.0.0
 */
export * as SqlModel from "./SqlModel.ts"

/**
 * Schema-aware `RequestResolver` helpers for SQL-backed data loading.
 *
 * This module bridges `Effect.request` with `SqlClient` by representing each
 * lookup or mutation as a `SqlRequest` and batching concurrent requests into a
 * single SQL operation. Request payloads are encoded with the request schema
 * before `execute` is called, and rows returned by the query are decoded with
 * the result schema before entries are completed.
 *
 * Use `ordered` when a query returns exactly one row per request in the same
 * order, `findById` for `where id in (...)` lookups, `grouped` for one-to-many
 * relationships, and `void` for inserts, updates, deletes, or other
 * side-effecting statements where no row is needed.
 *
 * **Gotchas**
 *
 * - `ordered` requires the result count and order to match the request batch.
 * - `grouped` and `findById` rely on stable request/result keys and fail
 *   missing requests with `NoSuchElementError`.
 * - Equal payloads are equal `SqlRequest`s, which enables request batching,
 *   deduplication, and cache reuse; model payload identity deliberately.
 * - Batches are split by the active SQL transaction connection, so requests
 *   made in different transactions are not resolved together.
 * - Queries like `where id in (...)` often return rows in database order; use
 *   `findById` or `grouped`, or preserve input order explicitly before choosing
 *   `ordered`.
 *
 * @since 4.0.0
 */
export * as SqlResolver from "./SqlResolver.ts"

/**
 * Schema-driven helpers for wrapping SQL executions in typed query functions.
 *
 * This module connects `Schema` request and result definitions to an `execute`
 * callback that runs the actual SQL statement. The returned functions accept
 * the request schema's decoded `Type`, encode it to the SQL-facing `Encoded`
 * shape, run the callback, and then decode unknown driver rows through the
 * result schema. This is useful for repository methods, CRUD helpers, request
 * resolvers, and write operations where callers should work with domain values
 * instead of raw SQL parameters or rows.
 *
 * The `execute` callback always receives `Req["Encoded"]`, so schema
 * transformations, required encoding services, and database representations
 * such as nullable columns, JSON values, dates, and bigints must line up with
 * the statement builder and dialect in use. Result schemas decode the rows
 * returned by the driver after any SQL client row transforms; `findOne` and
 * `findOneOption` only inspect the first row, `findNonEmpty` requires at least
 * one row, and `void` discards any driver result after request encoding.
 *
 * @since 4.0.0
 */
export * as SqlSchema from "./SqlSchema.ts"

/**
 * Low-level helpers for adapting push-based SQL row sources into Effect
 * streams.
 *
 * SQL drivers often expose large query results through cursors, event emitters,
 * or driver-specific streams that push rows as they arrive. This module
 * provides the small interop layer used by SQL integrations to turn those
 * producers into `Stream` values for `Statement.stream` and
 * `Connection.executeStream`, so callers can process large result sets
 * incrementally instead of materializing every row in memory.
 *
 * The adapter is scoped: driver cursors, query streams, or reserved
 * connections should be acquired in the registration effect and released with
 * finalizers. The internal queue is bounded and calls the producer's
 * `onPause`/`onResume` hooks when downstream consumption falls behind, but the
 * underlying driver still has to honor those hooks for backpressure to be
 * effective. Slow consumers may keep a database cursor and connection open for
 * the lifetime of the stream, so integrations should close or destroy driver
 * resources on interruption, failure, or normal completion and should signal
 * terminal events with `fail` or `end` exactly once.
 *
 * @since 4.0.0
 */
export * as SqlStream from "./SqlStream.ts"

/**
 * Building blocks for Effect's unstable SQL statement API.
 *
 * This module defines the low-level `Statement` and `Fragment` model used by
 * SQL clients, the tagged-template `Constructor` for creating executable
 * parameterized statements, and dialect compilers that turn statement segments
 * into SQL text plus bind parameters. It also provides helpers for escaped
 * identifiers, `IN` lists, comma-separated clause fragments, record inserts and
 * updates, custom segments, and row or identifier transforms.
 *
 * In tagged templates, interpolated `Fragment`s and known `Segment`s are
 * spliced into the statement, while ordinary values become bound parameters. Use
 * identifiers for table and column names and the record helpers for generated
 * column lists; `literal` and `unsafe` insert SQL text directly and should only
 * be used with trusted SQL. Compilation is dialect-specific, caches rendered SQL
 * on the statement, and has a `withoutTransform` path for bypassing identifier
 * transforms, so compiled output can differ from normal transformed execution.
 *
 * @since 4.0.0
 */
export * as Statement from "./Statement.ts"
