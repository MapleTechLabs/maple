/**
 * The `Runner` module defines the membership record used by the unstable
 * cluster runtime to describe a process that can host entity shards.
 *
 * A runner combines the network address used by other runners to reach it, the
 * shard groups it participates in, and a relative weight used when the sharding
 * service assigns shards across the healthy runners in each group.
 *
 * **Common tasks**
 *
 * - Construct the runner registered by the local `Sharding` layer
 * - Persist or exchange runner metadata through `RunnerStorage`
 * - Encode and decode runner values at cluster transport or storage boundaries
 * - Tune shard distribution by adjusting the runner's group membership and
 *   relative weight
 *
 * **Gotchas**
 *
 * - Runner addresses must be stable and unique while a runner is registered,
 *   because they identify the owner used for routing and shard locks.
 * - Weights are relative within each shard group; changing weights or groups can
 *   rebalance shard ownership as the cluster refreshes its runner view.
 * - Runner equality and hashing are based on address and weight, so compare
 *   `groups` explicitly when group membership is the important distinction.
 *
 * @since 4.0.0
 */
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import { NodeInspectSymbol } from "../../Inspectable.ts"
import * as Schema from "../../Schema.ts"
import { RunnerAddress } from "./RunnerAddress.ts"

const TypeId = "~effect/cluster/Runner"

/**
 * A cluster runner that can host entities.
 *
 * **Details**
 *
 * Each runner has a unique network `address`, the shard `groups` it participates
 * in, and a relative `weight` used when assigning shards across runners.
 *
 * @category models
 * @since 4.0.0
 */
export class Runner extends Schema.Class<Runner>(TypeId)({
  address: RunnerAddress,
  groups: Schema.Array(Schema.String),
  weight: Schema.Number
}) {
  /**
   * Formatter for rendering runner values consistently.
   *
   * @since 4.0.0
   */
  static format = Schema.toFormatter(this)

  /**
   * Marks this value as a cluster runner for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * Decodes a runner from its JSON string representation.
   *
   * @since 4.0.0
   */
  static readonly decodeSync = Schema.decodeSync(Schema.fromJsonString(Runner))

  /**
   * Encodes a runner to its JSON string representation.
   *
   * @since 4.0.0
   */
  static readonly encodeSync = Schema.encodeSync(Schema.fromJsonString(Runner))

  /**
   * Formats this runner as a string.
   *
   * @since 4.0.0
   */
  override toString(): string {
    return Runner.format(this)
  }

  /**
   * Formats this runner for Node.js inspection.
   *
   * @since 4.0.0
   */
  [NodeInspectSymbol](): string {
    return this.toString()
  }

  /**
   * Compares runners by address and shard-assignment weight.
   *
   * @since 4.0.0
   */
  [Equal.symbol](that: Runner): boolean {
    return this.address[Equal.symbol](that.address) && this.weight === that.weight
  }

  /**
   * Computes a structural hash from the runner address and shard-assignment weight.
   *
   * @since 4.0.0
   */
  [Hash.symbol](): number {
    return Hash.string(`${this.address.toString()}:${this.weight}`)
  }
}

/**
 * Constructs a `Runner` from its network address, shard groups, and relative
 * shard-assignment weight.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (props: {
  readonly address: RunnerAddress
  readonly groups: ReadonlyArray<string>
  readonly weight: number
}): Runner => new Runner(props, { disableChecks: true })
