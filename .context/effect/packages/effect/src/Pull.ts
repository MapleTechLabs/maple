/**
 * The `Pull` module provides the low-level pull-step abstraction used by
 * stream-like consumers. A `Pull<A, E, Done, R>` is an `Effect` that can
 * produce one value of type `A`, fail with an ordinary error `E`, or signal
 * end-of-input with a `Cause.Done<Done>` value.
 *
 * **Mental model**
 *
 * - `Pull` is an `Effect` with a distinguished completion signal in the error channel
 * - ordinary failures and completion are both represented by `Cause`, but can be separated with the helpers in this module
 * - the `Done` value can carry leftover state or a final value needed by a downstream consumer
 * - `Pull` is useful when repeatedly evaluating an effect until it either produces values, fails, or reports that no more input is available
 *
 * **Common tasks**
 *
 * - Extract type parameters from a pull: {@link Success}, {@link Error}, {@link Leftover}, {@link Services}
 * - Detect and filter completion: {@link isDoneCause}, {@link filterDone}, {@link filterNoDone}
 * - Recover from completion while preserving ordinary failures: {@link catchDone}
 * - Convert done causes to successful exits: {@link doneExitFromCause}
 * - Handle all outcomes explicitly: {@link matchEffect}
 *
 * **Gotchas**
 *
 * - `Cause.Done` is not an ordinary failure; use this module's helpers before treating a pull failure as an error
 * - `Done` lives in the error channel, so generic `Effect` error handling can catch it unless you filter it deliberately
 * - `Pull` is a low-level primitive; most user-facing stream workflows should prefer higher-level stream APIs when available
 *
 * @since 4.0.0
 */
import * as Cause from "./Cause.ts"
import type { Effect } from "./Effect.ts"
import * as Exit from "./Exit.ts"
import * as Filter from "./Filter.ts"
import { dual } from "./Function.ts"
import * as internalEffect from "./internal/effect.ts"
import * as Result from "./Result.ts"

/**
 * An effectful pull step that either produces a value, fails with `E`, or
 * signals completion with `Cause.Done<Done>`.
 *
 * **Details**
 *
 * `Pull` represents completion in the error channel so low-level stream
 * consumers can distinguish ordinary failures from end-of-input and carry a
 * leftover value when needed.
 *
 * @category models
 * @since 4.0.0
 */
export interface Pull<out A, out E = never, out Done = void, out R = never>
  extends Effect<A, E | Cause.Done<Done>, R>
{}

/**
 * Extracts the success type from a Pull type.
 *
 * @category type extractors
 * @since 4.0.0
 */
export type Success<P> = P extends Effect<infer _A, infer _E, infer _R> ? _A : never

/**
 * Extracts the error type from a Pull type, excluding Done errors.
 *
 * @category type extractors
 * @since 4.0.0
 */
export type Error<P> = P extends Effect<infer _A, infer _E, infer _R> ? _E extends Cause.Done<infer _L> ? never : _E
  : never

/**
 * Extracts the leftover type from a Pull type.
 *
 * @category type extractors
 * @since 4.0.0
 */
export type Leftover<P> = P extends Effect<infer _A, infer _E, infer _R> ? _E extends Cause.Done<infer _L> ? _L : never
  : never

/**
 * Extracts the service requirements (context) type from a Pull type.
 *
 * @category type extractors
 * @since 4.0.0
 */
export type Services<P> = P extends Effect<infer _A, infer _E, infer _R> ? _R : never

/**
 * Excludes done errors from an error type union.
 *
 * @category type extractors
 * @since 4.0.0
 */
export type ExcludeDone<E> = Exclude<E, Cause.Done<any>>

// -----------------------------------------------------------------------------
// Done
// -----------------------------------------------------------------------------

/**
 * Handles `Cause.Done` failures in an effect while leaving ordinary failures
 * in the error channel.
 *
 * **Details**
 *
 * The handler receives the done leftover value and may recover with a new
 * effect. Non-done errors are preserved.
 *
 * @category Done
 * @since 4.0.0
 */
export const catchDone: {
  <E, A2, E2, R2>(f: (leftover: Cause.Done.Extract<E>) => Effect<A2, E2, R2>): <A, R>(
    self: Effect<A, E, R>
  ) => Effect<A | A2, ExcludeDone<E> | E2, R | R2>
  <A, R, E, A2, E2, R2>(
    self: Effect<A, E, R>,
    f: (leftover: Cause.Done.Extract<E>) => Effect<A2, E2, R2>
  ): Effect<A | A2, ExcludeDone<E> | E2, R | R2>
} = dual(2, <A, R, E, A2, E2, R2>(
  effect: Effect<A, E, R>,
  f: (leftover: Cause.Done.Extract<E>) => Effect<A2, E2, R2>
): Effect<A | A2, ExcludeDone<E> | E2, R | R2> =>
  internalEffect.catchCauseFilter(effect, filterDoneLeftover as any, (l: any) => f(l)) as any)

/**
 * Checks if a Cause contains any done errors.
 *
 * @category Done
 * @since 4.0.0
 */
export const isDoneCause = <E>(cause: Cause.Cause<E>): boolean => cause.reasons.some(isDoneFailure)

/**
 * Checks if a Cause failure is a done error.
 *
 * @category Done
 * @since 4.0.0
 */
export const isDoneFailure = <E>(
  failure: Cause.Reason<E>
): failure is Cause.Fail<E & Cause.Done<any>> => failure._tag === "Fail" && Cause.isDone(failure.error)

/**
 * Finds a `Cause.Done` failure in a `Cause`.
 *
 * **Details**
 *
 * Returns a successful `Result` with the `Cause.Done` value when one is
 * present, otherwise returns a failed `Result` containing the non-done cause.
 *
 * @category Done
 * @since 4.0.0
 */
export const filterDone: <E>(
  input: Cause.Cause<E>
) => Result.Result<Cause.Done.Only<E>, Cause.Cause<ExcludeDone<E>>> = Filter
  .composePassthrough(
    Cause.findError,
    (e) => Cause.isDone(e) ? Result.succeed(e) : Result.fail(e)
  ) as any

/**
 * Finds a `Cause.Done` failure in a cause whose done value is not used.
 *
 * **Details**
 *
 * Returns a successful `Result` with the done marker when present, otherwise
 * returns a failed `Result` with the non-done cause.
 *
 * @category Done
 * @since 4.0.0
 */
export const filterDoneVoid: <E extends Cause.Done>(
  input: Cause.Cause<E>
) => Result.Result<Cause.Done, Cause.Cause<Exclude<E, Cause.Done>>> = Filter.composePassthrough(
  Cause.findError,
  (e) => Cause.isDone(e) ? Result.succeed(e) : Result.fail(e)
) as any

/**
 * Keeps a `Cause` only when it contains no `Cause.Done` failures.
 *
 * **Details**
 *
 * Returns a successful `Result` with the cause when every failure is non-done;
 * otherwise returns a failed `Result` with the original cause.
 *
 * @category Done
 * @since 4.0.0
 */
export const filterNoDone: <E>(
  input: Cause.Cause<E>
) => Result.Result<
  Cause.Cause<ExcludeDone<E>>,
  Cause.Cause<E>
> = Filter.fromPredicate((cause: Cause.Cause<unknown>) =>
  cause.reasons.every((failure) => !isDoneFailure(failure))
) as any

/**
 * Filters a Cause to extract the leftover value from done errors.
 *
 * @category Done
 * @since 4.0.0
 */
export const filterDoneLeftover: <E>(
  cause: Cause.Cause<E>
) => Result.Result<Cause.Done.Extract<E>, Cause.Cause<ExcludeDone<E>>> = Filter.composePassthrough(
  Cause.findError,
  (e) => Cause.isDone(e) ? Result.succeed(e.value) : Result.fail(e)
) as any

/**
 * Converts a `Cause` into an `Exit`, treating `Cause.Done` as successful
 * completion.
 *
 * **Details**
 *
 * If the cause contains a done value, that leftover becomes the successful
 * value. Otherwise the non-done cause becomes the failure cause.
 *
 * @category Done
 * @since 4.0.0
 */
export const doneExitFromCause = <E>(cause: Cause.Cause<E>): Exit.Exit<Cause.Done.Extract<E>, ExcludeDone<E>> => {
  const halt = filterDone(cause)
  return !Result.isFailure(halt) ? Exit.succeed(halt.success.value as any) : Exit.failCause(halt.failure)
}

/**
 * Pattern matches on a Pull, handling success, failure, and done cases.
 *
 * **Example** (Matching Pull outcomes)
 *
 * ```ts
 * import { Cause, Effect, Pull } from "effect"
 *
 * const pull = Cause.done("stream ended")
 *
 * const result = Pull.matchEffect(pull, {
 *   onSuccess: (value) => Effect.succeed(`Got value: ${value}`),
 *   onFailure: (cause) => Effect.succeed(`Got error: ${cause}`),
 *   onDone: (leftover) => Effect.succeed(`Stream halted with: ${leftover}`)
 * })
 * ```
 *
 * @category pattern matching
 * @since 4.0.0
 */
export const matchEffect: {
  <A, E, L, AS, ES, RS, AF, EF, RF, AH, EH, RH>(options: {
    readonly onSuccess: (value: A) => Effect<AS, ES, RS>
    readonly onFailure: (failure: Cause.Cause<E>) => Effect<AF, EF, RF>
    readonly onDone: (leftover: L) => Effect<AH, EH, RH>
  }): <R>(self: Pull<A, E, L, R>) => Effect<AS | AF | AH, ES | EF | EH, R | RS | RF | RH>
  <A, E, L, R, AS, ES, RS, AF, EF, RF, AH, EH, RH>(self: Pull<A, E, L, R>, options: {
    readonly onSuccess: (value: A) => Effect<AS, ES, RS>
    readonly onFailure: (failure: Cause.Cause<E>) => Effect<AF, EF, RF>
    readonly onDone: (leftover: L) => Effect<AH, EH, RH>
  }): Effect<AS | AF | AH, ES | EF | EH, R | RS | RF | RH>
} = dual(2, <A, E, L, R, AS, ES, RS, AF, EF, RF, AH, EH, RH>(self: Pull<A, E, L, R>, options: {
  readonly onSuccess: (value: A) => Effect<AS, ES, RS>
  readonly onFailure: (failure: Cause.Cause<E>) => Effect<AF, EF, RF>
  readonly onDone: (leftover: L) => Effect<AH, EH, RH>
}): Effect<AS | AF | AH, ES | EF | EH, R | RS | RF | RH> =>
  internalEffect.matchCauseEffect(self, {
    onSuccess: options.onSuccess,
    onFailure: (cause): Effect<AS | AF | AH, ES | EF | EH, RS | RF | RH> => {
      const halt = filterDone(cause)
      return !Result.isFailure(halt) ? options.onDone(halt.success.value as L) : options.onFailure(halt.failure)
    }
  }))
