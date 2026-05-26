import { WorkerEntrypoint as CloudflareWorkerEntrypoint } from "cloudflare:workers";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, type Scope } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import { WorkerEnvironment, type WorkerEnv } from "./Environment";

/**
 * Access to Cloudflare's native `ExecutionContext`.
 */
export class ExecutionContext extends Context.Service<
  ExecutionContext,
  globalThis.ExecutionContext
>()("effect-cf/ExecutionContext") {}

/**
 * Options for {@link WorkerContextService.waitUntil}.
 */
export interface WorkerContextWaitUntilOptions<E, R> {
  /** Custom failure handler for the background effect. */
  readonly onFailure?: (cause: Cause.Cause<E>) => Effect.Effect<void, never, R>;
}

/**
 * Effect wrapper around `ExecutionContext` background APIs.
 */
export interface WorkerContextService {
  readonly raw: globalThis.ExecutionContext;
  waitUntil<A, E, R, R2 = never>(
    effect: Effect.Effect<A, E, R>,
    options?: WorkerContextWaitUntilOptions<E, R2>,
  ): Effect.Effect<void, never, R | R2>;
  readonly passThroughOnException: Effect.Effect<void>;
}

/**
 * Service used inside handlers to schedule background work via `waitUntil`.
 *
 * @example
 * ```ts
 * const handler = Effect.gen(function* () {
 *   const ctx = yield* WorkerContext;
 *   yield* ctx.waitUntil(Effect.log("flush analytics"));
 *   return new Response("ok");
 * });
 * ```
 */
export class WorkerContext extends Context.Service<WorkerContext, WorkerContextService>()(
  "effect-cf/WorkerContext",
) {}

type RunWaitUntilEffect = <A, E>(
  effect: Effect.Effect<A, E, never>,
) => Promise<Exit.Exit<A, unknown>>;

const fromExecutionContext = (
  ctx: globalThis.ExecutionContext,
  runPromiseExit: RunWaitUntilEffect,
): WorkerContextService => ({
  raw: ctx,
  waitUntil: <A, E, R, R2 = never>(
    effect: Effect.Effect<A, E, R>,
    options?: WorkerContextWaitUntilOptions<E, R2>,
  ) =>
    Effect.context<R | R2>().pipe(
      Effect.flatMap((context) =>
        Effect.sync(() => {
          const observed = Effect.exit(effect).pipe(
            Effect.flatMap((exit) => {
              if (Exit.isSuccess(exit)) {
                return Effect.void;
              }

              const handleFailure =
                options?.onFailure?.(exit.cause) ??
                Effect.logError("WorkerContext.waitUntil failed", Cause.pretty(exit.cause));

              return handleFailure.pipe(
                Effect.catchCause((handlerCause) =>
                  Effect.logError(
                    "WorkerContext.waitUntil failure handler failed",
                    Cause.pretty(exit.cause),
                    Cause.pretty(handlerCause),
                  ),
                ),
              );
            }),
          );

          ctx.waitUntil(
            runPromiseExit(Effect.scoped(Effect.provideContext(observed, context))).then((exit) => {
              if (Exit.isFailure(exit)) {
                console.error(
                  "WorkerContext.waitUntil failure handler failed",
                  Cause.pretty(exit.cause),
                );
              }
            }),
          );
        }),
      ),
    ),
  passThroughOnException: Effect.sync(() => ctx.passThroughOnException()),
});

/**
 * Access to the incoming `Request` currently handled by a worker or Durable Object fetch.
 */
export class NativeRequest extends Context.Service<NativeRequest, Request>()(
  "effect-cf/NativeRequest",
) {}

/**
 * Returns `true` when the request is a websocket upgrade request.
 */
export const isWebSocketUpgrade = (request: Request): boolean =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket";

type RequestServices = ExecutionContext | WorkerContext | WorkerEnvironment;

type HandlerContext<ROut> =
  | ExecutionContext
  | WorkerContext
  | WorkerEnvironment
  | NativeRequest
  | HttpServerRequest.HttpServerRequest
  | ROut
  | Scope.Scope;

type RuntimeContext<ROut> = RequestServices | ROut;
type RpcContext<ROut> = RuntimeContext<ROut> | Scope.Scope;

const RunSymbol = Symbol.for("effect-cf/Worker/run");

/**
 * Effect type for `fetch` handlers executed by {@link make}.
 */
export type WorkerHandler<ROut, A = unknown> = Effect.Effect<A, unknown, HandlerContext<ROut>>;

/**
 * Effect type for worker RPC handlers.
 */
export type WorkerRpcHandler<ROut, A = unknown> = Effect.Effect<A, unknown, RpcContext<ROut>>;

/**
 * Shape of worker RPC handlers passed to {@link make}.
 */
export type WorkerRpc<ROut> = Record<string, (...args: Array<any>) => WorkerRpcHandler<ROut>>;

export type WorkerRpcShape<Rpc extends WorkerRpc<ROut>, ROut> = {
  readonly [Key in keyof Rpc]: Rpc[Key] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, unknown, RpcContext<ROut>>
    ? (...args: Args) => Promise<A>
    : never;
};

export type RpcHandlers<ROut, Api> = {
  readonly [Key in keyof Api as Key extends keyof CloudflareWorkerEntrypoint
    ? never
    : Key extends string
      ? [Api[Key]] extends [never]
        ? never
        : Api[Key] extends (...args: Array<any>) => Promise<unknown>
          ? Key
          : never
      : never]: Api[Key] extends (...args: infer Args) => Promise<infer A>
    ? (...args: Args) => WorkerRpcHandler<ROut, A>
    : never;
};

/**
 * Options for creating a worker class with Effect handlers.
 */
export interface WorkerOptions<ROut, Rpc extends WorkerRpc<ROut>> {
  /** Main request handler. */
  readonly fetch: Effect.Effect<Response, unknown, HandlerContext<ROut>>;
  /** Optional RPC methods exposed as class instance methods. */
  readonly rpc?: Rpc;
}

/**
 * Cloudflare `WorkerEntrypoint` constructor produced by {@link make}.
 */
export type WorkerClass<Rpc extends WorkerRpc<ROut>, ROut> = new (
  ctx: globalThis.ExecutionContext,
  env: WorkerEnv,
) => CloudflareWorkerEntrypoint<WorkerEnv> & WorkerRpcShape<Rpc, ROut>;

/**
 * Creates a Cloudflare worker class backed by a single managed Effect runtime.
 *
 * @example
 * ```ts
 * const Worker = Entry.make(Layer.empty, {
 *   fetch: Effect.succeed(new Response("ok")),
 * });
 * ```
 */
export const make = <ROut, LayerError, const Rpc extends WorkerRpc<ROut> = Record<never, never>>(
  layer: Layer.Layer<ROut, LayerError, RequestServices>,
  options: WorkerOptions<ROut, Rpc>,
): WorkerClass<Rpc, ROut> => {
  class EffectWorker extends CloudflareWorkerEntrypoint<WorkerEnv> {
    readonly runtime: ManagedRuntime.ManagedRuntime<RuntimeContext<ROut>, LayerError>;

    constructor(ctx: globalThis.ExecutionContext, env: WorkerEnv) {
      super(ctx, env);

      let runWaitUntilEffect: RunWaitUntilEffect = () =>
        Promise.resolve(Exit.die(new Error("WorkerContext runtime is not initialized")));

      const services = Layer.mergeAll(
        Layer.succeed(ExecutionContext, ctx),
        Layer.succeed(
          WorkerContext,
          fromExecutionContext(ctx, (effect) => runWaitUntilEffect(effect)),
        ),
        Layer.succeed(WorkerEnvironment, env),
      );

      const runtimeLayer = layer.pipe(Layer.provideMerge(services)) as Layer.Layer<
        RuntimeContext<ROut>,
        LayerError,
        never
      >;

      this.runtime = ManagedRuntime.make(runtimeLayer);
      runWaitUntilEffect = <A, E>(effect: Effect.Effect<A, E, never>) =>
        this.runtime.runPromiseExit(effect as Effect.Effect<A, E, RuntimeContext<ROut>>);
    }

    [RunSymbol]<A, E>(effect: Effect.Effect<A, E, RuntimeContext<ROut> | Scope.Scope>): Promise<A> {
      return this.runtime.runPromise(Effect.scoped(effect));
    }

    fetch(request: Request): Promise<Response> {
      return this[RunSymbol](
        options.fetch.pipe(
          Effect.provideService(NativeRequest, request),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
        ),
      );
    }
  }

  for (const [key, method] of Object.entries(options.rpc ?? {})) {
    Object.defineProperty(EffectWorker.prototype, key, {
      enumerable: true,
      value(this: EffectWorker, ...args: Array<any>) {
        return this[RunSymbol](Effect.suspend(() => method(...args)));
      },
    });
  }

  return EffectWorker as WorkerClass<Rpc, ROut>;
};
