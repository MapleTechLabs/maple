/**
 * The `Latch` module provides a reusable synchronization primitive for
 * coordinating fibers. A `Latch` is either open or closed: when it is closed,
 * fibers that use {@link await} or {@link whenOpen} suspend until the latch is
 * opened or the current waiters are released.
 *
 * **Mental model**
 *
 * - An open latch lets current and future waiters continue immediately
 * - A closed latch causes `await` and `whenOpen` to suspend
 * - {@link open} permanently opens the latch until it is closed again
 * - {@link release} wakes only the fibers currently waiting and leaves the
 *   latch closed for future waiters
 * - {@link close} resets the latch so later waiters suspend again
 *
 * **Common tasks**
 *
 * - Create a latch inside `Effect`: {@link make}
 * - Create a latch synchronously: {@link makeUnsafe}
 * - Wait for a signal before continuing: {@link await}
 * - Guard an effect so it runs only after the latch is open: {@link whenOpen}
 * - Let all current and future waiters proceed: {@link open}
 * - Let only the current waiters proceed: {@link release}
 * - Re-enable waiting after opening: {@link close}
 *
 * **Gotchas**
 *
 * - `release` is not the same as `open`; new waiters still suspend after the
 *   current waiters are released
 * - `open` and `close` report whether they changed the latch state
 * - Prefer the effectful APIs unless synchronous allocation or mutation is
 *   required
 *
 * @since 4.0.0
 */
import type * as Effect from "./Effect.ts"
import * as internal from "./internal/effect.ts"

/**
 * A reusable coordination primitive that lets fibers wait until they are
 * released by the latch.
 *
 * **Details**
 *
 * A closed latch causes `await` and `whenOpen` to suspend. `open` opens the
 * latch and releases current and future waiters, `release` releases only
 * current waiters without opening it, and `close` makes future waiters suspend
 * again.
 *
 * **Example** (Coordinating fibers with a latch)
 *
 * ```ts
 * import { Effect, Latch } from "effect"
 *
 * // Create and use a latch for coordination between fibers
 * const program = Effect.gen(function*() {
 *   const latch = yield* Latch.make()
 *
 *   // Wait for the latch to be opened
 *   yield* latch.await
 *
 *   return "Latch was opened!"
 * })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Latch {
  /** open the latch, releasing all fibers waiting on it */
  readonly open: Effect.Effect<boolean>
  /** open the latch, releasing all fibers waiting on it */
  openUnsafe(this: Latch): boolean
  /** release all fibers waiting on the latch, without opening it */
  readonly release: Effect.Effect<boolean>
  /** wait for the latch to be opened */
  readonly await: Effect.Effect<void>
  /** close the latch */
  readonly close: Effect.Effect<boolean>
  /** close the latch */
  closeUnsafe(this: Latch): boolean
  /** only run the given effect when the latch is open */
  whenOpen<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}

/**
 * Creates a `Latch` synchronously, outside of `Effect`.
 *
 * **When to use**
 *
 * Use this only when synchronous allocation is required; otherwise prefer
 * `make`.
 *
 * **Details**
 *
 * The latch starts closed by default; pass `true` to create it open.
 *
 * **Example** (Creating a latch unsafely)
 *
 * ```ts
 * import { Effect, Latch } from "effect"
 *
 * const latch = Latch.makeUnsafe(false)
 *
 * const waiter = Effect.gen(function*() {
 *   yield* Effect.log("Waiting for latch to open...")
 *   yield* latch.await
 *   yield* Effect.log("Latch opened! Continuing...")
 * })
 *
 * const opener = Effect.gen(function*() {
 *   yield* Effect.sleep("2 seconds")
 *   yield* Effect.log("Opening latch...")
 *   yield* latch.open
 * })
 *
 * const program = Effect.all([waiter, opener])
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeUnsafe: (open?: boolean | undefined) => Latch = internal.makeLatchUnsafe

/**
 * Creates a `Latch` inside `Effect`.
 *
 * **Details**
 *
 * The latch starts closed by default; pass `true` to create it open.
 *
 * **Example** (Creating a latch)
 *
 * ```ts
 * import { Effect, Latch } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const latch = yield* Latch.make(false)
 *
 *   const waiter = Effect.gen(function*() {
 *     yield* Effect.log("Waiting for latch to open...")
 *     yield* latch.await
 *     yield* Effect.log("Latch opened! Continuing...")
 *   })
 *
 *   const opener = Effect.gen(function*() {
 *     yield* Effect.sleep("2 seconds")
 *     yield* Effect.log("Opening latch...")
 *     yield* latch.open
 *   })
 *
 *   yield* Effect.all([waiter, opener])
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: (open?: boolean | undefined) => Effect.Effect<Latch> = internal.makeLatch

/**
 * Opens the latch and releases fibers waiting on it.
 *
 * **Details**
 *
 * The returned effect succeeds with `true` when this call changed the latch
 * from closed to open, or `false` if it was already open.
 *
 * @category combinators
 * @since 4.0.0
 */
export const open = (self: Latch): Effect.Effect<boolean> => self.open

/**
 * Synchronously opens the latch and releases fibers waiting on it.
 *
 * **Details**
 *
 * Returns `true` when this call changed the latch from closed to open, or
 * `false` if it was already open. This unsafe variant performs the state
 * change immediately instead of returning an `Effect`.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const openUnsafe = (self: Latch): boolean => self.openUnsafe()

/**
 * Releases the fibers currently waiting on a closed latch without opening it.
 *
 * **Details**
 *
 * The returned effect succeeds with `true` when release was requested while
 * the latch was closed, or `false` if the latch was already open. Future
 * waiters still suspend until the latch is opened or released again.
 *
 * @category combinators
 * @since 4.0.0
 */
export const release = (self: Latch): Effect.Effect<boolean> => self.release

const _await = (self: Latch): Effect.Effect<void> => self.await

export {
  /**
   * Waits for the latch to be opened.
   *
   * @category getters
   * @since 4.0.0
   */
  _await as await
}

/**
 * Closes the latch so future `await` and `whenOpen` calls suspend.
 *
 * **Details**
 *
 * The returned effect succeeds with `true` when this call changed the latch
 * from open to closed, or `false` if it was already closed.
 *
 * @category combinators
 * @since 4.0.0
 */
export const close = (self: Latch): Effect.Effect<boolean> => self.close

/**
 * Synchronously closes the latch so future `await` and `whenOpen` calls
 * suspend.
 *
 * **Details**
 *
 * Returns `true` when this call changed the latch from open to closed, or
 * `false` if it was already closed. This unsafe variant performs the state
 * change immediately instead of returning an `Effect`.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const closeUnsafe = (self: Latch): boolean => self.closeUnsafe()

/**
 * Waits on the latch, then runs the provided effect.
 *
 * **Details**
 *
 * If the latch is open, the effect runs immediately. If it is closed, the
 * returned effect suspends until the latch is opened or the current waiters are
 * released. The provided effect's success, failure, and requirements are
 * preserved.
 *
 * @category combinators
 * @since 4.0.0
 */
export const whenOpen: {
  (self: Latch): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Latch, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 1) {
    const [self] = args
    return (effect: Effect.Effect<any, any, any>) => self.whenOpen(effect)
  }
  const [self, effect] = args
  return self.whenOpen(effect)
}) as any
