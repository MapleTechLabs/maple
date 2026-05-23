/**
 * The `ManagedRuntime` module provides a way to build a reusable runtime from
 * a `Layer` and use it to run effects that require the services produced by
 * that layer. A `ManagedRuntime<R, ER>` owns the lifecycle of the layer-built
 * resources, caches the resulting `Context<R>`, and exposes runners for
 * integrating Effect programs with JavaScript entry points.
 *
 * **Mental model**
 *
 * - A managed runtime is created from a `Layer` with {@link make}
 * - The layer is built lazily the first time the runtime is used
 * - The built context is cached and reused for subsequent effect executions
 * - Resources acquired by the layer are owned by the runtime's internal scope
 * - Disposing the runtime closes that scope and releases all managed resources
 * - Effects run through the runtime receive the layer's services automatically
 *
 * **Common tasks**
 *
 * - Create a runtime from application services: {@link make}
 * - Run an effect as a `Promise`: {@link ManagedRuntime.runPromise}
 * - Run an effect and keep its `Exit`: {@link ManagedRuntime.runPromiseExit}
 * - Fork an effect into a `Fiber`: {@link ManagedRuntime.runFork}
 * - Bridge callback-style APIs: {@link ManagedRuntime.runCallback}
 * - Run synchronous effects at program boundaries: {@link ManagedRuntime.runSync},
 *   {@link ManagedRuntime.runSyncExit}
 * - Access the cached service context: {@link ManagedRuntime.context}
 * - Release layer resources: {@link ManagedRuntime.dispose},
 *   {@link ManagedRuntime.disposeEffect}
 *
 * **Gotchas**
 *
 * - Always dispose a managed runtime when it is no longer needed, especially
 *   when the layer acquires resources such as connections, servers, or files
 * - Layer construction errors are included in the error channel of runtime
 *   runners, so `ER` is combined with the effect's own error type
 * - `runSync` can only execute effects without asynchronous boundaries; use
 *   `runPromise` for asynchronous programs
 * - After disposal, the runtime cannot be reused
 *
 * @since 2.0.0
 */
import type * as Context from "./Context.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import * as Fiber from "./Fiber.ts"
import * as Layer from "./Layer.ts"
import { hasProperty } from "./Predicate.ts"
import * as Scope from "./Scope.ts"
import type { Mutable } from "./Types.ts"

const TypeId = "~effect/ManagedRuntime"

/**
 * Checks if the provided argument is a `ManagedRuntime`.
 *
 * @category guards
 * @since 3.9.0
 */
export const isManagedRuntime = (input: unknown): input is ManagedRuntime<unknown, unknown> =>
  hasProperty(input, TypeId)

/**
 * Type helpers associated with `ManagedRuntime`.
 *
 * @since 3.4.0
 */
export declare namespace ManagedRuntime {
  /**
   * Extracts the services available from a `ManagedRuntime`.
   *
   * @category type-level
   * @since 3.4.0
   */
  export type Services<T extends ManagedRuntime<never, any>> = [T] extends [ManagedRuntime<infer R, infer _E>] ? R
    : never
  /**
   * Extracts the layer construction error type of a `ManagedRuntime`.
   *
   * @category type-level
   * @since 3.4.0
   */
  export type Error<T extends ManagedRuntime<never, any>> = [T] extends [ManagedRuntime<infer _R, infer E>] ? E : never
}

/**
 * A runtime built from a layer that can execute effects requiring that layer's
 * services.
 *
 * **Details**
 *
 * The runtime builds and caches its service context, owns the scope for
 * resources acquired by the layer, and should be disposed with `dispose` or
 * `disposeEffect` when it is no longer needed.
 *
 * @category models
 * @since 2.0.0
 */
export interface ManagedRuntime<in R, out ER> {
  readonly [TypeId]: typeof TypeId
  readonly memoMap: Layer.MemoMap
  readonly contextEffect: Effect.Effect<Context.Context<R>, ER>
  readonly context: () => Promise<Context.Context<R>>

  // internal
  readonly scope: Scope.Closeable
  // internal
  cachedContext: Context.Context<R> | undefined

  /**
   * Executes the effect using the provided Scheduler or using the global
   * Scheduler if not provided
   */
  readonly runFork: <A, E>(
    self: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions
  ) => Fiber.Fiber<A, E | ER>

  /**
   * Executes the effect synchronously returning the exit.
   *
   * **When to use**
   *
   * This method is effectful and should only be invoked at the edges of your
   * program.
   */
  readonly runSyncExit: <A, E>(effect: Effect.Effect<A, E, R>) => Exit.Exit<A, ER | E>

  /**
   * Executes the effect synchronously throwing in case of errors or async boundaries.
   *
   * **When to use**
   *
   * This method is effectful and should only be invoked at the edges of your
   * program.
   */
  readonly runSync: <A, E>(effect: Effect.Effect<A, E, R>) => A

  /**
   * Executes the effect asynchronously, eventually passing the exit value to
   * the specified callback.
   *
   * **When to use**
   *
   * This method is effectful and should only be invoked at the edges of your
   * program.
   */
  readonly runCallback: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?:
      | Effect.RunOptions & {
        readonly onExit: (exit: Exit.Exit<A, E | ER>) => void
      }
      | undefined
  ) => (interruptor?: number | undefined) => void

  /**
   * Runs the `Effect`, returning a JavaScript `Promise` that will be resolved
   * with the value of the effect once the effect has been executed, or will be
   * rejected with the first error or exception throw by the effect.
   *
   * **When to use**
   *
   * This method is effectful and should only be used at the edges of your
   * program.
   */
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions) => Promise<A>

  /**
   * Runs the `Effect`, returning a JavaScript `Promise` that will be resolved
   * with the `Exit` state of the effect once the effect has been executed.
   *
   * **When to use**
   *
   * This method is effectful and should only be used at the edges of your
   * program.
   */
  readonly runPromiseExit: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions
  ) => Promise<Exit.Exit<A, ER | E>>

  /**
   * Dispose of the resources associated with the runtime.
   */
  readonly dispose: () => Promise<void>

  /**
   * Dispose of the resources associated with the runtime.
   */
  readonly disposeEffect: Effect.Effect<void, never, never>
}

/**
 * Creates a `ManagedRuntime` from a layer.
 *
 * **Details**
 *
 * The layer is built lazily on first use and its context is cached for
 * subsequent runs. Resources acquired by the layer are owned by the runtime and
 * are released when `dispose` or `disposeEffect` is run.
 *
 * **Example** (Creating a managed runtime)
 *
 * ```ts
 * import { Context, Effect, Layer, ManagedRuntime } from "effect"
 *
 * class Notifications extends Context.Service<Notifications, {
 *   readonly notify: (message: string) => Effect.Effect<void>
 * }>()("Notifications") {
 *   static readonly layer = Layer.succeed(this)({
 *     notify: Effect.fn("Notifications.notify")((message) =>
 *       Effect.sync(() => console.log(message))
 *     )
 *   })
 * }
 *
 * const runtime = ManagedRuntime.make(Notifications.layer)
 *
 * const program = Effect.flatMap(
 *   Notifications,
 *   (_) => _.notify("Hello, world!")
 * ).pipe(Effect.ensuring(runtime.disposeEffect))
 *
 * runtime.runPromise(program)
 * // Hello, world!
 * ```
 *
 * @category runtime class
 * @since 2.0.0
 */
export const make = <R, ER>(
  layer: Layer.Layer<R, ER, never>,
  options?: {
    readonly memoMap?: Layer.MemoMap | undefined
  } | undefined
): ManagedRuntime<R, ER> => {
  const memoMap = options?.memoMap ?? Layer.makeMemoMapUnsafe()
  const scope = Scope.makeUnsafe("parallel")
  const layerScope = Scope.forkUnsafe(scope, "sequential")
  const defaultRunOptions: Effect.RunOptions = {
    onFiberStart: Fiber.runIn(scope)
  }
  const mergeRunOptions = <O extends Effect.RunOptions>(options?: O): O =>
    options
      ? {
        ...options,
        onFiberStart: options.onFiberStart ?
          (fiber) => {
            defaultRunOptions.onFiberStart!(fiber)
            options.onFiberStart!(fiber)
          } :
          defaultRunOptions.onFiberStart
      }
      : defaultRunOptions as O
  let buildFiber: Fiber.Fiber<Context.Context<R>, ER> | undefined
  const contextEffect = Effect.withFiber<Context.Context<R>, ER>((fiber) => {
    if (!buildFiber) {
      buildFiber = Effect.runFork(
        Effect.tap(
          Layer.buildWithMemoMap(layer, memoMap, layerScope),
          (context) =>
            Effect.sync(() => {
              self.cachedContext = context
            })
        ),
        { ...defaultRunOptions, scheduler: fiber.currentScheduler }
      )
    }
    return Effect.flatten(Fiber.await(buildFiber))
  })
  const self: ManagedRuntime<R, ER> = {
    [TypeId]: TypeId,
    memoMap,
    scope,
    contextEffect: contextEffect,
    cachedContext: undefined,
    context() {
      return self.cachedContext === undefined ?
        Effect.runPromise(self.contextEffect) :
        Promise.resolve(self.cachedContext)
    },
    dispose(): Promise<void> {
      return Effect.runPromise(self.disposeEffect)
    },
    disposeEffect: Effect.suspend(() => {
      ;(self as Mutable<ManagedRuntime<R, ER>>).contextEffect = Effect.die("ManagedRuntime disposed")
      self.cachedContext = undefined
      return Scope.close(self.scope, Exit.void)
    }),
    runFork<A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions): Fiber.Fiber<A, E | ER> {
      return self.cachedContext === undefined ?
        Effect.runFork(provide(self, effect), mergeRunOptions(options)) :
        Effect.runForkWith(self.cachedContext)(effect, mergeRunOptions(options))
    },
    runCallback<A, E>(
      effect: Effect.Effect<A, E, R>,
      options?: Effect.RunOptions & {
        readonly onExit: (exit: Exit.Exit<A, E | ER>) => void
      }
    ): (interruptor?: number | undefined) => void {
      return self.cachedContext === undefined ?
        Effect.runCallback(provide(self, effect), mergeRunOptions(options)) :
        Effect.runCallbackWith(self.cachedContext)(effect, mergeRunOptions(options))
    },
    runSyncExit<A, E>(effect: Effect.Effect<A, E, R>): Exit.Exit<A, E | ER> {
      return self.cachedContext === undefined ?
        Effect.runSyncExit(provide(self, effect)) :
        Effect.runSyncExitWith(self.cachedContext)(effect)
    },
    runSync<A, E>(effect: Effect.Effect<A, E, R>): A {
      return self.cachedContext === undefined ?
        Effect.runSync(provide(self, effect)) :
        Effect.runSyncWith(self.cachedContext)(effect)
    },
    runPromiseExit<A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions): Promise<Exit.Exit<A, E | ER>> {
      return self.cachedContext === undefined ?
        Effect.runPromiseExit(provide(self, effect), mergeRunOptions(options)) :
        Effect.runPromiseExitWith(self.cachedContext)(effect, mergeRunOptions(options))
    },
    runPromise<A, E>(effect: Effect.Effect<A, E, R>, options?: {
      readonly signal?: AbortSignal | undefined
    }): Promise<A> {
      return self.cachedContext === undefined ?
        Effect.runPromise(provide(self, effect), mergeRunOptions(options)) :
        Effect.runPromiseWith(self.cachedContext)(effect, mergeRunOptions(options))
    }
  }
  return self
}

function provide<R, ER, A, E>(
  managed: ManagedRuntime<R, ER>,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | ER> {
  return Effect.flatMap(
    managed.contextEffect,
    (context) => Effect.provideContext(effect, context)
  )
}
