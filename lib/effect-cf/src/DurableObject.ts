import { DurableObject as CloudflareDurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, type Context, type Scope } from "effect";
import type { Schema as S } from "effect";

import { NativeRequest } from "./Worker";
import { WorkerEnvironment, type WorkerEnv } from "./Environment";
import { DurableObjectState, fromDurableObjectState } from "./DurableObjectState";
import { fromWebSocket, type DurableWebSocket } from "./DurableObjectWebSocket";
import type * as Binding from "./Binding";
import * as DurableObjectDefinition from "./DurableObjectDefinition";
import type * as DurableObjectNamespace from "./DurableObjectNamespace";
import type * as Rpc from "./Rpc";
import * as Entrypoint from "./internal/Entrypoint";

const reservedMethodNames = new Set<string>([
  "constructor",
  "dup",
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

type RuntimeContext<ROut> = DurableObjectState | WorkerEnvironment | ROut;

type HandlerContext<ROut> = RuntimeContext<ROut> | Scope.Scope;

type FetchContext<ROut> = HandlerContext<ROut> | NativeRequest;

const RunSymbol = Symbol.for("effect-cf/DurableObject/run");

/**
 * Effect type for Durable Object lifecycle and RPC handlers.
 */
export type DurableObjectHandler<ROut, A = unknown> = Effect.Effect<
  A,
  unknown,
  HandlerContext<ROut>
>;

/**
 * Shape of Durable Object RPC handlers passed to {@link make}.
 */
export type DurableObjectRpc<ROut> = Record<
  string,
  (...args: Array<any>) => DurableObjectHandler<ROut>
>;

export type DurableObjectRpcShape<Rpc extends DurableObjectRpc<ROut>, ROut> = {
  readonly [Key in keyof Rpc]: Rpc[Key] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, unknown, HandlerContext<ROut>>
    ? (...args: Args) => Promise<A>
    : never;
};

export type RpcHandlers<ROut, Api> = {
  readonly [Key in keyof Api as Key extends keyof CloudflareDurableObject<WorkerEnv>
    ? never
    : Key extends string
      ? [Api[Key]] extends [never]
        ? never
        : Api[Key] extends (...args: Array<any>) => Promise<unknown>
          ? Key
          : never
      : never]: Api[Key] extends (...args: infer Args) => Promise<infer A>
    ? (...args: Args) => DurableObjectHandler<ROut, A>
    : never;
};

/**
 * Options for creating a Durable Object class backed by Effect handlers.
 */
export interface DurableObjectOptions<ROut, Rpc extends DurableObjectRpc<ROut>> {
  /**
   * Effect run when Cloudflare loads this Durable Object instance into memory.
   *
   * Use `DurableObjectState.blockConcurrencyWhile` inside this hook when
   * incoming events should wait for setup to finish. Cloudflare may construct
   * the same Durable Object id again after eviction or restart; use Durable
   * Object storage if work must happen only once per id.
   */
  readonly initialize?: Effect.Effect<void, unknown, HandlerContext<ROut>>;
  /** Optional RPC methods exposed as Durable Object instance methods. */
  readonly rpc?: Rpc;
  /** Optional fetch handler for HTTP/WebSocket requests. */
  readonly fetch?: Effect.Effect<Response, unknown, FetchContext<ROut>>;
  /**
   * Optional logical alarm processing effect.
   *
   * This runs before `alarm` and should be built with helpers such as
   * `DurableObjectAlarm.processDue(...)` so the reusable scheduler stays inside
   * the Durable Object's single managed runtime boundary.
   */
  readonly alarms?: Effect.Effect<unknown, unknown, HandlerContext<ROut>>;
  readonly alarm?: (
    alarmInfo?: globalThis.AlarmInvocationInfo,
  ) => Effect.Effect<void, unknown, HandlerContext<ROut>>;
  readonly webSocketMessage?: (
    socket: DurableWebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void, unknown, HandlerContext<ROut>>;
  readonly webSocketClose?: (
    socket: DurableWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void, unknown, HandlerContext<ROut>>;
  readonly webSocketError?: (
    socket: DurableWebSocket,
    error: unknown,
  ) => Effect.Effect<void, unknown, HandlerContext<ROut>>;
}

/**
 * Cloudflare `DurableObject` constructor produced by {@link make}.
 */
export type DurableObjectClass<Rpc extends DurableObjectRpc<ROut>, ROut> = new (
  state: globalThis.DurableObjectState,
  env: WorkerEnv,
) => CloudflareDurableObject<WorkerEnv> & DurableObjectRpcShape<Rpc, ROut>;

/**
 * Creates a Durable Object class backed by a single managed Effect runtime.
 */
export const make = <
  ROut,
  LayerError,
  const Rpc extends DurableObjectRpc<ROut> = Record<never, never>,
>(
  layer: Layer.Layer<ROut, LayerError, DurableObjectState | WorkerEnvironment>,
  options: DurableObjectOptions<ROut, Rpc> = {},
): DurableObjectClass<Rpc, ROut> => {
  class EffectDurableObject extends CloudflareDurableObject<WorkerEnv> {
    readonly runtime: ManagedRuntime.ManagedRuntime<RuntimeContext<ROut>, LayerError>;

    constructor(state: globalThis.DurableObjectState, env: WorkerEnv) {
      super(state, env);

      const services = Layer.mergeAll(
        Layer.succeed(DurableObjectState, fromDurableObjectState(state)),
        Layer.succeed(WorkerEnvironment, env),
      );

      const runtimeLayer = Entrypoint.provideEntrypointServices(layer, services);

      this.runtime = ManagedRuntime.make(runtimeLayer);

      const initialize = options.initialize;
      if (initialize !== undefined) {
        state.waitUntil(this[RunSymbol](initialize));
      }
    }

    [RunSymbol]<A, E>(effect: Effect.Effect<A, E, HandlerContext<ROut>>): Promise<A> {
      return this.runtime.runPromise(Effect.scoped(effect));
    }

    fetch(request: Request): Promise<Response> {
      const fetchHandler = options.fetch;

      if (fetchHandler === undefined) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }

      return this[RunSymbol](Effect.provideService(fetchHandler, NativeRequest, request));
    }

    alarm(alarmInfo?: globalThis.AlarmInvocationInfo): Promise<void> | void {
      const logicalAlarms = options.alarms?.pipe(Effect.asVoid);
      const rawAlarm = options.alarm?.(alarmInfo);

      if (logicalAlarms !== undefined && rawAlarm !== undefined) {
        return this[RunSymbol](
          Effect.gen(function* () {
            yield* logicalAlarms;
            yield* rawAlarm;
          }),
        );
      }

      if (logicalAlarms !== undefined) {
        return this[RunSymbol](logicalAlarms);
      }

      if (rawAlarm !== undefined) {
        return this[RunSymbol](rawAlarm);
      }
    }

    webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> | void {
      if (options.webSocketMessage !== undefined) {
        return this[RunSymbol](options.webSocketMessage(fromWebSocket(socket), message));
      }
    }

    webSocketClose(
      socket: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> | void {
      if (options.webSocketClose !== undefined) {
        return this[RunSymbol](
          options.webSocketClose(fromWebSocket(socket), code, reason, wasClean),
        );
      }
    }

    webSocketError(socket: WebSocket, error: unknown): Promise<void> | void {
      if (options.webSocketError !== undefined) {
        return this[RunSymbol](options.webSocketError(fromWebSocket(socket), error));
      }
    }
  }

  Entrypoint.defineEntrypointRpcMethods<EffectDurableObject>(
    "Durable Object",
    EffectDurableObject.prototype,
    options.rpc,
    reservedMethodNames,
    (self, effect) => self[RunSymbol](effect),
  );

  return Entrypoint.assumeEntrypointClass<DurableObjectClass<Rpc, ROut>>(EffectDurableObject);
};

export type ServiceFreeSchema = S.Codec<any, any, never, never>;

export interface Method<
  Args extends ReadonlyArray<ServiceFreeSchema> = ReadonlyArray<ServiceFreeSchema>,
  Success extends ServiceFreeSchema = ServiceFreeSchema,
> {
  readonly args: Args;
  readonly success: Success;
}

export namespace Method {
  export type Any = Method<ReadonlyArray<ServiceFreeSchema>, ServiceFreeSchema>;

  type ArgsFromSchemas<Args extends ReadonlyArray<ServiceFreeSchema>> = Args extends readonly []
    ? []
    : Args extends readonly [
          infer Head extends ServiceFreeSchema,
          ...infer Tail extends ReadonlyArray<ServiceFreeSchema>,
        ]
      ? [S.Schema.Type<Head>, ...ArgsFromSchemas<Tail>]
      : Array<S.Schema.Type<Args[number]>>;

  export type Args<Self extends Any> = ArgsFromSchemas<Self["args"]>;

  export type Success<Self extends Any> = S.Schema.Type<Self["success"]>;
}

export type Methods = Record<string, Method.Any>;

export type ReservedMethodName = DurableObjectDefinition.ReservedMethodName;

export type NoReservedMethods<MethodsShape extends Methods> =
  Extract<keyof MethodsShape, ReservedMethodName> extends never ? MethodsShape : never;

export interface Definition<Id extends string = string, MethodsShape extends Methods = Methods> {
  readonly id: Id;
  readonly methods: MethodsShape;
}

export namespace Definition {
  export type Any = Definition<string, Methods>;
}

export type LayerOptions = DurableObjectDefinition.LayerOptions;

export type ServerApi<Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Method.Args<Self["methods"][Key]>
  ) => Promise<Method.Success<Self["methods"][Key]>>;
};

export type Api<Self extends Definition.Any> = Rpc.Provider<ServerApi<Self>, ReservedMethodName>;

export type Handlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Method.Args<Self["methods"][Key]>
  ) => DurableObjectHandler<ROut, Method.Success<Self["methods"][Key]>>;
};

export interface Options<ROut, Self extends Definition.Any> extends Omit<
  DurableObjectOptions<ROut, Handlers<ROut, Self>>,
  "rpc"
> {
  readonly rpc: Handlers<ROut, Self>;
}

export type TagClass<Self, Id extends string, MethodsShape extends Methods> = Context.ServiceClass<
  Self,
  Id,
  DurableObjectNamespace.DurableObjectNamespaceEffectClient<
    Api<Definition<Id, MethodsShape>>,
    Definition<Id, MethodsShape>
  >
> &
  DurableObjectNamespace.DurableObjectNamespaceStaticClient<
    Self,
    Api<Definition<Id, MethodsShape>>,
    Definition<Id, MethodsShape>
  > & {
    readonly id: Id;
    readonly methods: MethodsShape;
    readonly make: <ROut, LayerError>(
      layer: Layer.Layer<ROut, LayerError, DurableObjectState | WorkerEnvironment>,
      options: Options<ROut, Definition<Id, MethodsShape>>,
    ) => DurableObjectClass<Handlers<ROut, Definition<Id, MethodsShape>>, ROut>;
    readonly layer: (
      options: LayerOptions,
    ) => Layer.Layer<
      Self,
      Binding.BindingNotFoundError | Binding.BindingValidationError,
      WorkerEnvironment
    >;
  };

export type TagFactory = <Self>() => <Id extends string, const MethodsShape extends Methods>(
  id: Id,
  methods: MethodsShape & NoReservedMethods<MethodsShape>,
) => TagClass<Self, Id, MethodsShape>;

export const Tag = DurableObjectDefinition.Tag as unknown as TagFactory;

export const method = DurableObjectDefinition.method as {
  <Success extends ServiceFreeSchema>(definition: {
    readonly success: Success;
  }): Method<readonly [], Success>;
  <
    const Args extends ReadonlyArray<ServiceFreeSchema>,
    Success extends ServiceFreeSchema,
  >(definition: {
    readonly args: Args;
    readonly success: Success;
  }): Method<Args, Success>;
};

export const implement = DurableObjectDefinition.implement as unknown as <
  ROut,
  const Self extends Definition.Any,
>(
  _definition: Self,
  handlers: Handlers<ROut, Self>,
) => Handlers<ROut, Self>;

export type HandlerEffect<
  ROut,
  Self extends Definition.Any,
  Key extends keyof Self["methods"],
> = DurableObjectHandler<ROut, Method.Success<Self["methods"][Key]>>;
