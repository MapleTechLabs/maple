/**
 * Utilities for marking the parts of worker messages that should be transferred
 * through `postMessage` instead of copied by the structured clone algorithm.
 *
 * This module is used with worker message schemas to collect
 * `globalThis.Transferable` values while encoding a message, so the worker
 * platform can pass the collected list as the `postMessage` transfer list.
 * Common cases include sending large `Uint8Array` payloads, `ImageData` pixel
 * buffers, or `MessagePort` channels without paying for an extra copy.
 *
 * Transferable annotations do not make an otherwise unsupported value
 * structured-cloneable; the encoded message still has to be valid for
 * `postMessage`. Transferring also moves ownership to the receiver, so buffers
 * are detached from the sender after the send completes. Be careful when a
 * typed array view shares a backing buffer with other data, since collecting
 * that buffer transfers ownership of the whole buffer.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import { dual } from "../../Function.ts"
import * as Schema from "../../Schema.ts"
import * as Getter from "../../SchemaGetter.ts"

/**
 * Service for collecting `Transferable` objects while encoding worker messages
 * so they can be passed to `postMessage` transfer lists.
 *
 * @category models
 * @since 4.0.0
 */
export class Collector extends Context.Service<Collector, {
  readonly addAll: (
    _: Iterable<globalThis.Transferable>
  ) => Effect.Effect<void>
  readonly addAllUnsafe: (_: Iterable<globalThis.Transferable>) => void
  readonly read: Effect.Effect<Array<globalThis.Transferable>>
  readonly readUnsafe: () => Array<globalThis.Transferable>
  readonly clearUnsafe: () => Array<globalThis.Transferable>
  readonly clear: Effect.Effect<Array<globalThis.Transferable>>
}>()("effect/workers/Transferable/Collector") {}

/**
 * Creates a mutable `Collector` service directly, exposing unsafe synchronous
 * methods for reading, adding, and clearing collected transferables.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeCollectorUnsafe = (): Collector["Service"] => {
  let tranferables: Array<globalThis.Transferable> = []
  const unsafeAddAll = (transfers: Iterable<globalThis.Transferable>): void => {
    tranferables.push(...transfers)
  }
  const unsafeRead = (): Array<globalThis.Transferable> => tranferables
  const unsafeClear = (): Array<globalThis.Transferable> => {
    const prev = tranferables
    tranferables = []
    return prev
  }
  return Collector.of({
    addAllUnsafe: unsafeAddAll,
    addAll: (transferables) => Effect.sync(() => unsafeAddAll(transferables)),
    readUnsafe: unsafeRead,
    read: Effect.sync(unsafeRead),
    clearUnsafe: unsafeClear,
    clear: Effect.sync(unsafeClear)
  })
}

/**
 * Effect that creates a fresh `Collector` service for accumulating
 * transferables.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeCollector: Effect.Effect<Collector["Service"]> = Effect.sync(makeCollectorUnsafe)

/**
 * Adds transferables to the current `Collector` when one is present in the
 * context, and does nothing otherwise.
 *
 * @category accessors
 * @since 4.0.0
 */
export const addAll = (
  tranferables: Iterable<globalThis.Transferable>
): Effect.Effect<void> =>
  Effect.contextWith((services) => {
    const collector = Context.getOrUndefined(services, Collector)
    if (!collector) return Effect.void
    collector.addAllUnsafe(tranferables)
    return Effect.void
  })

/**
 * Creates a schema getter that records transferables derived from a value in
 * the current `Collector` while passing the value through unchanged.
 *
 * @category Getter
 * @since 4.0.0
 */
export const getterAddAll = <A>(
  f: (_: A) => Iterable<globalThis.Transferable>
): Getter.Getter<A, A> =>
  Getter.transformOrFail((e: A) =>
    Effect.contextWith((services) => {
      const collector = Context.getOrUndefined(services, Collector)
      if (!collector) return Effect.succeed(e)
      collector.addAllUnsafe(f(e))
      return Effect.succeed(e)
    })
  )

/**
 * Schema wrapper whose encode path can record transferables with a `Collector`
 * while preserving the wrapped schema's decoded type.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface Transferable<S extends Schema.Top> extends
  Schema.decodeTo<
    Schema.toType<S["Rebuild"]>,
    S["Rebuild"]
  >
{}

/**
 * Wraps a schema so encoding records transferables selected from the encoded
 * value, enabling worker messages to populate a `postMessage` transfer list.
 *
 * @category schemas
 * @since 4.0.0
 */
export const schema: {
  <S extends Schema.Top>(
    f: (_: S["Encoded"]) => Iterable<globalThis.Transferable>
  ): (self: S) => Transferable<S>
  <S extends Schema.Top>(
    self: S,
    f: (_: S["Encoded"]) => Iterable<globalThis.Transferable>
  ): Transferable<S>
} = dual(
  2,
  <S extends Schema.Top>(
    self: S,
    f: (_: S["Encoded"]) => Iterable<globalThis.Transferable>
  ): Transferable<S> =>
    self.annotate({
      toCodecJson: () => passthroughLink
    }).pipe(
      Schema.decode({
        decode: Getter.passthrough(),
        encode: getterAddAll(f)
      })
    )
)

const passthroughLink = Schema.link()(Schema.Any, {
  decode: Getter.passthrough(),
  encode: Getter.passthrough()
})

/**
 * Transferable schema for `ImageData` values that records the underlying pixel
 * data buffer.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ImageData: Transferable<Schema.declare<ImageData>> = schema(
  Schema.Any as any as Schema.declare<globalThis.ImageData>,
  (_) => [_.data.buffer]
)

/**
 * Transferable schema for `MessagePort` values that records the port itself as
 * transferable.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MessagePort: Transferable<Schema.declare<MessagePort>> = schema(
  Schema.Any as any as Schema.declare<MessagePort>,
  (_) => [_]
)

/**
 * Transferable schema for `Uint8Array` values that records the array's backing
 * buffer.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Uint8Array: Transferable<Schema.instanceOf<globalThis.Uint8Array<ArrayBuffer>>> = schema(
  Schema.Uint8Array as any,
  (_) => [_.buffer]
)
