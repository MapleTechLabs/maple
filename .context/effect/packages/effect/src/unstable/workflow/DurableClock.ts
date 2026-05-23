/**
 * Durable workflow clocks provide workflow-safe timers and sleep operations.
 *
 * Use this module when a workflow needs to pause until a timeout, reminder,
 * deadline, retry delay, or other scheduled wake-up. Short sleeps can run as
 * in-memory activities, while longer sleeps are scheduled with the workflow
 * engine and resumed through a durable deferred signal when the timer fires.
 *
 * Because workflows may be replayed, timer names and durations should be
 * deterministic and stable for a given workflow path. Avoid deriving them from
 * ambient wall-clock state, and give distinct sleeps distinct names so replayed
 * executions can be matched with the correct scheduled wake-up. Lower the
 * in-memory threshold when a delay must be handled by the workflow engine
 * rather than the current process.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import type * as Schema from "../../Schema.ts"
import * as Activity from "./Activity.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import type { WorkflowEngine, WorkflowInstance } from "./WorkflowEngine.ts"

const TypeId = "~effect/workflow/DurableClock"

/**
 * Represents a durable workflow timer with a name, duration, and deferred
 * completed when the timer wakes.
 *
 * @category models
 * @since 4.0.0
 */
export interface DurableClock {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly duration: Duration.Duration
  readonly deferred: DurableDeferred.DurableDeferred<typeof Schema.Void>
}

/**
 * Creates a durable clock definition and its associated deferred wake-up
 * signal.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (options: {
  readonly name: string
  readonly duration: Duration.Input
}): DurableClock => ({
  [TypeId]: TypeId,
  name: options.name,
  duration: Duration.fromInputUnsafe(options.duration),
  deferred: DurableDeferred.make(`DurableClock/${options.name}`)
})

const EngineTag = Context.Service<WorkflowEngine, WorkflowEngine["Service"]>(
  "effect/workflow/WorkflowEngine" satisfies typeof WorkflowEngine.key
)

const InstanceTag = Context.Service<
  WorkflowInstance,
  WorkflowInstance["Service"]
>(
  "effect/workflow/WorkflowEngine/WorkflowInstance" satisfies typeof WorkflowInstance.key
)

/**
 * Sleeps inside a workflow, using an in-memory activity for durations at or
 * below the threshold and scheduling a durable clock for longer durations.
 *
 * @category Sleeping
 * @since 4.0.0
 */
export const sleep: (
  options: {
    readonly name: string
    readonly duration: Duration.Input
    /**
     * If the duration is less than or equal to this threshold, the clock will
     * be executed in memory.
     *
     * @default 60 seconds
     */
    readonly inMemoryThreshold?: Duration.Input | undefined
  }
) => Effect.Effect<
  void,
  never,
  WorkflowEngine | WorkflowInstance
> = Effect.fnUntraced(function*(options: {
  readonly name: string
  readonly duration: Duration.Input
  readonly inMemoryThreshold?: Duration.Input | undefined
}) {
  const duration = Duration.fromInputUnsafe(options.duration)
  if (Duration.isZero(duration)) {
    return
  }

  const inMemoryThreshold = options.inMemoryThreshold
    ? Duration.fromInputUnsafe(options.inMemoryThreshold)
    : defaultInMemoryThreshold

  if (Duration.isLessThanOrEqualTo(duration, inMemoryThreshold)) {
    return yield* Activity.make({
      name: `DurableClock/${options.name}`,
      execute: Effect.sleep(duration)
    })
  }

  const engine = yield* EngineTag
  const instance = yield* InstanceTag
  const clock = make(options)
  yield* engine.scheduleClock(instance.workflow, {
    executionId: instance.executionId,
    clock
  })
  return yield* DurableDeferred.await(clock.deferred)
})

const defaultInMemoryThreshold = Duration.seconds(60)
