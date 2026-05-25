import { Cause, Effect, Exit } from "effect";

import type { WorkerContextService, WorkerContextWaitUntilOptions } from "../Worker";

export type RunWaitUntilEffect = <A, E>(
  effect: Effect.Effect<A, E, never>,
) => Promise<Exit.Exit<A, unknown>>;

const causeError = <E>(cause: Cause.Cause<E>) => new Error(Cause.pretty(cause));

const failureHandler = <E, R>(
  cause: Cause.Cause<E>,
  options: WorkerContextWaitUntilOptions<E, R> | undefined,
) =>
  (
    options?.onFailure?.(cause) ??
    Effect.logError("WorkerContext.waitUntil failed", Cause.pretty(cause))
  ).pipe(
    Effect.catchCause((handlerCause) =>
      Effect.logError(
        "WorkerContext.waitUntil failure handler failed",
        Cause.pretty(cause),
        Cause.pretty(handlerCause),
      ),
    ),
  );

export const fromExecutionContext = (
  ctx: globalThis.ExecutionContext,
  runPromiseExit: RunWaitUntilEffect,
): WorkerContextService => {
  const schedule = <A, E, R, R2 = never>(
    effect: Effect.Effect<A, E, R>,
    options: WorkerContextWaitUntilOptions<E, R2> | undefined,
    mode: "observe" | "propagate",
  ) =>
    Effect.context<R | R2>().pipe(
      Effect.flatMap((context) =>
        Effect.sync(() => {
          const runHandler = (cause: Cause.Cause<E>) =>
            runPromiseExit(
              Effect.scoped(Effect.provideContext(failureHandler(cause, options), context)),
            ).then((exit) => {
              if (Exit.isFailure(exit)) {
                console.error(
                  "WorkerContext.waitUntil failure handler failed",
                  Cause.pretty(exit.cause),
                );
              }
            });

          ctx.waitUntil(
            runPromiseExit(Effect.scoped(Effect.provideContext(effect, context))).then(
              async (exit) => {
                if (Exit.isSuccess(exit)) {
                  return;
                }

                await runHandler(exit.cause as Cause.Cause<E>);

                if (mode === "propagate") {
                  throw causeError(exit.cause as Cause.Cause<E>);
                }
              },
            ),
          );
        }),
      ),
    );

  return {
    raw: ctx,
    waitUntil: <A, E, R, R2 = never>(
      effect: Effect.Effect<A, E, R>,
      options?: WorkerContextWaitUntilOptions<E, R2>,
    ) => schedule(effect, options, options?.mode ?? "observe"),
    waitUntilPropagating: <A, E, R, R2 = never>(
      effect: Effect.Effect<A, E, R>,
      options?: Omit<WorkerContextWaitUntilOptions<E, R2>, "mode">,
    ) => schedule(effect, options, "propagate"),
    passThroughOnException: Effect.sync(() => ctx.passThroughOnException()),
  };
};
