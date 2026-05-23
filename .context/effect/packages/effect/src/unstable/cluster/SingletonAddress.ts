/**
 * The `SingletonAddress` module defines the address used by cluster sharding to
 * identify a registered singleton. A singleton address combines the singleton
 * name with the `ShardId` that owns it, giving the runtime a stable key for
 * registration events, equality checks, hashing, and runner-local fiber
 * tracking.
 *
 * Use this module when observing singleton registrations or working with
 * sharding internals that need to tell which shard currently owns a singleton.
 * The shard id is derived from the singleton name and shard group at
 * registration time, so changing either value changes ownership and routing.
 * Ownership can also move as shard locks are acquired or released, so an address
 * identifies the target shard rather than guaranteeing that a particular runner
 * is currently executing the singleton.
 *
 * @since 4.0.0
 */
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import * as Schema from "../../Schema.ts"
import { ShardId } from "./ShardId.ts"

const TypeId = "~effect/cluster/SingletonAddress"

/**
 * Represents the unique address of an singleton within the cluster.
 *
 * @category Address
 * @since 4.0.0
 */
export class SingletonAddress extends Schema.Class<SingletonAddress>(TypeId)({
  shardId: ShardId,
  name: Schema.String
}) {
  /**
   * Marks this value as a cluster singleton address for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId;
  /**
   * Computes a structural hash from the singleton name and shard id.
   *
   * @since 4.0.0
   */
  [Hash.symbol]() {
    return Hash.string(`${this.name}:${this.shardId.toString()}`)
  }
  /**
   * Compares singleton addresses by name and shard id.
   *
   * @since 4.0.0
   */
  [Equal.symbol](that: SingletonAddress): boolean {
    return this.name === that.name && Equal.equals(this.shardId, that.shardId)
  }
}
