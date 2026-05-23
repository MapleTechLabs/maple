/**
 * The `Pool` module provides scoped resource pools for sharing expensive or
 * limited resources across fibers. A `Pool<A, E>` manages values of type `A`
 * acquired by an effect that may fail with `E`, automatically releasing all
 * allocated resources when the surrounding `Scope` closes.
 *
 * **Mental model**
 *
 * - A pool owns a bounded set of acquired items and hands them out with {@link get}
 * - Each checkout is scoped; leaving the scope returns the item to the pool
 * - `concurrency` controls how many fibers may use the same item at once
 * - `targetUtilization` controls when the pool grows between its minimum and maximum sizes
 * - {@link invalidate} removes a specific item so it can be replaced lazily
 *
 * **Common tasks**
 *
 * - Create a fixed-size pool with {@link make}
 * - Create an elastic pool with time-to-live reclamation using {@link makeWithTTL}
 * - Implement custom resizing and reclamation behavior with {@link makeWithStrategy}
 * - Borrow resources safely in scoped effects with {@link get}
 *
 * **Gotchas**
 *
 * - Pool construction and item checkout require `Scope`; closing the scope shuts
 *   down the pool or returns the borrowed item
 * - Failed acquisitions are represented by the `get` effect failing with the
 *   acquisition error, and retrying `get` can retry acquisition
 * - Resource finalization order during shutdown is unspecified
 *
 * @since 2.0.0
 */
import type * as Cause from "./Cause.ts"
import { Clock } from "./Clock.ts"
import * as Context from "./Context.ts"
import * as Duration from "./Duration.ts"
import * as Effect from "./Effect.ts"
import type * as Exit from "./Exit.ts"
import * as Fiber from "./Fiber.ts"
import { dual, identity } from "./Function.ts"
import * as Iterable from "./Iterable.ts"
import * as Latch from "./Latch.ts"
import { type Pipeable, pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import * as Queue from "./Queue.ts"
import { UnhandledLogLevel } from "./References.ts"
import * as Scope from "./Scope.ts"
import * as Semaphore from "./Semaphore.ts"

const TypeId = "~effect/Pool"

/**
 * A `Pool<A, E>` is a pool of items of type `A`, each of which may be
 * associated with the acquisition and release of resources. An attempt to get
 * an item `A` from a pool may fail with an error of type `E`.
 *
 * @category models
 * @since 2.0.0
 */
export interface Pool<in out A, in out E = never> extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly config: Config<A, E>
  readonly state: State<A, E>
}

/**
 * Normalized configuration used by a `Pool`.
 *
 * **Details**
 *
 * The config stores the acquire effect, size bounds, per-item concurrency,
 * target utilization, and resizing strategy used by the pool implementation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Config<A, E> {
  readonly acquire: Effect.Effect<A, E, Scope.Scope>
  readonly concurrency: number
  readonly minSize: number
  readonly maxSize: number
  readonly strategy: Strategy<A, E>
  readonly targetUtilization: number
}

/**
 * Mutable runtime state maintained by a `Pool`.
 *
 * **Details**
 *
 * This state tracks the pool scope, active and available items, invalidated
 * items, semaphores, waiters, and shutdown status. It is exposed for
 * inspection and implementation support; user code should prefer the
 * high-level pool operations.
 *
 * @category models
 * @since 4.0.0
 */
export interface State<A, E> {
  readonly scope: Scope.Scope
  isShuttingDown: boolean
  readonly semaphore: Semaphore.Semaphore
  readonly resizeSemaphore: Semaphore.Semaphore
  readonly items: Set<PoolItem<A, E>>
  readonly available: Set<PoolItem<A, E>>
  readonly availableLatch: Latch.Latch
  readonly invalidated: Set<PoolItem<A, E>>
  waiters: number
}

/**
 * Internal record for a value managed by a `Pool`.
 *
 * **Details**
 *
 * Each item stores the acquisition `Exit`, its finalizer, the current
 * reference count, and whether automatic reclaiming has been disabled because
 * the item was invalidated.
 *
 * @category models
 * @since 4.0.0
 */
export interface PoolItem<A, E> {
  readonly exit: Exit.Exit<A, E>
  finalizer: Effect.Effect<void>
  refCount: number
  disableReclaim: boolean
}

/**
 * Strategy used by a `Pool` to manage background resizing and item
 * reclamation.
 *
 * **Details**
 *
 * `run` starts any strategy-specific background work, `onAcquire` is invoked
 * when an item is acquired, and `reclaim` selects an item that can be removed
 * or replaced.
 *
 * @category models
 * @since 4.0.0
 */
export interface Strategy<A, E> {
  readonly run: (pool: Pool<A, E>) => Effect.Effect<void>
  readonly onAcquire: (item: PoolItem<A, E>) => Effect.Effect<void>
  readonly reclaim: (pool: Pool<A, E>) => Effect.Effect<PoolItem<A, E> | undefined>
}

/**
 * Returns `true` if the specified value is a `Pool`, `false` otherwise.
 *
 * @category refinements
 * @since 2.0.0
 */
export const isPool = (u: unknown): u is Pool<unknown, unknown> => hasProperty(u, TypeId)

/**
 * Makes a new pool of the specified fixed size.
 *
 * **Details**
 *
 * The pool is returned in a `Scope`, which governs the lifetime of the pool.
 * When the pool is shutdown because the `Scope` is closed, the individual
 * items allocated by the pool will be released in some unspecified order.
 *
 * By setting the `concurrency` parameter, you can control the level of concurrent
 * access per pool item. By default, the number of permits is set to `1`.
 *
 * `targetUtilization` determines when to create new pool items. It is a value
 * between 0 and 1, where 1 means only create new pool items when all the existing
 * items are fully utilized.
 *
 * A `targetUtilization` of 0.5 will create new pool items when the existing items are
 * 50% utilized.
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = <A, E, R>(options: {
  readonly acquire: Effect.Effect<A, E, R>
  readonly size: number
  readonly concurrency?: number | undefined
  readonly targetUtilization?: number | undefined
}): Effect.Effect<Pool<A, E>, never, R | Scope.Scope> =>
  makeWithStrategy({ ...options, min: options.size, max: options.size, strategy: strategyNoop() })

/**
 * Creates a scoped pool with minimum and maximum sizes and a time-to-live
 * policy for shrinking unused excess items.
 *
 * **Details**
 *
 * The returned pool requires `Scope`; when that scope is closed, allocated
 * items are released in an unspecified order. `concurrency` controls how many
 * fibers may use each pool item at once and defaults to `1`.
 *
 * `targetUtilization` controls when new items are created and is clamped by the
 * pool implementation. A value of `1` waits until existing items are fully
 * utilized before creating more items.
 *
 * `timeToLiveStrategy` controls when excess items expire: `"creation"` measures
 * from item creation, while `"usage"` measures from pool usage. The default is
 * `"usage"`.
 *
 * **Example** (Create a connection pool)
 *
 * ```ts
 * import { Duration, Effect, Pool } from "effect"
 *
 * interface Connection {
 *   readonly execute: (sql: string) => Effect.Effect<ReadonlyArray<string>>
 *   readonly close: Effect.Effect<void>
 * }
 *
 * const acquireDBConnection = Effect.acquireRelease(
 *   Effect.succeed({
 *     execute: (sql) => Effect.succeed([`executed: ${sql}`]),
 *     close: Effect.void
 *   } satisfies Connection),
 *   (connection) => connection.close
 * )
 *
 * const program = Effect.scoped(
 *   Effect.flatMap(
 *     Pool.makeWithTTL({
 *       acquire: acquireDBConnection,
 *       min: 10,
 *       max: 20,
 *       timeToLive: Duration.seconds(60)
 *     }),
 *     (pool) => Effect.flatMap(Pool.get(pool), (connection) => connection.execute("select 1"))
 *   )
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const makeWithTTL = <A, E, R>(options: {
  readonly acquire: Effect.Effect<A, E, R>
  readonly min: number
  readonly max: number
  readonly concurrency?: number | undefined
  readonly targetUtilization?: number | undefined
  readonly timeToLive: Duration.Input
  readonly timeToLiveStrategy?: "creation" | "usage" | undefined
}): Effect.Effect<Pool<A, E>, never, R | Scope.Scope> =>
  Effect.flatMap(
    options.timeToLiveStrategy === "creation" ?
      strategyCreationTTL<A, E>(options.timeToLive) :
      strategyUsageTTL<A, E>(options.timeToLive),
    (strategy) => makeWithStrategy({ ...options, strategy })
  )

/**
 * Creates a scoped pool using a custom resizing and reclamation strategy.
 *
 * **Details**
 *
 * The returned pool requires `Scope`; closing the scope shuts down the pool and
 * releases allocated items. Use this constructor when `make` and `makeWithTTL`
 * do not provide the desired item lifecycle behavior.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeWithStrategy = <A, E, R>(options: {
  readonly acquire: Effect.Effect<A, E, R>
  readonly min: number
  readonly max: number
  readonly concurrency?: number | undefined
  readonly targetUtilization?: number | undefined
  readonly strategy: Strategy<A, E>
}): Effect.Effect<Pool<A, E>, never, Scope.Scope | R> =>
  Effect.uninterruptibleMask(Effect.fnUntraced(function*(restore) {
    const services = yield* Effect.context<R | Scope.Scope>()
    const scope = Context.get(services, Scope.Scope)
    const acquire = Effect.updateContext(
      options.acquire,
      (input) => Context.merge(services, input)
    ) as Effect.Effect<A, E, Scope.Scope>
    const concurrency = options.concurrency ?? 1

    const config: Config<A, E> = {
      acquire,
      concurrency,
      minSize: options.min,
      maxSize: options.max,
      strategy: options.strategy,
      targetUtilization: Math.min(Math.max(options.targetUtilization ?? 1, 0.1), 1)
    }
    const state: State<A, E> = {
      scope,
      isShuttingDown: false,
      semaphore: Semaphore.makeUnsafe(concurrency * options.max),
      resizeSemaphore: Semaphore.makeUnsafe(1),
      items: new Set(),
      available: new Set(),
      availableLatch: Latch.makeUnsafe(false),
      invalidated: new Set(),
      waiters: 0
    }
    const self: Pool<A, E> = {
      [TypeId]: TypeId,
      config,
      state,
      pipe() {
        return pipeArguments(this, arguments)
      }
    }
    yield* Scope.addFinalizer(scope, shutdown(self))
    yield* Effect.tap(
      Effect.forkDetach(restore(resize(self))),
      (fiber) => Scope.addFinalizer(scope, Fiber.interrupt(fiber))
    )
    yield* Effect.tap(
      Effect.forkDetach(restore(options.strategy.run(self))),
      (fiber) => Scope.addFinalizer(scope, Fiber.interrupt(fiber))
    )
    return self
  }))

const shutdown = Effect.fnUntraced(function*<A, E>(self: Pool<A, E>) {
  if (self.state.isShuttingDown) return
  self.state.isShuttingDown = true
  const size = self.state.items.size
  const semaphore = Semaphore.makeUnsafe(size)
  for (const item of self.state.items) {
    if (item.refCount > 0) {
      item.finalizer = Effect.tap(item.finalizer, semaphore.release(1))
      self.state.invalidated.add(item)
      yield* semaphore.take(1)
    } else {
      self.state.items.delete(item)
      self.state.available.delete(item)
      self.state.invalidated.delete(item)
      yield* item.finalizer
    }
  }
  yield* semaphore.releaseAll
  self.state.availableLatch.openUnsafe()
  yield* semaphore.take(size)
})

/**
 * Retrieves an item from the pool in a scoped effect. Note that if
 * acquisition fails, then the returned effect will fail for that same reason.
 * Retrying a failed acquisition attempt will repeat the acquisition attempt.
 *
 * @category getters
 * @since 2.0.0
 */
export const get = <A, E>(self: Pool<A, E>): Effect.Effect<A, E, Scope.Scope> =>
  Effect.suspend(() => {
    if (self.state.isShuttingDown) {
      return Effect.interrupt
    }
    return Effect.flatMap(getPoolItem(self), (item) => item.exit)
  })

const getPoolItem = <A, E>(self: Pool<A, E>): Effect.Effect<PoolItem<A, E>, never, Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    restore(self.state.semaphore.take(1)).pipe(
      Effect.flatMap(() => Effect.scope),
      Effect.flatMap((scope) =>
        getPoolItemInner(self).pipe(
          Effect.ensuring(Effect.sync(() => self.state.waiters--)),
          Effect.tap((item) => {
            if (item.exit._tag === "Failure") {
              self.state.items.delete(item)
              self.state.invalidated.delete(item)
              self.state.available.delete(item)
              return self.state.semaphore.release(1)
            }
            item.refCount++
            self.state.available.delete(item)
            if (item.refCount < self.config.concurrency) {
              self.state.available.add(item)
            }
            return Scope.addFinalizerExit(scope, () =>
              Effect.flatMap(
                Effect.suspend(() => {
                  item.refCount--
                  if (self.state.invalidated.has(item)) {
                    return invalidatePoolItem(self, item)
                  }
                  self.state.available.add(item)
                  return Effect.void
                }),
                () => self.state.semaphore.release(1)
              ))
          }),
          Effect.onInterrupt(() => self.state.semaphore.release(1))
        )
      )
    )
  )

const getPoolItemInner = Effect.fnUntraced(function*<A, E>(
  self: Pool<A, E>
) {
  self.state.waiters++
  if (self.state.isShuttingDown) {
    return yield* Effect.interrupt
  } else if (targetSize(self) > activeSize(self)) {
    while (true) {
      yield* self.state.resizeSemaphore.withPermitsIfAvailable(1)(
        Effect.forkIn(Effect.interruptible(resize(self)), self.state.scope)
      )
      if (self.state.isShuttingDown) {
        return yield* Effect.interrupt
      } else if (self.state.available.size > 0) {
        return Iterable.headUnsafe(self.state.available)
      }
      self.state.availableLatch.closeUnsafe()
      yield* self.state.availableLatch.await
    }
  }
  return Iterable.headUnsafe(self.state.available)
})

/**
 * Invalidates the specified item. This will cause the pool to eventually
 * reallocate the item, although this reallocation may occur lazily rather
 * than eagerly.
 *
 * @category combinators
 * @since 2.0.0
 */
export const invalidate: {
  <A>(item: A): <E>(self: Pool<A, E>) => Effect.Effect<void, never, Scope.Scope>
  <A, E>(self: Pool<A, E>, item: A): Effect.Effect<void, never, Scope.Scope>
} = dual(2, <A, E>(self: Pool<A, E>, item: A): Effect.Effect<void, never, Scope.Scope> =>
  Effect.suspend(() => {
    if (self.state.isShuttingDown) return Effect.void
    for (const poolItem of self.state.items) {
      if (poolItem.exit._tag === "Success" && poolItem.exit.value === item) {
        poolItem.disableReclaim = true
        return Effect.uninterruptible(invalidatePoolItem(self, poolItem))
      }
    }
    return Effect.void
  }))

const invalidatePoolItem = <A, E>(self: Pool<A, E>, poolItem: PoolItem<A, E>): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (!self.state.items.has(poolItem)) {
      return Effect.void
    } else if (poolItem.refCount === 0) {
      self.state.items.delete(poolItem)
      self.state.available.delete(poolItem)
      self.state.invalidated.delete(poolItem)
      return Effect.asVoid(Effect.flatMap(
        poolItem.finalizer,
        () => Effect.forkIn(Effect.interruptible(resize(self)), self.state.scope)
      ))
    }
    self.state.invalidated.add(poolItem)
    self.state.available.delete(poolItem)
    return Effect.void
  })

const resize = <A, E>(self: Pool<A, E>): Effect.Effect<void> =>
  self.state.resizeSemaphore.withPermits(1)(resizeLoop(self))

const resizeLoop = <A, E>(self: Pool<A, E>): Effect.Effect<void> =>
  Effect.suspend(() => {
    const active = activeSize(self)
    const target = targetSize(self)
    if (active >= target) {
      return Effect.void
    }
    const toAcquire = target - active
    return self.config.strategy.reclaim(self).pipe(
      Effect.flatMap((item) => item ? Effect.succeed(item) : allocate(self)),
      Effect.replicateEffect(toAcquire, { concurrency: toAcquire }),
      Effect.tap(self.state.availableLatch.open),
      Effect.flatMap((items) => items.some((_) => _.exit._tag === "Failure") ? Effect.void : resizeLoop(self))
    )
  })

const allocate = <A, E>(self: Pool<A, E>): Effect.Effect<PoolItem<A, E>> =>
  Effect.acquireUseRelease(
    Scope.make(),
    (scope) =>
      self.config.acquire.pipe(
        Scope.provide(scope),
        Effect.exit,
        Effect.flatMap((exit) => {
          const item: PoolItem<A, E> = {
            exit,
            finalizer: Effect.catchCause(Scope.close(scope, exit), reportUnhandledError),
            refCount: 0,
            disableReclaim: false
          }
          self.state.items.add(item)
          self.state.available.add(item)
          return Effect.as(
            exit._tag === "Success"
              ? self.config.strategy.onAcquire(item)
              : Effect.flatMap(item.finalizer, () => self.config.strategy.onAcquire(item)),
            item
          )
        })
      ),
    (scope, exit) => exit._tag === "Failure" ? Scope.close(scope, exit) : Effect.void
  )

const currentUsage = <A, E>(self: Pool<A, E>) => {
  let count = self.state.waiters
  for (const item of self.state.items) {
    count += item.refCount
  }
  return count
}

const targetSize = <A, E>(self: Pool<A, E>) => {
  if (self.state.isShuttingDown) return 0
  const utilization = currentUsage(self) / self.config.targetUtilization
  const target = Math.ceil(utilization / self.config.concurrency)
  return Math.min(Math.max(self.config.minSize, target), self.config.maxSize)
}

const activeSize = <A, E>(self: Pool<A, E>) => {
  return self.state.items.size - self.state.invalidated.size
}

// -----------------------------------------------------------------------------
// Strategy
// -----------------------------------------------------------------------------

const strategyNoop = <A, E>(): Strategy<A, E> => ({
  run: (_) => Effect.void,
  onAcquire: (_) => Effect.void,
  reclaim: (_) => Effect.undefined
})

const strategyCreationTTL = Effect.fnUntraced(function*<A, E>(ttl: Duration.Input) {
  const clock = yield* Clock
  const queue = yield* Queue.unbounded<PoolItem<A, E>>()
  const ttlMillis = Duration.toMillis(Duration.fromInputUnsafe(ttl))
  const creationTimes = new WeakMap<PoolItem<A, E>, number>()
  return identity<Strategy<A, E>>({
    run: (pool) => {
      const process = (item: PoolItem<A, E>): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (!pool.state.items.has(item) || pool.state.invalidated.has(item)) {
            return Effect.void
          }
          const now = clock.currentTimeMillisUnsafe()
          const created = creationTimes.get(item)!
          const remaining = ttlMillis - (now - created)
          return remaining > 0
            ? Effect.delay(process(item), remaining)
            : invalidatePoolItem(pool, item)
        })
      return Queue.take(queue).pipe(
        Effect.tap(process),
        Effect.forever({ disableYield: true })
      )
    },
    onAcquire: (item) =>
      Effect.suspend(() => {
        creationTimes.set(item, clock.currentTimeMillisUnsafe())
        return Queue.offer(queue, item)
      }),
    reclaim: (_) => Effect.undefined
  })
})

const strategyUsageTTL = Effect.fnUntraced(function*<A, E>(ttl: Duration.Input) {
  const queue = yield* Queue.unbounded<PoolItem<A, E>>()
  return identity<Strategy<A, E>>({
    run: (pool) => {
      const process: Effect.Effect<void> = Effect.suspend(() => {
        const excess = activeSize(pool) - targetSize(pool)
        if (excess <= 0) return Effect.void
        return Queue.take(queue).pipe(
          Effect.tap((item) => invalidatePoolItem(pool, item)),
          Effect.flatMap(() => process)
        )
      })
      return process.pipe(
        Effect.delay(ttl),
        Effect.forever({ disableYield: true })
      )
    },
    onAcquire: (item) => Queue.offer(queue, item),
    reclaim(pool) {
      return Effect.suspend((): Effect.Effect<PoolItem<A, E> | undefined> => {
        if (pool.state.invalidated.size === 0) {
          return Effect.undefined
        }
        const item = Iterable.head(
          Iterable.filter(pool.state.invalidated, (item) => !item.disableReclaim)
        )
        if (item._tag === "None") {
          return Effect.undefined
        }
        pool.state.invalidated.delete(item.value)
        if (item.value.refCount < pool.config.concurrency) {
          pool.state.available.add(item.value)
        }
        return Effect.as(Queue.offer(queue, item.value), item.value)
      })
    }
  })
})

const reportUnhandledError = <E>(cause: Cause.Cause<E>) =>
  Effect.withFiber<void>((fiber) => {
    const unhandledLogLevel = fiber.getRef(UnhandledLogLevel)
    if (unhandledLogLevel) {
      return Effect.logWithLevel(unhandledLogLevel)(
        "Unhandled error in pool finalizer",
        cause
      )
    }
    return Effect.void
  })
