/**
 * The `ShardingRegistrationEvent` module defines the events emitted by
 * `Sharding` when the local runner registers entity handlers or singleton
 * workloads. These events are useful for observing the set of capabilities a
 * runner has made available, coordinating startup hooks, and writing tests or
 * integrations that need to react when registrations are complete.
 *
 * Registration events describe local registration, not shard ownership or
 * execution. A runner may register an entity or singleton before it owns the
 * shard that will run it, and the events are in-memory notifications from the
 * `Sharding` service rather than persisted cluster state. For persisted
 * messages, treat registration as the point where the handler is available to
 * the runner; it does not imply that existing storage work has already been
 * read or processed.
 *
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import type { Entity } from "./Entity.ts"
import type { SingletonAddress } from "./SingletonAddress.ts"

/**
 * Represents events that can occur when a runner registers entities or singletons.
 *
 * @category models
 * @since 4.0.0
 */
export type ShardingRegistrationEvent =
  | EntityRegistered
  | SingletonRegistered

/**
 * Represents an event that occurs when a new entity is registered with a runner.
 *
 * @category models
 * @since 4.0.0
 */
export interface EntityRegistered {
  readonly _tag: "EntityRegistered"
  readonly entity: Entity<any, any>
}

/**
 * Represents an event that occurs when a new singleton is registered with a
 * runner.
 *
 * @category models
 * @since 4.0.0
 */
export interface SingletonRegistered {
  readonly _tag: "SingletonRegistered"
  readonly address: SingletonAddress
}

/**
 * Generated helpers for pattern matching and constructing sharding registration
 * events.
 *
 * @category pattern matching
 * @since 4.0.0
 */
export const {
  /**
   * Pattern matches on a sharding registration event and dispatches to the
   * matching variant handler.
   *
   * @category pattern matching
   * @since 4.0.0
   */
  $match: match,
  /**
   * Creates an event for an entity registered by the local runner.
   *
   * @category constructors
   * @since 4.0.0
   */
  EntityRegistered,
  /**
   * Creates an event for a singleton registered by the local runner.
   *
   * @category constructors
   * @since 4.0.0
   */
  SingletonRegistered
} = Data.taggedEnum<ShardingRegistrationEvent>()
