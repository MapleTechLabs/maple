/**
 * @since 4.0.0
 */

export {
  /**
   * @since 4.0.0
   */
  TYPES as MssqlTypes
} from "tedious"

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Microsoft SQL Server client implementation for Effect SQL, backed by the
 * `tedious` driver.
 *
 * This module provides the `MssqlClient` service and layers that also satisfy
 * the generic `SqlClient` service. It is intended for server applications,
 * background workers, migrations, and tests that need SQL Server query
 * compilation, Tedious parameter typing, scoped connection management,
 * transactions, and typed stored procedure calls.
 *
 * Clients own a scoped pool of Tedious connections and validate startup with
 * `SELECT 1`. Regular queries borrow a pooled connection per operation, while
 * transactions keep one pooled connection for their lifetime and use SQL Server
 * savepoints for nested transactions. Long-running transactions therefore
 * reduce available pool capacity; size `maxConnections`, `connectionTTL`, and
 * `connectTimeout` accordingly.
 *
 * Tedious permits one active request per connection. This client compiles
 * statements with named `@1`-style parameters, maps Effect SQL primitive values
 * to Tedious `DataType`s unless `param` is used, and does not implement
 * streaming queries. Be deliberate about TLS options: `encrypt` defaults to
 * `false` and `trustServerCertificate` defaults to `true` unless overridden.
 * Stored procedure calls go through `callProcedure`; define input and output
 * parameters with the `Procedure` and `Parameter` helpers so Tedious receives
 * the correct data types and output values can be collected from `returnValue`
 * events.
 *
 * @since 4.0.0
 */
export * as MssqlClient from "./MssqlClient.ts"

/**
 * Utilities for applying Effect SQL migrations to Microsoft SQL Server.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through
 * the current SQL Server `SqlClient`. It is typically used at application
 * startup, during deployment, in integration tests that provision temporary SQL
 * Server databases, or in layer graphs that need the database schema to be
 * current before dependent services are acquired.
 *
 * Applied migrations are stored in `effect_sql_migrations` by default and use
 * the shared `<id>_<name>` loader convention. Only migrations with ids greater
 * than the latest recorded id are run, so avoid inserting older migration ids
 * after a later migration has reached production. SQL Server migrations run
 * inside the shared migrator transaction and this adapter does not add a
 * dialect-specific table lock, so coordinate concurrent startup runners and
 * write T-SQL that is valid inside an explicit transaction. Remember that `GO`
 * is a client-side batch separator rather than a T-SQL statement, and split
 * migrations when SQL Server requires an object definition such as `CREATE
 * VIEW`, `CREATE PROCEDURE`, or `CREATE TRIGGER` to start its own batch. This
 * adapter also does not emit SQL Server schema dumps for `schemaDirectory`.
 *
 * @since 4.0.0
 */
export * as MssqlMigrator from "./MssqlMigrator.ts"

/**
 * Typed metadata for SQL Server stored procedure parameters.
 *
 * This module records the bare parameter name, Tedious `DataType`, Tedious
 * `ParameterOptions`, and phantom TypeScript value type used by
 * `Procedure.param` and `Procedure.outputParam`. `MssqlClient.call` later
 * forwards input parameters to Tedious with `Request.addParameter` and output
 * parameters with `Request.addOutputParameter`, so names should match the
 * stored procedure parameter name without a leading `@`.
 *
 * Use these values when defining stored procedures that need explicit SQL
 * Server parameter metadata, such as sized strings or binary values, decimal
 * precision/scale, table-valued parameters, and output parameters. The generic
 * type parameter is only a compile-time guide for the value record accepted by
 * `Procedure.compile`; Tedious still validates and encodes the runtime value.
 * In particular, TVP values must use Tedious' table shape with `name`,
 * optional `schema`, `columns`, and `rows`, and output parameters are registered
 * with no initial value, so SQL Server input-output parameters need separate
 * care rather than assuming an output parameter is populated from compiled
 * input values.
 *
 * @since 4.0.0
 */
export * as Parameter from "./Parameter.ts"

/**
 * Typed builders for Microsoft SQL Server stored procedure definitions.
 *
 * This module describes the metadata consumed by `MssqlClient.call`: create a
 * definition with `make`, add input and output parameters with their Tedious
 * data types and `ParameterOptions`, optionally describe the returned row shape
 * with `withRows`, and use `compile` to bind the input values before execution.
 * It is useful when application code calls stored procedures for commands,
 * reports, migrations, or workflows that return both result sets and output
 * parameters.
 *
 * Parameter value types are supplied explicitly through `param<A>()` and
 * `outputParam<A>()`; they are not inferred from the Tedious data type. Input
 * values must be keyed by the parameter names in the definition, output
 * parameters are collected separately from returned rows, and `withRows` only
 * records the expected TypeScript row type, so row names and transforms still
 * follow the configured `MssqlClient` result handling.
 *
 * @since 4.0.0
 */
export * as Procedure from "./Procedure.ts"
