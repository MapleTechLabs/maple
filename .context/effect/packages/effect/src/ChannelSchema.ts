/**
 * The `ChannelSchema` module provides helpers for applying `Schema` encoding
 * and decoding at `Channel` boundaries. It is useful when a channel should
 * expose typed values to application code while communicating with an upstream
 * or downstream component through an encoded representation such as JSON-ready
 * data, wire protocol values, or any other schema-defined format.
 *
 * **Mental model**
 *
 * - A channel schema adapter is a streaming boundary: chunks flow through a
 *   `Channel`, and each non-empty chunk is validated and transformed with a
 *   `Schema`
 * - `encode` turns typed schema values into their encoded representation before
 *   they leave a typed part of a pipeline
 * - `decode` turns encoded input into typed schema values before application
 *   code consumes them
 * - `duplex` wraps a bidirectional channel so callers work with typed input and
 *   output while the wrapped channel continues to operate on encoded chunks
 * - Schema failures are surfaced through the channel error type as
 *   `SchemaError`, and schema services are reflected in the channel
 *   requirements
 *
 * **Common tasks**
 *
 * - Encode typed channel input before sending it to an encoded transport:
 *   {@link encode}
 * - Decode encoded channel output before handling it as domain data:
 *   {@link decode}
 * - Use unknown encoded boundaries when static encoded types are intentionally
 *   erased: {@link encodeUnknown} and {@link decodeUnknown}
 * - Wrap a bidirectional encoded channel with typed input and output schemas:
 *   {@link duplex} or {@link duplexUnknown}
 *
 * **Gotchas**
 *
 * - These helpers operate on `NonEmptyReadonlyArray` chunks, so schemas are
 *   applied to non-empty batches rather than individual scalar values
 * - Encoding and decoding can require services from the schema; those
 *   requirements become part of the resulting channel type
 * - `duplex` encodes values flowing into the wrapped channel and decodes values
 *   emitted by it, so choose `inputSchema` and `outputSchema` from the
 *   perspective of the typed caller
 *
 * @since 4.0.0
 */
import type * as Arr from "./Array.ts"
import * as Channel from "./Channel.ts"
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import * as Schema from "./Schema.ts"

/**
 * Creates a channel that encodes non-empty chunks of schema values into the
 * schema's encoded representation.
 *
 * **Details**
 *
 * Encoding failures are emitted as `SchemaError`, and any encoding services
 * required by the schema become channel requirements.
 *
 * @category constructors
 * @since 4.0.0
 */
export const encode = <S extends Schema.Top>(
  schema: S
) =>
<IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<S["Encoded"]>,
  IE | Schema.SchemaError,
  Done,
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  IE,
  Done,
  S["EncodingServices"]
> => {
  const encode = Schema.encodeEffect(Schema.NonEmptyArray(schema))
  return Channel.fromTransform((upstream, _scope) => Effect.succeed(Effect.flatMap(upstream, (chunk) => encode(chunk))))
}

/**
 * Creates an `encode` channel variant whose encoded output chunks are typed as
 * `unknown`.
 *
 * **When to use**
 *
 * Use this at channel boundaries where the encoded representation is
 * intentionally untyped, while still encoding typed input chunks with the
 * provided schema.
 *
 * @category constructors
 * @since 4.0.0
 */
export const encodeUnknown: <S extends Schema.Top>(
  schema: S
) => <IE = never, Done = unknown>() => Channel.Channel<
  Arr.NonEmptyReadonlyArray<unknown>,
  IE | Schema.SchemaError,
  Done,
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  IE,
  Done,
  S["EncodingServices"]
> = encode

/**
 * Creates a channel that decodes non-empty chunks from the schema's encoded
 * representation into schema values.
 *
 * **Details**
 *
 * Decoding failures are emitted as `SchemaError`, and any decoding services
 * required by the schema become channel requirements.
 *
 * @category constructors
 * @since 4.0.0
 */
export const decode = <S extends Schema.Top>(
  schema: S
) =>
<IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  IE | Schema.SchemaError,
  Done,
  Arr.NonEmptyReadonlyArray<S["Encoded"]>,
  IE,
  Done,
  S["DecodingServices"]
> => {
  const decode = Schema.decodeEffect(Schema.NonEmptyArray(schema))
  return Channel.fromTransform((upstream, _scope) => Effect.succeed(Effect.flatMap(upstream, (chunk) => decode(chunk))))
}

/**
 * Creates a `decode` channel variant for schema-decoding channel boundaries.
 *
 * **Details**
 *
 * The channel decodes non-empty encoded chunks into schema values, emits
 * `SchemaError` when decoding fails, and requires the schema's decoding
 * services.
 *
 * @category constructors
 * @since 4.0.0
 */
export const decodeUnknown: <S extends Schema.Top>(
  schema: S
) => <IE = never, Done = unknown>() => Channel.Channel<
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  IE | Schema.SchemaError,
  Done,
  Arr.NonEmptyReadonlyArray<S["Encoded"]>,
  IE,
  Done,
  S["DecodingServices"]
> = decode

/**
 * Wraps a channel so callers work with typed input and output chunks while the
 * wrapped channel uses encoded chunks.
 *
 * **Details**
 *
 * Values sent into the resulting channel are encoded with `inputSchema` before
 * reaching the wrapped channel. Values emitted by the wrapped channel are
 * decoded with `outputSchema` before they are emitted downstream. Schema
 * failures are surfaced as `SchemaError`.
 *
 * @category combinators
 * @since 4.0.0
 */
export const duplex: {
  <In extends Schema.Top, Out extends Schema.Top>(options: {
    readonly inputSchema: In
    readonly outputSchema: Out
  }): <OutErr, OutDone, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<Out["Encoded"]>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<In["Encoded"]>,
      Schema.SchemaError | InErr,
      InDone,
      R
    >
  ) => Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
  <Out extends Schema.Top, OutErr, OutDone, In extends Schema.Top, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<Out["Encoded"]>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<In["Encoded"]>,
      Schema.SchemaError | InErr,
      InDone,
      R
    >,
    options: {
      readonly inputSchema: In
      readonly outputSchema: Out
    }
  ): Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
} = dual(2, <Out extends Schema.Top, OutErr, OutDone, In extends Schema.Top, InErr, InDone, R>(
  self: Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Encoded"]>,
    OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Encoded"]>,
    Schema.SchemaError | InErr,
    InDone,
    R
  >,
  options: {
    readonly inputSchema: In
    readonly outputSchema: Out
  }
): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Out["Type"]>,
  Schema.SchemaError | OutErr,
  OutDone,
  Arr.NonEmptyReadonlyArray<In["Type"]>,
  InErr,
  InDone,
  R | In["EncodingServices"] | Out["DecodingServices"]
> =>
  encode(options.inputSchema)<InErr, InDone>().pipe(
    Channel.pipeTo(self),
    Channel.pipeTo(decode(options.outputSchema)())
  ))

/**
 * Like `duplex`, but for channels whose encoded side is not statically typed.
 *
 * **Details**
 *
 * The resulting channel accepts typed input chunks, encodes them with
 * `inputSchema`, decodes unknown output chunks with `outputSchema`, and
 * surfaces schema failures as `SchemaError`.
 *
 * @category combinators
 * @since 4.0.0
 */
export const duplexUnknown: {
  <In extends Schema.Top, Out extends Schema.Top>(options: {
    readonly inputSchema: In
    readonly outputSchema: Out
  }): <OutErr, OutDone, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<unknown>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<any>,
      Schema.SchemaError | InErr,
      InDone,
      R
    >
  ) => Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
  <Out extends Schema.Top, OutErr, OutDone, In extends Schema.Top, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<unknown>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<any>,
      Schema.SchemaError | InErr,
      InDone,
      R
    >,
    options: {
      readonly inputSchema: In
      readonly outputSchema: Out
    }
  ): Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
} = duplex
