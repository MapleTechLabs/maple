/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Cloudflare D1 client implementation for Effect SQL, backed by a Workers `D1Database` binding.
 *
 * This module adapts a Cloudflare D1 database binding into both the
 * D1-specific `D1Client` service and the generic Effect `SqlClient` service.
 * Use it in Workers, Pages Functions, and tests that provide a D1 binding to
 * run SQLite-compatible queries through Effect services and layers, including
 * repositories, migrations, request handlers, and local development against
 * Wrangler or Miniflare-backed D1 databases.
 *
 * The client prepares statements with D1, caches them by SQL string, and uses
 * the SQLite statement compiler for query and result name transforms. D1
 * commits individual statements automatically, and native `D1Database.batch`
 * is the D1 API for sequential, transactional multi-statement work; this
 * adapter does not expose Effect SQL transactions because it cannot map
 * `withTransaction` onto a connection-scoped D1 transaction. D1 databases are
 * serverless SQLite storage with platform limits and single-database serialized
 * execution, so keep queries small and indexed, batch large maintenance work
 * at the D1 API level, and use D1 sessions outside this client when an
 * application needs bookmark-based sequential consistency or read replicas.
 * Streaming queries and `updateValues` are not supported.
 *
 * @since 4.0.0
 */
export * as D1Client from "./D1Client.ts"
