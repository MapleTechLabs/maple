/**
 * Bun stream interoperability for Effect streams.
 *
 * This module is the Bun entry point for adapting runtime streams into Effect's
 * streaming model. It re-exports the shared Node stream adapters for Bun's
 * Node-compatible stream APIs and adds {@link fromReadableStream}, a Web
 * `ReadableStream` adapter that uses Bun's `readMany` reader method to pull
 * batches of values into an Effect `Stream`.
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
 * Creates a stream from a `ReadableStream` using Bun's optimized `.readMany`
 * API.
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
