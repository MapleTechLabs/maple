/**
 * This module provides utilities for working with `Deferred`, a powerful concurrency
 * primitive that represents an asynchronous variable that can be set exactly once.
 * Multiple fibers can await the same `Deferred` and will all be notified when it
 * completes.
 *
 * A `Deferred<A, E>` can be:
 * - **Completed successfully** with a value of type `A`
 * - **Failed** with an error of type `E`
 * - **Interrupted** if the fiber setting it is interrupted
 *
 * Key characteristics:
 * - **Single assignment**: Can only be completed once
 * - **Multiple waiters**: Many fibers can await the same `Deferred`
 * - **Fiber-safe**: Thread-safe operations across concurrent fibers
 * - **Composable**: Works seamlessly with other Effect operations
 *
 * **Example** (Coordinating fibers with a Deferred)
 *
 * ```ts
 * import { Deferred, Effect, Fiber } from "effect"
 *
 * // Basic usage: coordinate between fibers
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<string, never>()
 *
 *   // Fiber 1: waits for the value
 *   const waiter = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       const value = yield* Deferred.await(deferred)
 *       console.log("Received:", value)
 *       return value
 *     })
 *   )
 *
 *   // Fiber 2: sets the value after a delay
 *   const setter = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("1 second")
 *       yield* Deferred.succeed(deferred, "Hello from setter!")
 *     })
 *   )
 *
 *   // Wait for both fibers
 *   yield* Fiber.join(waiter)
 *   yield* Fiber.join(setter)
 * })
 *
 * // Producer-consumer pattern
 * const producerConsumer = Effect.gen(function*() {
 *   const buffer = yield* Deferred.make<Array<number>, never>()
 *
 *   const producer = Effect.gen(function*() {
 *     const data = [1, 2, 3, 4, 5]
 *     yield* Deferred.succeed(buffer, data)
 *   })
 *
 *   const consumer = Effect.gen(function*() {
 *     const data = yield* Deferred.await(buffer)
 *     return data.reduce((sum, n) => sum + n, 0)
 *   })
 *
 *   const [, result] = yield* Effect.all([producer, consumer])
 *   return result // 15
 * })
 * ```
 *
 * @since 2.0.0
 */
import type * as Cause from "./Cause.ts"
import type { Effect } from "./Effect.ts"
import type * as Exit from "./Exit.ts"
import { dual, identity, type LazyArg } from "./Function.ts"
import * as core from "./internal/core.ts"
import * as internalEffect from "./internal/effect.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Types from "./Types.ts"

const TypeId = "~effect/Deferred"

/**
 * A `Deferred` represents an asynchronous variable that can be set exactly
 * once, with the ability for an arbitrary number of fibers to suspend (by
 * calling `Deferred.await`) and automatically resume when the variable is set.
 *
 * **When to use**
 *
 * Use `Deferred` for primitive actions whose completions require the
 * coordinated action of multiple fibers, and for building higher-level
 * concurrent or asynchronous structures.
 *
 * **Example** (Creating a Deferred for inter-fiber communication)
 *
 * ```ts
 * import { Deferred, Effect, Fiber } from "effect"
 *
 * // Create and use a Deferred for inter-fiber communication
 * const program = Effect.gen(function*() {
 *   // Create a Deferred that will hold a string value
 *   const deferred: Deferred.Deferred<string> = yield* Deferred.make<string>()
 *
 *   // Fork a fiber that will set the deferred value
 *   const producer = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("100 millis")
 *       yield* Deferred.succeed(deferred, "Hello, World!")
 *     })
 *   )
 *
 *   // Fork a fiber that will await the deferred value
 *   const consumer = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       const value = yield* Deferred.await(deferred)
 *       console.log("Received:", value)
 *       return value
 *     })
 *   )
 *
 *   // Wait for both fibers to complete
 *   yield* Fiber.join(producer)
 *   const result = yield* Fiber.join(consumer)
 *   return result
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Deferred<in out A, in out E = never> extends Deferred.Variance<A, E>, Pipeable {
  effect?: Effect<A, E>
  resumes?: Array<(effect: Effect<A, E>) => void> | undefined
}

/**
 * Checks whether a value is a `Deferred`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isDeferred = <A, E>(u: unknown): u is Deferred<A, E> => hasProperty(u, TypeId)

/**
 * Companion namespace containing type-level metadata for `Deferred`.
 *
 * @since 2.0.0
 */
export declare namespace Deferred {
  /**
   * Type-level variance marker for the value and error channels of `Deferred`.
   *
   * **Details**
   *
   * This interface is part of the public type structure and is not intended to
   * be constructed directly.
   *
   * @category models
   * @since 2.0.0
   */
  export interface Variance<in out A, in out E> {
    readonly [TypeId]: {
      readonly _A: Types.Invariant<A>
      readonly _E: Types.Invariant<E>
    }
  }
}

const DeferredProto = {
  [TypeId]: {
    _A: identity,
    _E: identity
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * Synchronously creates an empty `Deferred` outside the `Effect` runtime.
 *
 * **When to use**
 *
 * Prefer `Deferred.make` in effectful code so allocation is represented in
 * `Effect`; use this only when direct synchronous allocation is required.
 *
 * **Example** (Creating a Deferred unsafely)
 *
 * ```ts
 * import { Deferred } from "effect"
 *
 * const deferred = Deferred.makeUnsafe<number>()
 * console.log(deferred)
 * ```
 *
 * @category unsafe
 * @since 4.0.0
 */
export const makeUnsafe = <A, E = never>(): Deferred<A, E> => {
  const self = Object.create(DeferredProto)
  self.resumes = undefined
  self.effect = undefined
  return self
}

/**
 * Creates a new `Deferred`.
 *
 * **Example** (Creating a Deferred)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   yield* Deferred.succeed(deferred, 42)
 *   const value = yield* Deferred.await(deferred)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = <A, E = never>(): Effect<Deferred<A, E>> => internalEffect.sync(() => makeUnsafe())

const _await = <A, E>(self: Deferred<A, E>): Effect<A, E> =>
  internalEffect.callback<A, E>((resume) => {
    if (self.effect) return resume(self.effect)
    self.resumes ??= []
    self.resumes.push(resume)
    return internalEffect.sync(() => {
      const index = self.resumes!.indexOf(resume)
      self.resumes!.splice(index, 1)
    })
  })

export {
  /**
   * Retrieves the value of the `Deferred`, suspending the fiber running the
   * workflow until the result is available.
   *
   * **Example** (Awaiting a Deferred value)
   *
   * ```ts
   * import { Deferred, Effect } from "effect"
   *
   * const program = Effect.gen(function*() {
   *   const deferred = yield* Deferred.make<number>()
   *   yield* Deferred.succeed(deferred, 42)
   *
   *   const value = yield* Deferred.await(deferred)
   *   console.log(value) // 42
   * })
   * ```
   *
   * @category getters
   * @since 2.0.0
   */
  _await as await
}

/**
 * Runs the supplied `Effect` and attempts to complete the `Deferred` with its
 * memoized result.
 *
 * **When to use**
 *
 * Use `Deferred.complete` when the effect should be evaluated once and the
 * resulting `Exit` memoized. Use `Deferred.completeWith` when you need to store
 * an effect directly without memoizing its result.
 *
 * **Details**
 *
 * The returned effect succeeds with `true` when this call completed the
 * `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Completing a Deferred from an effect)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   const completed = yield* Deferred.complete(deferred, Effect.succeed(42))
 *   console.log(completed) // true
 *
 *   const value = yield* Deferred.await(deferred)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const complete: {
  <A, E, R>(effect: Effect<A, E, R>): (self: Deferred<A, E>) => Effect<boolean, never, R>
  <A, E, R>(self: Deferred<A, E>, effect: Effect<A, E, R>): Effect<boolean, never, R>
} = dual(
  2,
  <A, E, R>(self: Deferred<A, E>, effect: Effect<A, E, R>): Effect<boolean, never, R> =>
    internalEffect.suspend(() => self.effect ? internalEffect.succeed(false) : into(effect, self))
)

/**
 * Completes the deferred with the result of the specified effect. If the
 * deferred has already been completed, the method will produce false.
 *
 * **Example** (Completing a Deferred with an effect)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   const completed = yield* Deferred.completeWith(deferred, Effect.succeed(42))
 *   console.log(completed) // true
 *
 *   const value = yield* Deferred.await(deferred)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const completeWith: {
  <A, E>(effect: Effect<A, E>): (self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, effect: Effect<A, E>): Effect<boolean>
} = dual(
  2,
  <A, E>(self: Deferred<A, E>, effect: Effect<A, E>): Effect<boolean> =>
    internalEffect.sync(() => doneUnsafe(self, effect))
)

/**
 * Exits the `Deferred` with the specified `Exit` value, which will be
 * propagated to all fibers waiting on the value of the `Deferred`.
 *
 * **Example** (Completing a Deferred with an Exit)
 *
 * ```ts
 * import { Deferred, Effect, Exit } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   yield* Deferred.done(deferred, Exit.succeed(42))
 *
 *   const value = yield* Deferred.await(deferred)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const done: {
  <A, E>(exit: Exit.Exit<A, E>): (self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, exit: Exit.Exit<A, E>): Effect<boolean>
} = completeWith as any

/**
 * Attempts to complete the `Deferred` with the specified error.
 *
 * **Details**
 *
 * Fibers waiting on the `Deferred` fail with that error only if this call
 * completes it. The returned effect succeeds with `true` when this call
 * completed the `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Failing a Deferred with an error)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number, string>()
 *   const success = yield* Deferred.fail(deferred, "Operation failed")
 *   console.log(success) // true
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const fail: {
  <E>(error: E): <A>(self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, error: E): Effect<boolean>
} = dual(2, <A, E>(self: Deferred<A, E>, error: E): Effect<boolean> => done(self, core.exitFail(error)))

/**
 * Computes an error when the returned effect is run, then attempts to complete
 * the `Deferred` with that error.
 *
 * **Details**
 *
 * Fibers waiting on the `Deferred` fail with the computed error only if this
 * call completes it. The returned effect succeeds with `true` when this call
 * completed the `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Failing a Deferred with a lazy error)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number, string>()
 *   const success = yield* Deferred.failSync(deferred, () => "Lazy error")
 *   console.log(success) // true
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const failSync: {
  <E>(evaluate: LazyArg<E>): <A>(self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, evaluate: LazyArg<E>): Effect<boolean>
} = dual(
  2,
  <A, E>(self: Deferred<A, E>, evaluate: LazyArg<E>): Effect<boolean> =>
    internalEffect.suspend(() => fail(self, evaluate()))
)

/**
 * Attempts to complete the `Deferred` with the specified `Cause`.
 *
 * **Details**
 *
 * Fibers waiting on the `Deferred` observe that cause only if this call
 * completes it. The returned effect succeeds with `true` when this call
 * completed the `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Failing a Deferred with a Cause)
 *
 * ```ts
 * import { Cause, Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number, string>()
 *   const success = yield* Deferred.failCause(
 *     deferred,
 *     Cause.fail("Operation failed")
 *   )
 *   console.log(success) // true
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const failCause: {
  <E>(cause: Cause.Cause<E>): <A>(self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, cause: Cause.Cause<E>): Effect<boolean>
} = dual(
  2,
  <A, E>(self: Deferred<A, E>, cause: Cause.Cause<E>): Effect<boolean> => done(self, core.exitFailCause(cause))
)

/**
 * Computes a `Cause` when the returned effect is run, then attempts to
 * complete the `Deferred` with that cause.
 *
 * **Details**
 *
 * Fibers waiting on the `Deferred` observe the computed cause only if this
 * call completes it. The returned effect succeeds with `true` when this call
 * completed the `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Failing a Deferred with a lazy Cause)
 *
 * ```ts
 * import { Cause, Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number, string>()
 *   const success = yield* Deferred.failCauseSync(
 *     deferred,
 *     () => Cause.fail("Lazy error")
 *   )
 *   console.log(success) // true
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const failCauseSync: {
  <E>(evaluate: LazyArg<Cause.Cause<E>>): <A>(self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, evaluate: LazyArg<Cause.Cause<E>>): Effect<boolean>
} = dual(
  2,
  <A, E>(self: Deferred<A, E>, evaluate: LazyArg<Cause.Cause<E>>): Effect<boolean> =>
    internalEffect.suspend(() => failCause(self, evaluate()))
)

/**
 * Attempts to complete the `Deferred` with a defect.
 *
 * **Details**
 *
 * Fibers waiting on the `Deferred` die with that defect only if this call
 * completes it. The returned effect succeeds with `true` when this call
 * completed the `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Killing a Deferred with a defect)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   const success = yield* Deferred.die(
 *     deferred,
 *     new Error("Something went wrong")
 *   )
 *   console.log(success) // true
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const die: {
  (defect: unknown): <A, E>(self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, defect: unknown): Effect<boolean>
} = dual(2, <A, E>(self: Deferred<A, E>, defect: unknown): Effect<boolean> => done(self, core.exitDie(defect)))

/**
 * Computes a defect when the returned effect is run, then attempts to complete
 * the `Deferred` with that defect.
 *
 * **Details**
 *
 * Fibers waiting on the `Deferred` die with the computed defect only if this
 * call completes it. The returned effect succeeds with `true` when this call
 * completed the `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Killing a Deferred with a lazy defect)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   const success = yield* Deferred.dieSync(
 *     deferred,
 *     () => new Error("Lazy error")
 *   )
 *   console.log(success) // true
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const dieSync: {
  (evaluate: LazyArg<unknown>): <A, E>(self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, evaluate: LazyArg<unknown>): Effect<boolean>
} = dual(
  2,
  <A, E>(self: Deferred<A, E>, evaluate: LazyArg<unknown>): Effect<boolean> =>
    internalEffect.suspend(() => die(self, evaluate()))
)

/**
 * Attempts to complete the `Deferred` with interruption by the current fiber.
 *
 * **Details**
 *
 * Fibers waiting on the `Deferred` are interrupted with the current fiber id
 * only if this call completes it. The returned effect succeeds with `true`
 * when this call completed the `Deferred`, or `false` if it was already
 * completed.
 *
 * **Example** (Interrupting a Deferred)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   const success = yield* Deferred.interrupt(deferred)
 *   console.log(success) // true
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const interrupt = <A, E>(self: Deferred<A, E>): Effect<boolean> =>
  core.withFiber((fiber) => interruptWith(self, fiber.id))

/**
 * Attempts to complete the `Deferred` with interruption by the specified
 * `FiberId`.
 *
 * **Details**
 *
 * Fibers waiting on the `Deferred` are interrupted with that fiber id only if
 * this call completes it. The returned effect succeeds with `true` when this
 * call completed the `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Interrupting a Deferred with a fiber id)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   const success = yield* Deferred.interruptWith(deferred, 42)
 *   console.log(success) // true
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const interruptWith: {
  (fiberId: number): <A, E>(self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, fiberId: number): Effect<boolean>
} = dual(
  2,
  <A, E>(self: Deferred<A, E>, fiberId: number): Effect<boolean> =>
    failCause(self, internalEffect.causeInterrupt(fiberId))
)

/**
 * Returns `true` if this `Deferred` has already been completed with a value or
 * an error, `false` otherwise.
 *
 * **Example** (Checking Deferred completion)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   const beforeCompletion = yield* Deferred.isDone(deferred)
 *   console.log(beforeCompletion) // false
 *
 *   yield* Deferred.succeed(deferred, 42)
 *   const afterCompletion = yield* Deferred.isDone(deferred)
 *   console.log(afterCompletion) // true
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const isDone = <A, E>(self: Deferred<A, E>): Effect<boolean> => internalEffect.sync(() => isDoneUnsafe(self))

/**
 * Returns `true` if this `Deferred` has already been completed with a value or
 * an error, `false` otherwise.
 *
 * @category getters
 * @since 4.0.0
 */
export const isDoneUnsafe = <A, E>(self: Deferred<A, E>): boolean => self.effect !== undefined

/**
 * Returns the current completion effect as an `Option`. This returns
 * `Option.some(effect)` when the `Deferred` is completed, `Option.none()`
 * otherwise.
 *
 * **Example** (Polling Deferred completion)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   const beforeCompletion = yield* Deferred.poll(deferred)
 *   console.log(beforeCompletion._tag === "None") // true
 *
 *   yield* Deferred.succeed(deferred, 42)
 *   const afterCompletion = yield* Deferred.poll(deferred)
 *   console.log(afterCompletion._tag === "Some") // true
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export function poll<A, E>(self: Deferred<A, E>): Effect<Option.Option<Effect<A, E>>> {
  return internalEffect.sync(() => Option.fromUndefinedOr(self.effect))
}

/**
 * Attempts to complete the `Deferred` with the specified value.
 *
 * **Details**
 *
 * Fibers waiting on the `Deferred` receive the value only if this call
 * completes it. The returned effect succeeds with `true` when this call
 * completed the `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Completing a Deferred with a value)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   yield* Deferred.succeed(deferred, 42)
 *
 *   const value = yield* Deferred.await(deferred)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const succeed: {
  <A>(value: A): <E>(self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, value: A): Effect<boolean>
} = dual(2, <A, E>(self: Deferred<A, E>, value: A): Effect<boolean> => done(self, core.exitSucceed(value)))

/**
 * Computes a value when the returned effect is run, then attempts to complete
 * the `Deferred` with that value.
 *
 * **Details**
 *
 * Fibers waiting on the `Deferred` receive the computed value only if this call
 * completes it. The returned effect succeeds with `true` when this call
 * completed the `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Completing a Deferred with a lazy value)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<number>()
 *   yield* Deferred.sync(deferred, () => 42)
 *
 *   const value = yield* Deferred.await(deferred)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const sync: {
  <A>(evaluate: LazyArg<A>): <E>(self: Deferred<A, E>) => Effect<boolean>
  <A, E>(self: Deferred<A, E>, evaluate: LazyArg<A>): Effect<boolean>
} = dual(
  2,
  <A, E>(self: Deferred<A, E>, evaluate: LazyArg<A>): Effect<boolean> =>
    internalEffect.suspend(() => succeed(self, evaluate()))
)

/**
 * Synchronously attempts to complete the `Deferred` with the specified
 * completion effect.
 *
 * **Details**
 *
 * This mutates the `Deferred` directly and should be reserved for low-level
 * code; prefer the effectful completion APIs when possible. Returns `true` if
 * this call completed the `Deferred`, or `false` if it was already completed.
 *
 * **Example** (Completing a Deferred unsafely)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * const deferred = Deferred.makeUnsafe<number>()
 * const success = Deferred.doneUnsafe(deferred, Effect.succeed(42))
 * console.log(success) // true
 * ```
 *
 * @category unsafe
 * @since 4.0.0
 */
export const doneUnsafe = <A, E>(self: Deferred<A, E>, effect: Effect<A, E>): boolean => {
  if (self.effect) return false
  self.effect = effect
  if (self.resumes) {
    for (let i = 0; i < self.resumes.length; i++) {
      self.resumes[i](effect)
    }
    self.resumes = undefined
  }
  return true
}

/**
 * Runs an `Effect` and attempts to complete a `Deferred` with the effect's
 * result.
 *
 * **Details**
 *
 * If the effect succeeds, fails, dies, or is interrupted, that result is used
 * as the attempted completion. The returned effect cannot fail; it succeeds
 * with `true` if it completed the `Deferred`, or `false` if the `Deferred` was
 * already completed.
 *
 * **Example** (Completing a Deferred from an effect result)
 *
 * ```ts
 * import { Deferred, Effect } from "effect"
 *
 * // Define an effect that succeeds
 * const successEffect = Effect.succeed(42)
 *
 * const program = Effect.gen(function*() {
 *   // Create a deferred
 *   const deferred = yield* Deferred.make<number, string>()
 *
 *   // Complete the deferred using the successEffect
 *   const isCompleted = yield* Deferred.into(successEffect, deferred)
 *
 *   // Access the value of the deferred
 *   const value = yield* Deferred.await(deferred)
 *   console.log(value)
 *
 *   return isCompleted
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // 42
 * // true
 * ```
 *
 * @category Synchronization Utilities
 * @since 4.0.0
 */
export const into: {
  <A, E>(deferred: Deferred<A, E>): <R>(self: Effect<A, E, R>) => Effect<boolean, never, R>
  <A, E, R>(self: Effect<A, E, R>, deferred: Deferred<A, E>): Effect<boolean, never, R>
} = dual(
  2,
  <A, E, R>(self: Effect<A, E, R>, deferred: Deferred<A, E>): Effect<boolean, never, R> =>
    internalEffect.uninterruptibleMask((restore) =>
      internalEffect.flatMap(
        internalEffect.exit(restore(self)),
        (exit) => done(deferred, exit)
      )
    )
)
