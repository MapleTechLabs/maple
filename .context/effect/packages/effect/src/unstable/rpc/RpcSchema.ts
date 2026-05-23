/**
 * The `RpcSchema` module contains the RPC-specific schema markers and cause
 * annotations shared by the RPC declaration, client, and server layers. It is
 * used when an RPC response is a `Stream`, and when server-side interruption
 * logic needs to identify a client-initiated abort.
 *
 * Use {@link Stream} to mark an RPC success schema as a streamed response,
 * {@link isStreamSchema} to detect that marker, and the stored success and
 * error schemas to encode or decode stream chunks. Request payload schemas live
 * on the `Rpc` definition itself; this module only describes the streamed
 * response shape. For streaming RPCs, the success schema passed to
 * `RpcSchema.Stream` is the stream element schema, while the error schema is
 * the stream error schema. When the marker is installed by the `Rpc`
 * constructor's `stream` option, the immediate RPC exit succeeds with `void`,
 * the ordinary RPC error schema is set to `Schema.Never`, and the stream error
 * schema is used for stream failures.
 *
 * Streaming schemas are not general-purpose codecs for arbitrary stream values:
 * they are RPC metadata that lets the protocol distinguish one-shot successes
 * from streamed elements and keep stream errors on the chunk stream. Use
 * {@link ClientAbort} when annotating interruptions caused by a remote client
 * closing or cancelling a request.
 *
 * @since 4.0.0
 */
import * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import { constUndefined } from "../../Function.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import type * as AST from "../../SchemaAST.ts"
import * as Stream_ from "../../Stream.ts"

const StreamSchemaTypeId = "~effect/rpc/RpcSchema/StreamSchema"

/**
 * Returns `true` when a schema is an RPC stream schema created by
 * `RpcSchema.Stream`.
 *
 * @category Stream
 * @since 4.0.0
 */
export function isStreamSchema(schema: Schema.Top): schema is Stream<Schema.Top, Schema.Top> {
  return Predicate.hasProperty(schema, StreamSchemaTypeId)
}

/** @internal */
export function getStreamSchemas(schema: Schema.Top): Option.Option<{
  readonly success: Schema.Top
  readonly error: Schema.Top
}> {
  return isStreamSchema(schema) ?
    Option.some({
      success: schema.success,
      error: schema.error
    }) :
    Option.none()
}

/**
 * A schema marker for RPC streaming responses, storing the success element
 * schema and stream error schema used for encoding and decoding stream chunks.
 *
 * @category Stream
 * @since 4.0.0
 */
export interface Stream<A extends Schema.Top, E extends Schema.Top> extends
  Schema.Bottom<
    Stream_.Stream<A["Type"], E["Type"]>,
    Stream_.Stream<A["Encoded"], E["Encoded"]>,
    A["DecodingServices"] | E["DecodingServices"],
    A["EncodingServices"] | E["EncodingServices"],
    AST.Declaration,
    Stream<A, E>
  >
{
  readonly "Rebuild": Stream<A, E>
  readonly [StreamSchemaTypeId]: typeof StreamSchemaTypeId
  readonly success: A
  readonly error: E
}

const schema = Schema.declare(Stream_.isStream)

/**
 * Creates an RPC stream schema from a stream element success schema and stream
 * error schema.
 *
 * @category Stream
 * @since 4.0.0
 */
export function Stream<A extends Schema.Top, E extends Schema.Top>(success: A, error: E): Stream<A, E> {
  return Schema.make(schema.ast, { [StreamSchemaTypeId]: StreamSchemaTypeId, success, error })
}

/**
 * Cause annotation used to mark interruptions that originate from an RPC client
 * abort.
 *
 * @category Cause annotations
 * @since 4.0.0
 */
export class ClientAbort extends Context.Service<ClientAbort, true>()("effect/rpc/RpcSchema/ClientAbort") {
  static annotation = this.context(true).pipe(
    Context.add(Cause.StackTrace, {
      name: "ClientAbort",
      stack: constUndefined,
      parent: undefined
    })
  )
}
