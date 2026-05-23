/**
 * Utilities for applying Effect SQL migrations to ClickHouse databases.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through
 * the current ClickHouse `SqlClient`. It is typically used during application
 * startup, deployment, or integration tests that need to prepare analytical
 * tables before dependent services begin reading or writing data.
 *
 * Applied migrations are stored in `effect_sql_migrations` by default and use
 * the shared `<id>_<name>` loader convention. Only migrations with ids greater
 * than the latest recorded id are run. ClickHouse schema changes often depend
 * on engine, `ORDER BY`, database, and cluster settings, and many deployments
 * rely on explicit `ON CLUSTER` clauses or coordinated rollout tooling. This
 * adapter does not add a ClickHouse-specific table lock or schema dumper, so
 * coordinate concurrent migrators and do not expect `schemaDirectory` to emit a
 * ClickHouse schema snapshot.
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
 * Runs SQL migrations for ClickHouse using the supplied migrator options and
 * returns the applied migration IDs and names.
 *
 * @category constructors
 * @since 4.0.0
 */
export const run: <R2 = never>(
  { loader, schemaDirectory, table }: Migrator.MigratorOptions<R2>
) => Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  Client.SqlClient | R2
> = Migrator.make({})

/**
 * Creates a layer that runs the configured ClickHouse migrations during layer
 * construction and provides no services.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <R>(
  options: Migrator.MigratorOptions<R>
): Layer.Layer<
  never,
  Migrator.MigrationError | SqlError,
  Client.SqlClient | R
> => Layer.effectDiscard(run(options))
