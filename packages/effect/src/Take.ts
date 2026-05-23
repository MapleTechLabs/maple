/**
 * The `Take` module provides the representation used by stream-like producers
 * to describe a single pull result. A `Take<A, E, Done>` is either a
 * non-empty batch of emitted values, a failed `Exit`, or a successful `Exit`
 * carrying the stream's completion value.
 *
 * `Take` is useful at boundaries where pull results need to be stored,
 * transferred, or interpreted later while preserving the distinction between
 * emitted elements, failures, and normal completion. Use {@link toPull} to turn
 * a `Take` back into a `Pull`: value batches become successful pulls, failure
 * exits are propagated, and successful exits signal completion with `Done`.
 *
 * **Gotchas**
 *
 * - A value batch is always represented by a `NonEmptyReadonlyArray`; empty
 *   batches are not valid `Take` values.
 * - Successful `Exit` values do not emit elements. They represent pull
 *   completion and carry the `Done` value.
 *
 * @since 2.0.0
 */
import type { NonEmptyReadonlyArray } from "./Array.ts"
import * as Cause from "./Cause.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import type * as Pull from "./Pull.ts"

/**
 * Represents one pull result: either a non-empty batch of values, a failure
 * `Exit`, or a successful `Exit` that signals completion with a `Done` value.
 *
 * @category models
 * @since 2.0.0
 */
export type Take<A, E = never, Done = void> = NonEmptyReadonlyArray<A> | Exit.Exit<Done, E>

/**
 * Converts a `Take` into a `Pull`, succeeding with value batches, failing with
 * failure exits, and translating successful exits into pull completion.
 *
 * @category converting
 * @since 4.0.0
 */
export const toPull = <A, E, Done>(take: Take<A, E, Done>): Pull.Pull<NonEmptyReadonlyArray<A>, E, Done> =>
  Exit.isExit(take)
    ? Exit.isSuccess(take) ? Cause.done(take.value) : (take as Exit.Exit<never, E>)
    : Effect.succeed(take)
