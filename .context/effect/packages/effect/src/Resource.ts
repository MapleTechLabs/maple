/**
 * The `Resource` module provides refreshable, scoped values. A
 * `Resource<A, E>` stores the latest successful or failed acquisition result and
 * can be read with {@link get}, refreshed manually with {@link refresh}, or
 * refreshed automatically with {@link auto}.
 *
 * **Mental model**
 *
 * - A `Resource` wraps an acquisition `Effect` whose result is kept in a
 *   `ScopedRef`
 * - Each refresh re-runs acquisition and replaces the stored `Exit`
 * - Replacing the stored value releases resources associated with the previous
 *   scoped value
 * - Reading a resource returns the current acquired value or fails with the
 *   current acquisition error
 *
 * **Common tasks**
 *
 * - Create a manually refreshed resource with {@link manual}
 * - Create a schedule-driven resource with {@link auto}
 * - Read the current value with {@link get}
 * - Force a reload with {@link refresh}
 * - Check whether an unknown value is a resource with {@link isResource}
 *
 * **Gotchas**
 *
 * - Creating a resource requires a `Scope`; when the scope closes, scoped
 *   values held by the resource are released
 * - Failed acquisitions are stored too, so subsequent {@link get} calls fail
 *   until a refresh succeeds
 * - Automatic refreshes run in the resource scope and stop when that scope is
 *   closed
 *
 * @since 2.0.0
 */
import * as Context from "./Context.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import { identity } from "./Function.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import type { Pipeable } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Schedule from "./Schedule.ts"
import type * as Scope from "./Scope.ts"
import * as ScopedRef from "./ScopedRef.ts"

const TypeId = "~effect/Resource" as const

/**
 * A `Resource` is a value loaded into memory that can be refreshed manually or
 * automatically according to a schedule.
 *
 * @category models
 * @since 2.0.0
 */
export interface Resource<in out A, in out E = never> extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly scopedRef: ScopedRef.ScopedRef<Exit.Exit<A, E>>
  readonly acquire: Effect.Effect<A, E>
}

/**
 * Returns `true` if the specified value is a `Resource`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isResource: (u: unknown) => u is Resource<unknown, unknown> = (
  u: unknown
): u is Resource<unknown, unknown> => hasProperty(u, TypeId)

const Proto = {
  ...PipeInspectableProto,
  [TypeId]: TypeId,
  toJSON() {
    return {
      _id: "Resource"
    }
  }
}

const makeUnsafe = <A, E>(
  scopedRef: ScopedRef.ScopedRef<Exit.Exit<A, E>>,
  acquire: Effect.Effect<A, E>
): Resource<A, E> => {
  const self = Object.create(Proto)
  self.scopedRef = scopedRef
  self.acquire = acquire
  return self
}

/**
 * Creates a `Resource` that must be refreshed manually.
 *
 * @category constructors
 * @since 2.0.0
 */
export const manual = <A, E, R>(
  acquire: Effect.Effect<A, E, R>
): Effect.Effect<Resource<A, E>, never, Scope.Scope | R> =>
  Effect.contextWith((context: Context.Context<R>) => {
    const providedAcquire = Effect.updateContext(
      acquire,
      (input: Context.Context<never>) => Context.merge(context, input)
    )
    return Effect.map(
      ScopedRef.fromAcquire(Effect.exit(providedAcquire)),
      (scopedRef) => makeUnsafe(scopedRef, providedAcquire)
    )
  })

/**
 * Creates a `Resource` that refreshes automatically according to the supplied
 * schedule.
 *
 * @category constructors
 * @since 2.0.0
 */
export const auto = <A, E, R, Out, E2, R2>(
  acquire: Effect.Effect<A, E, R>,
  policy: Schedule.Schedule<Out, unknown, E2, R2>
): Effect.Effect<Resource<A, E>, never, R | R2 | Scope.Scope> =>
  Effect.tap(
    manual(acquire),
    (self) => Effect.forkScoped(Effect.repeat(refresh(self), policy))
  )

/**
 * Retrieves the current value stored in this resource.
 *
 * @category getters
 * @since 2.0.0
 */
export const get = <A, E>(self: Resource<A, E>): Effect.Effect<A, E> =>
  Effect.flatMap(ScopedRef.get(self.scopedRef), identity)

/**
 * Re-runs this resource's acquisition effect and updates the current value.
 *
 * **Details**
 *
 * Refreshing replaces the value stored in the resource's scoped reference and
 * releases resources associated with the previous value. If acquisition fails,
 * the returned effect fails with the acquisition error.
 *
 * @category utils
 * @since 2.0.0
 */
export const refresh = <A, E>(self: Resource<A, E>): Effect.Effect<void, E> =>
  ScopedRef.set(self.scopedRef, Effect.map(self.acquire, Exit.succeed))
