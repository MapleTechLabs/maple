import {
  WorkflowEntrypoint as CloudflareWorkflowEntrypoint,
  type WorkflowEvent as CloudflareWorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep as CloudflareWorkflowStep,
  type WorkflowStepConfig,
  type WorkflowStepContext as CloudflareWorkflowStepContext,
  type WorkflowStepEvent,
  type WorkflowTimeoutDuration,
} from "cloudflare:workers";
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, type Scope } from "effect";

import { WorkerConfig, WorkerEnvironment, type WorkerEnv } from "./Environment";
import { ExecutionContext, WorkerContext } from "./Worker";
import * as WorkflowDefinition from "./WorkflowDefinition";
import * as Entrypoint from "./internal/Entrypoint";
import { fromExecutionContext, type RunWaitUntilEffect } from "./internal/WorkerContext";

export interface WorkflowEventService<Payload = unknown> {
  readonly raw: CloudflareWorkflowEvent<unknown>;
  readonly payload: Payload;
  readonly timestamp: Date;
  readonly instanceId: string;
}

export class WorkflowEvent extends Context.Service<WorkflowEvent, WorkflowEventService>()(
  "effect-cf/WorkflowEvent",
) {}

type RunWorkflowStepEffect = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;

export interface WorkflowStepService {
  readonly raw: CloudflareWorkflowStep;
  do<A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
    config?: WorkflowStepConfig,
  ): Effect.Effect<A, unknown, Exclude<R, WorkflowStepContext>>;
  readonly sleep: (name: string, duration: WorkflowSleepDuration) => Effect.Effect<void, unknown>;
  readonly sleepUntil: (name: string, timestamp: Date | number) => Effect.Effect<void, unknown>;
  readonly waitForEvent: <Payload>(
    name: string,
    options: {
      readonly type: string;
      readonly timeout?: WorkflowTimeoutDuration | number;
    },
  ) => Effect.Effect<WorkflowStepEvent<Payload>, unknown>;
}

export class WorkflowStep extends Context.Service<WorkflowStep, WorkflowStepService>()(
  "effect-cf/WorkflowStep",
) {}

export class WorkflowStepContext extends Context.Service<
  WorkflowStepContext,
  CloudflareWorkflowStepContext
>()("effect-cf/WorkflowStepContext") {}

const fromWorkflowEvent = <Payload>(
  event: CloudflareWorkflowEvent<Payload>,
): WorkflowEventService<Payload> => ({
  raw: event as CloudflareWorkflowEvent<unknown>,
  payload: event.payload,
  timestamp: event.timestamp,
  instanceId: event.instanceId,
});

const fromWorkflowStep = (
  step: CloudflareWorkflowStep,
  runPromise: RunWorkflowStepEffect,
): WorkflowStepService => ({
  raw: step,
  do: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, config?: WorkflowStepConfig) =>
    Effect.context<Exclude<R, WorkflowStepContext>>().pipe(
      Effect.flatMap((context) =>
        Effect.tryPromise({
          try: () => {
            const run = (stepContext: CloudflareWorkflowStepContext) =>
              runPromise(
                Effect.scoped(
                  Effect.provideService(
                    Effect.provideContext(
                      effect as Effect.Effect<A, E, Exclude<R, WorkflowStepContext>>,
                      context,
                    ),
                    WorkflowStepContext,
                    stepContext,
                  ),
                ),
              );
            const rawStep = step as {
              do(
                name: string,
                callback: (context: CloudflareWorkflowStepContext) => Promise<A>,
              ): Promise<A>;
              do(
                name: string,
                config: WorkflowStepConfig,
                callback: (context: CloudflareWorkflowStepContext) => Promise<A>,
              ): Promise<A>;
            };

            return config === undefined ? rawStep.do(name, run) : rawStep.do(name, config, run);
          },
          catch: (cause) => cause,
        }),
      ),
    ) as Effect.Effect<A, unknown, Exclude<R, WorkflowStepContext>>,
  sleep: (name, duration) =>
    Effect.tryPromise({
      try: () => step.sleep(name, duration),
      catch: (cause) => cause,
    }),
  sleepUntil: (name, timestamp) =>
    Effect.tryPromise({
      try: () => step.sleepUntil(name, timestamp),
      catch: (cause) => cause,
    }),
  waitForEvent: <Payload>(
    name: string,
    options: {
      readonly type: string;
      readonly timeout?: WorkflowTimeoutDuration | number;
    },
  ) =>
    Effect.tryPromise({
      try: () => step.waitForEvent(name, options) as Promise<WorkflowStepEvent<Payload>>,
      catch: (cause) => cause,
    }),
});

type RuntimeContext<ROut> = ExecutionContext | WorkerContext | WorkerEnvironment | ROut;

export type WorkflowRunContext<ROut> =
  | RuntimeContext<ROut>
  | WorkflowEvent
  | WorkflowStep
  | Scope.Scope;

export type WorkflowHandler<ROut, Payload = unknown, Result = unknown> = (
  payload: Payload,
) => Effect.Effect<Result, unknown, WorkflowRunContext<ROut>>;

export interface WorkflowOptions<ROut, Payload = unknown, Result = unknown> {
  readonly run: WorkflowHandler<ROut, Payload, Result>;
}

export type WorkflowClass<Payload, Result, _ROut> = new (
  ctx: globalThis.ExecutionContext,
  env: WorkerEnv,
) => CloudflareWorkflowEntrypoint<WorkerEnv, Payload> & {
  run(
    event: Readonly<CloudflareWorkflowEvent<Payload>>,
    step: CloudflareWorkflowStep,
  ): Promise<Result>;
};

export const make = <ROut, LayerError, Payload = unknown, Result = unknown>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  options: WorkflowOptions<ROut, Payload, Result>,
): WorkflowClass<Payload, Result, ROut> => {
  class EffectWorkflow extends CloudflareWorkflowEntrypoint<WorkerEnv, Payload> {
    readonly runtime: ManagedRuntime.ManagedRuntime<RuntimeContext<ROut>, LayerError>;

    constructor(ctx: globalThis.ExecutionContext, env: WorkerEnv) {
      super(ctx, env);

      let runWaitUntilEffect: RunWaitUntilEffect = () =>
        Promise.reject(new Error("WorkerContext runtime is not initialized"));

      const services = Layer.mergeAll(
        Layer.succeed(ExecutionContext, ctx),
        ConfigProvider.layer(Effect.succeed(WorkerConfig.providerFromEnv(env))),
        Layer.succeed(
          WorkerContext,
          fromExecutionContext(ctx, (effect) => runWaitUntilEffect(effect)),
        ),
        Layer.succeed(WorkerEnvironment, env),
      ) as Layer.Layer<ExecutionContext | WorkerContext | WorkerEnvironment, never, never>;

      const runtimeLayer = Entrypoint.provideEntrypointServices<
        ROut,
        LayerError,
        ExecutionContext | WorkerContext | WorkerEnvironment
      >(layer, services);

      this.runtime = ManagedRuntime.make(runtimeLayer);
      runWaitUntilEffect = <A, E>(effect: Effect.Effect<A, E, never>) =>
        this.runtime.runPromiseExit(effect as Effect.Effect<A, E, RuntimeContext<ROut>>);
    }

    run(
      event: Readonly<CloudflareWorkflowEvent<Payload>>,
      step: CloudflareWorkflowStep,
    ): Promise<Result> {
      const workflowServices = Layer.mergeAll(
        Layer.succeed(WorkflowEvent, fromWorkflowEvent(event)),
        Layer.succeed(
          WorkflowStep,
          fromWorkflowStep(
            step,
            (effect) =>
              this.runtime.runPromise(
                effect as Effect.Effect<unknown, unknown, RuntimeContext<ROut>>,
              ) as never,
          ),
        ),
      );

      return this.runtime.runPromise(
        Effect.scoped(
          options.run(event.payload).pipe(Effect.provide(workflowServices)),
        ) as Effect.Effect<Result, unknown, RuntimeContext<ROut>>,
      );
    }
  }

  return Entrypoint.assumeEntrypointClass<WorkflowClass<Payload, Result, ROut>>(EffectWorkflow);
};

export const step = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  config?: WorkflowStepConfig,
): Effect.Effect<A, unknown, WorkflowStep | Exclude<R, WorkflowStepContext>> =>
  Effect.flatMap(WorkflowStep, (workflowStep) =>
    workflowStep.do(name, effect, config),
  ) as Effect.Effect<A, unknown, WorkflowStep | Exclude<R, WorkflowStepContext>>;

export const sleep = (
  name: string,
  duration: WorkflowSleepDuration,
): Effect.Effect<void, unknown, WorkflowStep> =>
  Effect.flatMap(WorkflowStep, (workflowStep) => workflowStep.sleep(name, duration));

export const sleepUntil = (
  name: string,
  timestamp: Date | number,
): Effect.Effect<void, unknown, WorkflowStep> =>
  Effect.flatMap(WorkflowStep, (workflowStep) => workflowStep.sleepUntil(name, timestamp));

export const waitForEvent = <Payload>(
  name: string,
  options: {
    readonly type: string;
    readonly timeout?: WorkflowTimeoutDuration | number;
  },
): Effect.Effect<WorkflowStepEvent<Payload>, unknown, WorkflowStep> =>
  Effect.flatMap(WorkflowStep, (workflowStep) => workflowStep.waitForEvent<Payload>(name, options));

export type Definition<
  Id extends string = string,
  Payload extends WorkflowDefinition.Definition.Any["payload"] =
    WorkflowDefinition.Definition.Any["payload"],
  Result extends WorkflowDefinition.Definition.Any["result"] =
    WorkflowDefinition.Definition.Any["result"],
> = WorkflowDefinition.Definition<Id, Payload, Result>;

export namespace Definition {
  export type Any = WorkflowDefinition.Definition.Any;
}

export type LayerOptions = WorkflowDefinition.LayerOptions;

export type TagClass<
  Self,
  Id extends string,
  Payload extends WorkflowDefinition.Definition.Any["payload"],
  Result extends WorkflowDefinition.Definition.Any["result"],
> = WorkflowDefinition.TagClass<Self, Id, Payload, Result>;

export const Tag: <Self>() => <
  Id extends string,
  Payload extends WorkflowDefinition.Definition.Any["payload"],
  Result extends WorkflowDefinition.Definition.Any["result"],
>(
  id: Id,
  definition: {
    readonly payload: Payload;
    readonly result: Result;
  },
) => TagClass<Self, Id, Payload, Result> = WorkflowDefinition.Tag;

export const implement = WorkflowDefinition.implement;

export type Handler<
  ROut,
  Self extends WorkflowDefinition.Definition.Any,
> = WorkflowDefinition.Handler<ROut, Self>;

export type Options<
  ROut,
  Self extends WorkflowDefinition.Definition.Any,
> = WorkflowDefinition.Options<ROut, Self>;
