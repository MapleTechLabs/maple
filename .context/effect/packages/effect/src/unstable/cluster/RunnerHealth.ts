/**
 * The `RunnerHealth` module defines the health-check service used by cluster
 * sharding to decide whether a runner may still own its assigned shards. A
 * runner that is reported as alive is allowed to keep processing messages,
 * while a runner that is reported as unavailable can have its shards moved to
 * another runner.
 *
 * **Common tasks**
 *
 * - Provide a custom {@link RunnerHealth} service for a cluster deployment
 * - Use {@link layerPing} to check runners through the cluster runner protocol
 * - Use {@link layerK8s} when Kubernetes pod readiness should drive health
 * - Use {@link layerNoop} in tests or environments where runners are always considered healthy
 *
 * **Gotchas**
 *
 * - Health checks affect shard reassignment, so false negatives can move shards
 *   away from runners that may still be processing messages
 * - The Kubernetes implementation treats API failures as healthy to avoid
 *   reassignment caused by a temporary control-plane outage
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as Schedule from "../../Schedule.ts"
import type * as Scope from "../../Scope.ts"
import * as K8s from "./K8sHttpClient.ts"
import type { RunnerAddress } from "./RunnerAddress.ts"
import * as Runners from "./Runners.ts"

/**
 * Represents the service used to check if a Runner is healthy.
 *
 * **Details**
 *
 * If a Runner is responsive, shards will not be re-assigned because the Runner may
 * still be processing messages. If a Runner is not responsive, then its
 * associated shards can and will be re-assigned to a different Runner.
 *
 * @category models
 * @since 4.0.0
 */
export class RunnerHealth extends Context.Service<
  RunnerHealth,
  {
    readonly isAlive: (address: RunnerAddress) => Effect.Effect<boolean>
  }
>()("effect/cluster/RunnerHealth") {}

/**
 * A layer which will **always** consider a Runner healthy.
 *
 * **When to use**
 *
 * This is useful for testing.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerNoop = Layer.succeed(RunnerHealth, {
  isAlive: () => Effect.succeed(true)
})

/**
 * Creates a `RunnerHealth` service that pings runners through `Runners`, retrying
 * failed pings on a short schedule and treating a successful ping within the
 * timeout as healthy.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makePing: Effect.Effect<
  RunnerHealth["Service"],
  never,
  Runners.Runners | Scope.Scope
> = Effect.gen(function*() {
  const runners = yield* Runners.Runners
  const schedule = Schedule.spaced(500)

  function isAlive(address: RunnerAddress): Effect.Effect<boolean> {
    return runners.ping(address).pipe(
      Effect.timeout(10_000),
      Effect.retry({ times: 5, schedule }),
      Effect.isSuccess
    )
  }

  return RunnerHealth.of({ isAlive })
})

/**
 * A layer which will ping a Runner directly to check if it is healthy.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerPing: Layer.Layer<
  RunnerHealth,
  never,
  Runners.Runners
> = Layer.effect(RunnerHealth, makePing)

/**
 * Creates a `RunnerHealth` service that checks Kubernetes pod readiness for a
 * runner host, optionally scoped by namespace and label selector.
 *
 * **Gotchas**
 *
 * If the Kubernetes API check fails, the runner is treated as healthy.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeK8s = Effect.fnUntraced(function*(options?: {
  readonly namespace?: string | undefined
  readonly labelSelector?: string | undefined
}) {
  const allPods = yield* K8s.makeGetPods(options)

  return RunnerHealth.of({
    isAlive: (address) =>
      allPods.pipe(
        Effect.map((pods) => pods.get(address.host)?.isReadyOrInitializing ?? false),
        Effect.catchCause(() => Effect.succeed(true))
      )
  })
})

/**
 * A layer which checks Kubernetes pod readiness to determine whether a runner is
 * healthy.
 *
 * **Details**
 *
 * The provided `HttpClient` must trust the pod CA certificate and the pod service
 * account must be allowed to list pods.
 *
 * **Gotchas**
 *
 * If the Kubernetes API check fails, the runner is treated as healthy.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerK8s = (
  options?: {
    readonly namespace?: string | undefined
    readonly labelSelector?: string | undefined
  } | undefined
): Layer.Layer<
  RunnerHealth,
  never,
  K8s.K8sHttpClient
> => Layer.effect(RunnerHealth, makeK8s(options))
