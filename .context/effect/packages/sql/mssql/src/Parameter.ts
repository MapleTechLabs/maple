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
import { identity } from "effect/Function"
import type { DataType } from "tedious/lib/data-type.ts"
import type { ParameterOptions } from "tedious/lib/request.ts"

/**
 * Runtime type identifier used to mark SQL Server stored procedure parameter metadata.
 *
 * @category type id
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-mssql/Parameter"

/**
 * Type-level identifier used to mark SQL Server stored procedure parameter metadata.
 *
 * @category type id
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-mssql/Parameter"

/**
 * Metadata for a SQL Server stored procedure parameter, including its name, Tedious data type, options, and phantom value type.
 *
 * @category models
 * @since 4.0.0
 */
export interface Parameter<out A> {
  readonly [TypeId]: (_: never) => A
  readonly _tag: "Parameter"
  readonly name: string
  readonly type: DataType
  readonly options: ParameterOptions
}

/**
 * Creates typed metadata for a SQL Server stored procedure parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <A>(
  name: string,
  type: DataType,
  options: ParameterOptions = {}
): Parameter<A> => ({
  [TypeId]: identity,
  _tag: "Parameter",
  name,
  type,
  options
})
