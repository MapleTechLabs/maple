/**
 * The `ExecutionPlan` module provides a way to describe ordered fallback
 * strategies for effects and streams that need different resources across
 * repeated attempts. An `ExecutionPlan` is a non-empty list of steps, where
 * each step supplies a `Context` or `Layer` and may control retries with an
 * attempt limit, a `Schedule`, or a `while` predicate.
 *
 * **Mental model**
 *
 * - A plan is evaluated step by step until the wrapped effect or stream
 *   succeeds, or until every step has been exhausted
 * - Each step provides the services used while that step is active
 * - `attempts` limits how many times a step may be tried
 * - `schedule` controls retry timing and receives the failure input
 * - `while` can stop retrying a step based on the failure input
 * - `CurrentMetadata` exposes the current 1-based attempt and 0-based step
 *   index to code running under a plan
 *
 * **Common tasks**
 *
 * - Build a plan with {@link make}
 * - Run an effect with a plan using `Effect.withExecutionPlan`
 * - Run a stream with a plan using `Stream.withExecutionPlan`
 * - Combine plans in order with {@link merge}
 * - Capture required services up front with `captureRequirements`
 * - Inspect the current attempt and step with {@link CurrentMetadata}
 *
 * **Gotchas**
 *
 * - Plans must contain at least one step
 * - `attempts` must be greater than zero when provided
 * - If `attempts` is omitted, a step is attempted once unless a `schedule` is
 *   provided
 * - A `while` predicate returning `false` skips the remaining retries for that
 *   step and moves the plan forward
 * - Layer, schedule, and predicate requirements are tracked in the plan type
 *   until they are provided or captured
 *
 * @since 3.16.0
 */
import type { NonEmptyReadonlyArray } from "./Array.ts"
import * as Context from "./Context.ts"
import type * as Effect from "./Effect.ts"
import { constant } from "./Function.ts"
import * as effect from "./internal/effect.ts"
import * as Layer from "./Layer.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import type * as Schedule from "./Schedule.ts"

/**
 * String literal type used as the runtime type identifier for `ExecutionPlan`
 * values.
 *
 * @category type IDs
 * @since 3.16.0
 */
export type TypeId = "~effect/ExecutionPlan"

/**
 * Runtime type identifier attached to `ExecutionPlan` values and used by
 * `isExecutionPlan`.
 *
 * @category type IDs
 * @since 3.16.0
 */
export const TypeId: TypeId = "~effect/ExecutionPlan"

/**
 * Returns `true` if a value is an `ExecutionPlan` by checking for the
 * `ExecutionPlan.TypeId` marker.
 *
 * @category guards
 * @since 3.16.0
 */
export const isExecutionPlan = (u: unknown): u is ExecutionPlan<any> => Predicate.hasProperty(u, TypeId)

/**
 * A `ExecutionPlan` can be used with `Effect.withExecutionPlan` or `Stream.withExecutionPlan`, allowing you to provide different resources for each step of execution until the effect succeeds or the plan is exhausted.
 *
 * **Example** (Defining fallback execution steps)
 *
 * ```ts
 * import { Effect, ExecutionPlan, Schedule } from "effect"
 * import type { Layer } from "effect"
 * import type { LanguageModel } from "effect/unstable/ai"
 *
 * declare const layerBad: Layer.Layer<LanguageModel.LanguageModel>
 * declare const layerGood: Layer.Layer<LanguageModel.LanguageModel>
 *
 * const ThePlan = ExecutionPlan.make(
 *   {
 *     // First try with the bad layer 2 times with a 3 second delay between attempts
 *     provide: layerBad,
 *     attempts: 2,
 *     schedule: Schedule.spaced(3000)
 *   },
 *   // Then try with the bad layer 3 times with a 1 second delay between attempts
 *   {
 *     provide: layerBad,
 *     attempts: 3,
 *     schedule: Schedule.spaced(1000)
 *   },
 *   // Finally try with the good layer.
 *   //
 *   // If `attempts` is omitted, the plan will only attempt once, unless a schedule is provided.
 *   {
 *     provide: layerGood
 *   }
 * )
 *
 * declare const effect: Effect.Effect<
 *   void,
 *   never,
 *   LanguageModel.LanguageModel
 * >
 * const withPlan: Effect.Effect<void> = Effect.withExecutionPlan(effect, ThePlan)
 * ```
 *
 * @category models
 * @since 3.16.0
 */
export interface ExecutionPlan<
  Config extends {
    provides: any
    input: any
    error: any
    requirements: any
  }
> extends Pipeable {
  readonly [TypeId]: TypeId
  readonly steps: NonEmptyReadonlyArray<{
    readonly provide:
      | Context.Context<Config["provides"]>
      | Layer.Layer<Config["provides"], Config["error"], Config["requirements"]>
    readonly attempts?: number | undefined
    readonly while?:
      | ((input: Config["input"]) => Effect.Effect<boolean, Config["error"], Config["requirements"]>)
      | undefined
    readonly schedule?: Schedule.Schedule<any, Config["input"], Config["requirements"]> | undefined
  }>

  /**
   * Returns an equivalent `ExecutionPlan` with the requirements satisfied, using the current context.
   */
  readonly captureRequirements: Effect.Effect<
    ExecutionPlan<{
      provides: Config["provides"]
      input: Config["input"]
      error: Config["error"]
      requirements: never
    }>,
    never,
    Config["requirements"]
  >
}

/**
 * Base type-level configuration carried by an `ExecutionPlan`.
 *
 * **Details**
 *
 * `provides` tracks services supplied by plan steps, `input` tracks the error
 * input consumed by schedules and `while` predicates, `error` tracks failures
 * from plan layers or predicates, and `requirements` tracks services needed to
 * build or run the plan.
 *
 * @category models
 * @since 4.0.0
 */
export type ConfigBase = {
  provides: any
  input: any
  error: any
  requirements: any
}

/**
 * Create an `ExecutionPlan`, which can be used with `Effect.withExecutionPlan` or `Stream.withExecutionPlan`, allowing you to provide different resources for each step of execution until the effect succeeds or the plan is exhausted.
 *
 * **Example** (Creating an execution plan)
 *
 * ```ts
 * import { Effect, ExecutionPlan, Schedule } from "effect"
 * import type { Layer } from "effect"
 * import type { LanguageModel } from "effect/unstable/ai"
 *
 * declare const layerBad: Layer.Layer<LanguageModel.LanguageModel>
 * declare const layerGood: Layer.Layer<LanguageModel.LanguageModel>
 *
 * const ThePlan = ExecutionPlan.make(
 *   {
 *     // First try with the bad layer 2 times with a 3 second delay between attempts
 *     provide: layerBad,
 *     attempts: 2,
 *     schedule: Schedule.spaced(3000)
 *   },
 *   // Then try with the bad layer 3 times with a 1 second delay between attempts
 *   {
 *     provide: layerBad,
 *     attempts: 3,
 *     schedule: Schedule.spaced(1000)
 *   },
 *   // Finally try with the good layer.
 *   //
 *   // If `attempts` is omitted, the plan will only attempt once, unless a schedule is provided.
 *   {
 *     provide: layerGood
 *   }
 * )
 *
 * declare const effect: Effect.Effect<
 *   void,
 *   never,
 *   LanguageModel.LanguageModel
 * >
 * const withPlan: Effect.Effect<void> = Effect.withExecutionPlan(effect, ThePlan)
 * ```
 *
 * @category constructors
 * @since 3.16.0
 */
export const make = <const Steps extends NonEmptyReadonlyArray<make.Step>>(
  ...steps: Steps & { [K in keyof Steps]: make.Step }
): ExecutionPlan<{
  provides: make.StepProvides<Steps>
  input: make.StepInput<Steps>
  error:
    | (Steps[number]["provide"] extends Context.Context<infer _P> | Layer.Layer<infer _P, infer E, infer _R> ? E
      : never)
    | (Steps[number]["while"] extends (input: infer _I) => Effect.Effect<infer _A, infer _E, infer _R> ? _E : never)
  requirements:
    | (Steps[number]["provide"] extends Layer.Layer<infer _A, infer _E, infer R> ? R : never)
    | (Steps[number]["while"] extends (input: infer _I) => Effect.Effect<infer _A, infer _E, infer R> ? R : never)
    | (Steps[number]["schedule"] extends Schedule.Schedule<infer _O, infer _I, infer R> ? R : never)
}> =>
  makeProto(steps.map((options, i) => {
    if (options.attempts && options.attempts < 1) {
      throw new Error(`ExecutionPlan.make: step[${i}].attempts must be greater than 0`)
    }
    return {
      schedule: options.schedule,
      attempts: options.attempts,
      while: options.while
        ? (input: any) =>
          effect.suspend(() => {
            const result = options.while!(input)
            return typeof result === "boolean" ? effect.succeed(result) : result
          })
        : undefined,
      provide: options.provide
    }
  }) as any)

/**
 * Namespace containing type helpers used by `ExecutionPlan.make`.
 *
 * @since 3.16.0
 */
export declare namespace make {
  /**
   * Input shape for a single execution-plan step.
   *
   * **Details**
   *
   * Each step provides a `Context` or `Layer` and may limit attempts, add a
   * `while` predicate for retry decisions, or attach a `Schedule` for retry
   * timing.
   *
   * @category models
   * @since 3.16.0
   */
  export type Step = {
    readonly provide: Context.Context<any> | Context.Context<never> | Layer.Any
    readonly attempts?: number | undefined
    readonly while?: ((input: any) => boolean | Effect.Effect<boolean, any, any>) | undefined
    readonly schedule?: Schedule.Schedule<any, any, any> | undefined
  }

  /**
   * Computes the intersection of services provided by a list of execution-plan
   * steps.
   *
   * @category utility types
   * @since 3.16.1
   */
  export type StepProvides<Steps extends ReadonlyArray<any>, Out = unknown> = Steps extends
    readonly [infer Step, ...infer Rest] ? StepProvides<
      Rest,
      & Out
      & (
        (Step extends { readonly provide: Context.Context<infer P> | Layer.Layer<infer P, infer _E, infer _R> } ? P
          : unknown)
      )
    > :
    Out

  /**
   * Computes the intersection of services provided by a list of execution plans.
   *
   * @category utility types
   * @since 3.16.1
   */
  export type PlanProvides<Plans extends ReadonlyArray<any>, Out = unknown> = Plans extends
    readonly [infer Plan, ...infer Rest] ?
    PlanProvides<Rest, Out & (Plan extends ExecutionPlan<infer T> ? T["provides"] : unknown)> :
    Out

  /**
   * Computes the input type consumed by the `while` predicates and schedules in
   * a list of execution-plan steps.
   *
   * @category utility types
   * @since 3.16.0
   */
  export type StepInput<Steps extends ReadonlyArray<any>, Out = unknown> = Steps extends
    readonly [infer Step, ...infer Rest] ? StepInput<
      Rest,
      & Out
      & (
        & (Step extends { readonly while: (input: infer I) => infer _ } ? I : unknown)
        & (Step extends { readonly schedule: Schedule.Schedule<infer _O, infer I, infer _R> } ? I : unknown)
      )
    > :
    Out

  /**
   * Computes the combined input type consumed by a list of execution plans.
   *
   * @category utility types
   * @since 3.16.0
   */
  export type PlanInput<Plans extends ReadonlyArray<any>, Out = unknown> = Plans extends
    readonly [infer Plan, ...infer Rest] ?
    PlanInput<Rest, Out & (Plan extends ExecutionPlan<infer T> ? T["input"] : unknown)> :
    Out
}

const Proto: Omit<ExecutionPlan<any>, "steps"> = {
  [TypeId]: TypeId,
  get captureRequirements() {
    const self = this as any as ExecutionPlan<any>
    return effect.contextWith((context: Context.Context<any>) =>
      effect.succeed(makeProto(self.steps.map((step) => ({
        ...step,
        provide: Layer.isLayer(step.provide)
          ? Layer.provide(step.provide, Layer.succeedContext(context))
          : step.provide
      })) as any))
    )
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makeProto = <Provides, In, PlanE, PlanR>(
  steps: ExecutionPlan<{
    provides: Provides
    input: In
    error: PlanE
    requirements: PlanR
  }>["steps"]
) => {
  const self = Object.create(Proto)
  self.steps = steps
  return self
}

/**
 * Combines multiple execution plans by concatenating their steps in order.
 *
 * **Details**
 *
 * The resulting plan tries every step from the first plan, then every step from
 * the next plan, and so on.
 *
 * @category Combining
 * @since 3.16.0
 */
export const merge = <const Plans extends NonEmptyReadonlyArray<ExecutionPlan<any>>>(
  ...plans: Plans
): ExecutionPlan<{
  provides: make.PlanProvides<Plans>
  input: make.PlanInput<Plans>
  error: Plans[number] extends ExecutionPlan<infer T> ? T["error"] : never
  requirements: Plans[number] extends ExecutionPlan<infer T> ? T["requirements"] : never
}> => makeProto(plans.flatMap((plan) => plan.steps) as any)

/**
 * Metadata describing the currently running execution-plan attempt.
 *
 * **Details**
 *
 * `attempt` is the current 1-based attempt number, and `stepIndex` is the
 * 0-based index of the plan step currently being evaluated.
 *
 * @category Metadata
 * @since 4.0.0
 */
export interface Metadata {
  readonly attempt: number
  readonly stepIndex: number
}

/**
 * `Context.Reference` containing metadata for the currently running
 * execution-plan attempt.
 *
 * @category Metadata
 * @since 4.0.0
 */
export const CurrentMetadata = Context.Reference<Metadata>("effect/ExecutionPlan/CurrentMetadata", {
  defaultValue: constant({
    attempt: 0,
    stepIndex: 0
  })
})
