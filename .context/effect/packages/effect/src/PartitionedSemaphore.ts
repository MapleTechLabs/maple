/**
 * The `PartitionedSemaphore` module provides a semaphore for limiting
 * concurrency across a shared permit pool while keeping waiters grouped by
 * partition key. A `PartitionedSemaphore<K>` is useful when many independent
 * groups of work compete for the same bounded resource and each group should
 * make progress without one busy group monopolizing released permits.
 *
 * **Mental model**
 *
 * - The semaphore has a fixed shared capacity measured in permits
 * - Work acquires permits with a partition key of type `K`
 * - Waiting acquisitions are tracked per partition
 * - Released permits are assigned to waiting partitions in round-robin order
 * - `withPermit` and `withPermits` acquire permits around an effect and
 *   release them when the effect exits, fails, or is interrupted
 *
 * **Common tasks**
 *
 * - Create a semaphore: {@link make}, {@link makeUnsafe}
 * - Inspect capacity and availability: {@link capacity}, {@link available}
 * - Acquire and release manually: {@link take}, {@link release}
 * - Limit a single operation per partition: {@link withPermit}
 * - Limit weighted work per partition: {@link withPermits}
 * - Run only when permits are immediately available:
 *   {@link withPermitsIfAvailable}
 *
 * **Gotchas**
 *
 * - `withPermitsIfAvailable` does not use a partition key; it only succeeds
 *   when the shared pool has enough permits immediately
 * - Acquiring more permits than the semaphore capacity never completes
 * - Requests for zero or negative permits complete without acquiring anything
 * - Non-finite capacities create an unbounded semaphore whose acquire and
 *   release operations complete immediately
 *
 * @since 4.0.0
 */
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import * as MutableHashMap from "./MutableHashMap.ts"
import * as Option from "./Option.ts"

/**
 * Runtime type identifier used to mark values that implement
 * `PartitionedSemaphore`.
 *
 * **Details**
 *
 * This constant is stored on partitioned semaphore instances and can be used by
 * library code that needs to recognize the data type at runtime.
 *
 * @category models
 * @since 4.0.0
 */
export const PartitionedTypeId: PartitionedTypeId = "~effect/PartitionedSemaphore"

/**
 * Literal type of the `PartitionedSemaphore` runtime type identifier.
 *
 * **Details**
 *
 * Use this type when declaring fields that must contain the exact
 * `PartitionedTypeId` marker value.
 *
 * @category models
 * @since 4.0.0
 */
export type PartitionedTypeId = "~effect/PartitionedSemaphore"

/**
 * A `PartitionedSemaphore` controls access to a shared permit pool while
 * tracking waiters by partition key.
 *
 * **Details**
 *
 * Waiting permits are distributed across partitions in round-robin order.
 *
 * @category models
 * @since 3.19.4
 */
export interface PartitionedSemaphore<in K> {
  readonly [PartitionedTypeId]: PartitionedTypeId
  readonly capacity: number
  readonly available: Effect.Effect<number>
  readonly take: (key: K, permits: number) => Effect.Effect<void>
  readonly release: (permits: number) => Effect.Effect<number>
  readonly withPermits: (
    key: K,
    permits: number
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly withPermit: (key: K) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly withPermitsIfAvailable: (
    permits: number
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>
}

/**
 * Alias interface for a `PartitionedSemaphore` keyed by values of type `K`.
 *
 * **Details**
 *
 * This interface does not add members beyond `PartitionedSemaphore`; it
 * provides an alternate exported name for APIs that refer to a partitioned
 * permit pool.
 *
 * @category models
 * @since 4.0.0
 */
export interface Partitioned<in K> extends PartitionedSemaphore<K> {}

/**
 * Constructs a `PartitionedSemaphore` synchronously, outside of `Effect`.
 *
 * **When to use**
 *
 * Prefer `make` when the semaphore should be created inside an `Effect`
 * workflow.
 *
 * **Details**
 *
 * Negative permit counts are clamped to `0`. Non-finite permit counts create
 * an unbounded semaphore whose acquire and release operations complete
 * immediately.
 *
 * @category constructors
 * @since 3.19.4
 */
export const makeUnsafe = <K = unknown>(options: {
  readonly permits: number
}): PartitionedSemaphore<K> => {
  const maxPermits = Math.max(0, options.permits)

  if (!Number.isFinite(maxPermits)) {
    return {
      [PartitionedTypeId]: PartitionedTypeId,
      capacity: maxPermits,
      available: Effect.succeed(maxPermits),
      take: () => Effect.void,
      release: () => Effect.succeed(maxPermits),
      withPermits: () => (effect) => effect,
      withPermit: () => (effect) => effect,
      withPermitsIfAvailable: () => (effect) => Effect.asSome(effect)
    }
  }

  let totalPermits = maxPermits
  let waitingPermits = 0

  type Waiter = {
    permits: number
    readonly resume: () => void
  }

  const partitions = MutableHashMap.empty<K, Set<Waiter>>()
  let iterator = partitions[Symbol.iterator]()

  const releaseUnsafe = (permits: number): number => {
    while (permits > 0) {
      if (waitingPermits === 0) {
        totalPermits = Math.min(maxPermits, totalPermits + permits)
        return totalPermits
      }

      let state = iterator.next()
      if (state.done) {
        iterator = partitions[Symbol.iterator]()
        state = iterator.next()
        if (state.done) {
          return totalPermits
        }
      }

      const waiter = state.value[1].values().next().value
      if (waiter === undefined) {
        continue
      }

      waiter.permits -= 1
      waitingPermits -= 1

      if (waiter.permits === 0) {
        waiter.resume()
      }

      permits -= 1
    }

    return totalPermits
  }

  const take = (key: K, permits: number): Effect.Effect<void> => {
    if (permits <= 0) {
      return Effect.void
    }

    return Effect.callback<void>((resume) => {
      if (maxPermits < permits) {
        resume(Effect.never)
        return
      }

      if (totalPermits >= permits) {
        totalPermits -= permits
        resume(Effect.void)
        return
      }

      const needed = permits - totalPermits
      const taken = permits - needed
      if (totalPermits > 0) {
        totalPermits = 0
      }
      waitingPermits += needed

      const waiters = Option.getOrElse(
        MutableHashMap.get(partitions, key),
        () => {
          const set = new Set<Waiter>()
          MutableHashMap.set(partitions, key, set)
          return set
        }
      )

      const entry: Waiter = {
        permits: needed,
        resume: () => {
          cleanup()
          resume(Effect.void)
        }
      }

      const cleanup = () => {
        waiters.delete(entry)
        if (waiters.size === 0) {
          MutableHashMap.remove(partitions, key)
        }
      }

      waiters.add(entry)

      return Effect.sync(() => {
        cleanup()
        waitingPermits -= entry.permits
        if (taken > 0) {
          releaseUnsafe(taken)
        }
      })
    })
  }

  const withPermits =
    (key: K, permits: number) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
      if (permits <= 0) {
        return effect
      }

      const takePermits = take(key, permits)
      return Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(
          restore(takePermits),
          () =>
            Effect.ensuring(
              restore(effect),
              Effect.sync(() => {
                releaseUnsafe(permits)
              })
            )
        )
      )
    }

  const tryTake = (permits: number): boolean => {
    if (permits <= 0) {
      return true
    }

    if (maxPermits < permits || totalPermits < permits) {
      return false
    }

    totalPermits -= permits
    return true
  }

  return {
    [PartitionedTypeId]: PartitionedTypeId,
    capacity: maxPermits,
    available: Effect.sync(() => totalPermits),
    take,
    release: (permits) => Effect.sync(() => releaseUnsafe(permits)),
    withPermits,
    withPermit: (key) => withPermits(key, 1),
    withPermitsIfAvailable:
      (permits) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E, R> => {
        if (permits <= 0) {
          return Effect.asSome(effect)
        }

        return Effect.suspend(() => {
          if (!tryTake(permits)) {
            return Effect.succeed(Option.none())
          }

          return Effect.ensuring(
            Effect.asSome(effect),
            Effect.sync(() => {
              releaseUnsafe(permits)
            })
          )
        })
      }
  }
}

/**
 * Creates a `PartitionedSemaphore` inside an `Effect`.
 *
 * **Details**
 *
 * The `permits` option sets the shared permit capacity. The resulting
 * semaphore tracks waiters by partition key and distributes released permits
 * across waiting partitions in round-robin order.
 *
 * @category constructors
 * @since 3.19.4
 */
export const make = <K = unknown>(options: {
  readonly permits: number
}): Effect.Effect<PartitionedSemaphore<K>> => Effect.sync(() => makeUnsafe<K>(options))

/**
 * Gets the current number of available permits.
 *
 * @category combinators
 * @since 4.0.0
 */
export const available = <K>(self: PartitionedSemaphore<K>): Effect.Effect<number> => self.available

/**
 * Gets the total capacity.
 *
 * @category getters
 * @since 4.0.0
 */
export const capacity = <K>(self: PartitionedSemaphore<K>): number => self.capacity

/**
 * Returns an effect that acquires the requested number of permits for the
 * given partition key.
 *
 * **Details**
 *
 * If enough permits are available, the effect completes immediately. Otherwise
 * it waits until released permits are assigned to this partition. Requests for
 * more permits than the semaphore capacity never complete. Requests for zero
 * or a negative number of permits complete without acquiring anything.
 *
 * @category combinators
 * @since 4.0.0
 */
export const take: {
  <K>(key: K, permits: number): (self: PartitionedSemaphore<K>) => Effect.Effect<void>
  <K>(self: PartitionedSemaphore<K>, key: K, permits: number): Effect.Effect<void>
} = dual(3, <K>(self: PartitionedSemaphore<K>, key: K, permits: number): Effect.Effect<void> => self.take(key, permits))

/**
 * Returns an effect that releases permits back to the shared pool and returns
 * the current available permit count.
 *
 * **Details**
 *
 * Released permits are first assigned to waiting partitions in round-robin
 * order. Only permits not needed by waiters increase the available count,
 * which is capped at the semaphore capacity.
 *
 * @category combinators
 * @since 4.0.0
 */
export const release: {
  (permits: number): <K>(self: PartitionedSemaphore<K>) => Effect.Effect<number>
  <K>(self: PartitionedSemaphore<K>, permits: number): Effect.Effect<number>
} = dual(2, <K>(self: PartitionedSemaphore<K>, permits: number): Effect.Effect<number> => self.release(permits))

/**
 * Runs an effect after acquiring permits for a partition, then releases those
 * permits when the effect exits.
 *
 * **Details**
 *
 * Permit acquisition may wait according to `take` semantics. Once acquired,
 * the permits are released even if the wrapped effect fails or is interrupted.
 * Requests for zero or a negative number of permits run the effect without
 * acquiring anything.
 *
 * @category combinators
 * @since 4.0.0
 */
export const withPermits: {
  <K>(
    self: PartitionedSemaphore<K>,
    key: K,
    permits: number
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <K, A, E, R>(
    self: PartitionedSemaphore<K>,
    key: K,
    permits: number,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 3) {
    const [self, key, permits] = args
    return (effect: Effect.Effect<any, any, any>) => self.withPermits(key, permits)(effect)
  }
  const [self, key, permits, effect] = args
  return self.withPermits(key, permits)(effect)
}) as any

/**
 * Runs an effect after acquiring one permit for a partition, then releases the
 * permit when the effect exits.
 *
 * **Details**
 *
 * This is the single-permit variant of `withPermits`. The permit is released
 * even if the wrapped effect fails or is interrupted.
 *
 * @category combinators
 * @since 4.0.0
 */
export const withPermit: {
  <K>(self: PartitionedSemaphore<K>, key: K): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <K, A, E, R>(
    self: PartitionedSemaphore<K>,
    key: K,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 2) {
    const [self, key] = args
    return (effect: Effect.Effect<any, any, any>) => self.withPermit(key)(effect)
  }
  const [self, key, effect] = args
  return self.withPermit(key)(effect)
}) as any

/**
 * Runs an effect only when the requested permits can be acquired immediately,
 * returning the result in `Some`.
 *
 * **Details**
 *
 * If the permits are not available, the effect is not run and the result is
 * `None`. When permits are acquired, they are released after the wrapped
 * effect completes, fails, or is interrupted. Requests for zero or a negative
 * number of permits run the effect and return `Some`.
 *
 * @category combinators
 * @since 4.0.0
 */
export const withPermitsIfAvailable: {
  <K>(
    self: PartitionedSemaphore<K>,
    permits: number
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>
  <K, A, E, R>(
    self: PartitionedSemaphore<K>,
    permits: number,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<Option.Option<A>, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 2) {
    const [self, permits] = args
    return (effect: Effect.Effect<any, any, any>) => self.withPermitsIfAvailable(permits)(effect)
  }
  const [self, permits, effect] = args
  return self.withPermitsIfAvailable(permits)(effect)
}) as any
