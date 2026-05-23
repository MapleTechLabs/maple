/**
 * The `Singleton` module provides a small helper for registering effects that
 * should run once across an Effect cluster. A singleton is coordinated through
 * `Sharding`, which assigns ownership to one node at a time and can move that
 * ownership when nodes leave or fail.
 *
 * Use singletons for cluster-wide background work such as schedulers, polling
 * loops, maintenance jobs, or consumers that must not have one instance per
 * process. Because ownership can change during failover, the registered effect
 * should be interruptible, scoped, and able to resume work without assuming that
 * the previous owner completed every in-flight action exactly once.
 *
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import type { Scope } from "../../Scope.ts"
import { Sharding } from "./Sharding.ts"

/**
 * Creates a layer that registers a singleton effect with `Sharding` under the
 * specified name and optional shard group.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <E, R>(
  name: string,
  run: Effect.Effect<void, E, R>,
  options?: {
    readonly shardGroup?: string | undefined
  }
): Layer.Layer<never, never, Sharding | Exclude<R, Scope>> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const sharding = yield* Sharding
    yield* sharding.registerSingleton(name, run, options)
  }))
