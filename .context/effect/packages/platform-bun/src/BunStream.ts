/**
 * Bun stream interoperability for Effect streams.
 *
 * This module provides Bun-specific adapters for working with streaming data at
 * the boundary between Bun APIs and Effect. It re-exports the shared Node stream
 * adapters for Bun's Node-compatible stream APIs, and adds an optimized
 * `ReadableStream` constructor that uses Bun's `readMany` support to pull
 * batches of Web Stream values into an Effect `Stream`.
 *
 * Common uses include adapting Bun `Request` and `Response` bodies, multipart
 * uploads, and other Web `ReadableStream` sources so they can be transformed,
 * decoded, or piped with Effect stream operators. Pulling from the Effect stream
 * drives reads from the underlying reader, while Bun and the Web Streams runtime
 * still control their own internal buffering and source backpressure.
 *
 * Web `ReadableStream` readers take an exclusive lock on the source. Request and
 * response bodies are also one-shot: once consumed they become disturbed and
 * should not be read through another API. The adapter cancels the reader when
 * the consuming scope is finalized by default; set `releaseLockOnEnd` when the
 * stream is externally owned and should only have its lock released. Read errors
 * are mapped through the provided `onError` function.
 *
 * @since 4.0.0
 */
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Effect from "effect/Effect"
import type { LazyArg } from "effect/Function"
import type * as Pull from "effect/Pull"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

/**
 * @since 4.0.0
 */
export * from "@effect/platform-node-shared/NodeStream"

/**
 * An optimized version of `Stream.fromReadableStream` that uses the Bun
 * .readMany API to read multiple values at once from a `ReadableStream`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromReadableStream = <A, E>(
  options: {
    readonly evaluate: LazyArg<ReadableStream<A>>
    readonly onError: (error: unknown) => E
    readonly releaseLockOnEnd?: boolean | undefined
  }
): Stream.Stream<A, E> =>
  Stream.fromChannel(Channel.fromTransform(Effect.fnUntraced(function*(_, scope) {
    const reader = options.evaluate().getReader()
    yield* Scope.addFinalizer(
      scope,
      options.releaseLockOnEnd ? Effect.sync(() => reader.releaseLock()) : Effect.promise(() => reader.cancel())
    )
    const readMany = Effect.callback<Bun.ReadableStreamDefaultReadManyResult<A>, E>((resume) => {
      const result = reader.readMany()
      if ("then" in result) {
        result.then((_) => resume(Effect.succeed(_)), (e) => resume(Effect.fail(options.onError(e))))
      } else {
        resume(Effect.succeed(result))
      }
    })
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.flatMap(
      readMany,
      function loop(
        { done, value }
      ): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E> {
        if (done) {
          return Cause.done()
        } else if (!Arr.isReadonlyArrayNonEmpty(value)) {
          return Effect.flatMap(readMany, loop)
        }
        return Effect.succeed(value)
      }
    )
  })))
