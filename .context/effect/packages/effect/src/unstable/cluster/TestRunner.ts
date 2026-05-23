/**
 * The `TestRunner` module provides a lightweight in-memory cluster layer for
 * tests that need the cluster sharding services without starting real runners
 * or relying on external storage.
 *
 * Use it when exercising sharding behavior, message storage, or code that
 * depends on the cluster runner services in unit and integration tests. The
 * layer wires the normal sharding service to in-memory message and runner
 * storage, along with no-op runner and health implementations.
 *
 * **Testing gotchas**
 *
 * - State is held in memory and scoped to the layer lifetime; it is not shared
 *   across independently constructed layers or persisted between test runs
 * - Runner execution and health checks are no-ops, so this layer is best suited
 *   for testing coordination and storage behavior rather than real distributed
 *   runner processes
 *
 * @since 4.0.0
 */
import * as Layer from "../../Layer.ts"
import * as MessageStorage from "./MessageStorage.ts"
import * as RunnerHealth from "./RunnerHealth.ts"
import * as Runners from "./Runners.ts"
import * as RunnerStorage from "./RunnerStorage.ts"
import * as Sharding from "./Sharding.ts"
import * as ShardingConfig from "./ShardingConfig.ts"

/**
 * An in-memory cluster that can be used for testing purposes.
 *
 * **Details**
 *
 * `MessageStorage` and `RunnerStorage` are backed by in-memory drivers.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<
  Sharding.Sharding | Runners.Runners | MessageStorage.MessageStorage | MessageStorage.MemoryDriver
> = Sharding.layer.pipe(
  Layer.provideMerge(Runners.layerNoop),
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
  Layer.provide(ShardingConfig.layer())
)
