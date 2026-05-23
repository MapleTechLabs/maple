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
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import type * as Client from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * @since 4.0.0
 */
export * from "effect/unstable/sql/Migrator"

/**
 * Runs SQL migrations using the configured `SqlClient`, returning the migrations that were applied.
 *
 * @category constructors
 * @since 4.0.0
 */
export const run: <R2 = never>(
  options: Migrator.MigratorOptions<R2>
) => Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  Client.SqlClient | R2
> = Migrator.make({})

/**
 * Creates a layer that runs the configured SQL migrations during layer construction.
 *
 * @category constructors
 * @since 4.0.0
 */
export const layer = <R>(
  options: Migrator.MigratorOptions<R>
): Layer.Layer<never, Migrator.MigrationError | SqlError, Client.SqlClient | R> => Layer.effectDiscard(run(options))
