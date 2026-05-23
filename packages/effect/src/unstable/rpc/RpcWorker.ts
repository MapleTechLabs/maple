/**
 * Helpers for passing a schema-encoded bootstrap message to worker-backed RPC
 * protocols.
 *
 * Worker RPC protocols can send one initial message when each worker starts,
 * before ordinary RPC requests begin flowing. Use this module to build and
 * provide that message from the client side, and to decode it inside the
 * worker-side server. Common payloads include per-worker configuration,
 * credentials or session metadata, feature flags, preloaded data, or
 * transferable resources such as `ArrayBuffer` and `MessagePort` values.
 *
 * The initial message uses the supplied schema's JSON codec and is posted as a
 * worker message, so it is separate from the normal `RpcSerialization` used for
 * RPC request and response traffic. Values still need to be valid for the
 * worker transport's structured clone boundary. Transferable annotations can
 * collect objects for the `postMessage` transfer list, but transferring moves
 * ownership to the worker and may detach buffers from the sender.
 *
 * @since 4.0.0
 */
import type { NoSuchElementError } from "../../Cause.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as Schema from "../../Schema.ts"
import * as Transferable from "../workers/Transferable.ts"
import type { Protocol } from "./RpcServer.ts"

/**
 * Context service that supplies the initial RPC worker message as encoded data
 * paired with any transferables that should be posted with it.
 *
 * @category initial message
 * @since 4.0.0
 */
export class InitialMessage extends Context.Service<
  InitialMessage,
  Effect.Effect<
    readonly [
      data: unknown,
      transfers: ReadonlyArray<Transferable>
    ]
  >
>()("effect/rpc/RpcWorker/InitialMessage") {}

/**
 * Types related to the encoded initial message exchanged with an RPC worker.
 *
 * @since 4.0.0
 */
export declare namespace InitialMessage {
  /**
   * Tagged wire representation of an RPC worker initial message after schema
   * encoding.
   *
   * @category initial message
   * @since 4.0.0
   */
  export interface Encoded {
    readonly _tag: "InitialMessage"
    readonly value: unknown
  }
}

const ProtocolTag = Context.Service<Protocol, Protocol["Service"]>(
  "effect/rpc/RpcServer/Protocol" satisfies Protocol["key"]
)

/**
 * Runs an effect, encodes its result with the schema's JSON codec, and returns
 * the encoded value together with collected transferables.
 *
 * @category initial message
 * @since 4.0.0
 */
export const makeInitialMessage = <S extends Schema.Top, E, R2>(
  schema: S,
  effect: Effect.Effect<S["Type"], E, R2>
): Effect.Effect<
  readonly [data: unknown, transferables: ReadonlyArray<globalThis.Transferable>],
  E | Schema.SchemaError,
  S["EncodingServices"] | R2
> => {
  const schemaJson = Schema.toCodecJson(schema)
  return Effect.flatMap(effect, (value) => {
    const collector = Transferable.makeCollectorUnsafe()
    return Schema.encodeEffect(schemaJson)(value).pipe(
      Effect.provideService(Transferable.Collector, collector),
      Effect.map((encoded) => [encoded, collector.clearUnsafe()] as const)
    )
  })
}

/**
 * Provides the `InitialMessage` service from a schema and build effect,
 * capturing the layer context and dying if schema encoding fails.
 *
 * @category initial message
 * @since 4.0.0
 */
export const layerInitialMessage = <S extends Schema.Top, R2>(
  schema: S,
  build: Effect.Effect<S["Type"], never, R2>
): Layer.Layer<InitialMessage, never, S["EncodingServices"] | R2> =>
  Layer.effect(InitialMessage)(
    Effect.contextWith((context: Context.Context<S["EncodingServices"] | R2>) =>
      Effect.succeed(
        Effect.provideContext(Effect.orDie(makeInitialMessage(schema, build)), context)
      )
    )
  )

/**
 * Reads the protocol initial message and decodes it with the supplied schema,
 * failing if no initial message is available or decoding fails.
 *
 * @category initial message
 * @since 4.0.0
 */
export const initialMessage = <S extends Schema.Top>(
  schema: S
): Effect.Effect<S["Type"], NoSuchElementError | Schema.SchemaError, Protocol | S["DecodingServices"]> =>
  ProtocolTag.pipe(
    Effect.flatMap((protocol) => protocol.initialMessage),
    Effect.flatMap(Effect.fromOption),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema)))
  )
