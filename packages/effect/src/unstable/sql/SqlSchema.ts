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
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import type * as Option from "../../Option.ts"
import * as Schema from "../../Schema.ts"

/**
 * Builds a query function that encodes the request, decodes all result rows,
 * and fails with `NoSuchElementError` when the result set is empty.
 *
 * @category constructors
 * @since 4.0.0
 */
export const findAll = <Req extends Schema.Top, Res extends Schema.Top, E, R>(
  options: {
    readonly Request: Req
    readonly Result: Res
    readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>
  }
) => {
  const encodeRequest = Schema.encodeEffect(options.Request)
  const decode = Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(options.Result)))
  return (
    request: Req["Type"]
  ): Effect.Effect<
    Array<Res["Type"]>,
    E | Schema.SchemaError,
    Req["EncodingServices"] | Res["DecodingServices"] | R
  > => Effect.flatMap(Effect.flatMap(encodeRequest(request), options.execute), decode)
}

/**
 * Run a sql query with a request schema and a result schema.
 *
 * @category constructors
 * @since 4.0.0
 */
export const findNonEmpty = <Req extends Schema.Top, Res extends Schema.Top, E, R>(
  options: {
    readonly Request: Req
    readonly Result: Res
    readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>
  }
) => {
  const find = findAll(options)
  return (
    request: Req["Type"]
  ): Effect.Effect<
    Arr.NonEmptyArray<Res["Type"]>,
    E | Schema.SchemaError | Cause.NoSuchElementError,
    Req["EncodingServices"] | Res["DecodingServices"] | R
  > =>
    Effect.flatMap(find(request), (results) =>
      Arr.isArrayNonEmpty(results)
        ? Effect.succeed(results)
        : Effect.fail(new Cause.NoSuchElementError()))
}

const void_ = <Req extends Schema.Top, E, R>(
  options: {
    readonly Request: Req
    readonly execute: (request: Req["Encoded"]) => Effect.Effect<unknown, E, R>
  }
) => {
  const encode = Schema.encodeEffect(options.Request)
  return (request: Req["Type"]): Effect.Effect<void, E | Schema.SchemaError, R | Req["EncodingServices"]> =>
    Effect.asVoid(
      Effect.flatMap(encode(request), options.execute)
    )
}
export {
  /**
   * Run a sql query with a request schema and discard the result.
   *
   * @category constructors
   * @since 4.0.0
   */
  void_ as void
}

/**
 * Builds a query function that encodes the request, decodes the first result
 * row, and fails with `NoSuchElementError` when no rows are returned.
 *
 * @category constructors
 * @since 4.0.0
 */
export const findOne = <Req extends Schema.Top, Res extends Schema.Top, E, R>(
  options: {
    readonly Request: Req
    readonly Result: Res
    readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>
  }
) => {
  const encodeRequest = Schema.encodeEffect(options.Request)
  const decode = Schema.decodeUnknownEffect(options.Result)
  return (
    request: Req["Type"]
  ): Effect.Effect<
    Res["Type"],
    E | Schema.SchemaError | Cause.NoSuchElementError,
    R | Req["EncodingServices"] | Res["DecodingServices"]
  > =>
    Effect.flatMap(
      Effect.flatMap(encodeRequest(request), options.execute),
      (arr): Effect.Effect<
        Res["Type"],
        Schema.SchemaError | Cause.NoSuchElementError,
        Req["EncodingServices"] | Res["DecodingServices"]
      > => Arr.isReadonlyArrayNonEmpty(arr) ? decode(arr[0]) : Effect.fail(new Cause.NoSuchElementError())
    )
}

/**
 * Builds a query function that encodes the request, decodes the first result row
 * as `Option.some`, and returns `Option.none` when no rows are returned.
 *
 * @category constructors
 * @since 4.0.0
 */
export const findOneOption = <Req extends Schema.Top, Res extends Schema.Top, E, R>(
  options: {
    readonly Request: Req
    readonly Result: Res
    readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>
  }
) => {
  const encodeRequest = Schema.encodeEffect(options.Request)
  const decode = Schema.decodeUnknownEffect(options.Result)
  return (
    request: Req["Type"]
  ): Effect.Effect<
    Option.Option<Res["Type"]>,
    E | Schema.SchemaError,
    R | Req["EncodingServices"] | Res["DecodingServices"]
  > =>
    Effect.flatMap(
      Effect.flatMap(encodeRequest(request), options.execute),
      (arr): Effect.Effect<
        Option.Option<Res["Type"]>,
        Schema.SchemaError,
        Req["EncodingServices"] | Res["DecodingServices"]
      > => Arr.isReadonlyArrayNonEmpty(arr) ? Effect.asSome(decode(arr[0])) : Effect.succeedNone
    )
}
