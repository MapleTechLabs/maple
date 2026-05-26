import { Context, Data, Effect, type Scope } from "effect";

import * as Binding from "./Binding";
import * as CloudflareRpc from "./Rpc";
import * as RpcDefinition from "./RpcDefinition";
import type * as WorkerDefinition from "./WorkerDefinition";
import * as RpcInvocation from "./internal/RpcInvocation";

const TypeId = "effect-cf/ServiceBinding" as const;
const expectedServiceBinding = "Worker service binding with fetch()";

/**
 * Minimum shape for a Cloudflare service binding.
 */
export interface ServiceFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type RpcClient<Api> = {
  readonly [Key in keyof Api as Key extends string
    ? Api[Key] extends (...args: Array<any>) => unknown
      ? Key
      : never
    : never]: Api[Key];
};

type ReservedMethodName = WorkerDefinition.ReservedMethodName | "fetch";

/**
 * Native Cloudflare service object including optional RPC methods.
 */
export type ServiceBindingClient<Api extends object> = ServiceFetcher &
  RpcClient<CloudflareRpc.Provider<Api, ReservedMethodName>>;

type ApiFromDefinition<Definition> = Definition extends WorkerDefinition.Definition.Any
  ? WorkerDefinition.ServerApi<Definition>
  : never;

type ApiOrDefinition<Api extends object, Definition> = [Api] extends [never]
  ? ApiFromDefinition<Definition>
  : Api;

/**
 * Binding metadata used to create an Effect service from a Worker binding.
 */
export interface ServiceBindingDefinition<
  Definition extends WorkerDefinition.Definition.Any | undefined = undefined,
> {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
  /** Optional RPC schema used for argument/result encoding. */
  readonly definition?: Definition;
}

/**
 * Failure raised when calling `fetch` on a service binding.
 */
export class ServiceBindingFetchError extends Data.TaggedError("ServiceBindingFetchError")<{
  readonly binding: string;
  readonly cause: unknown;
}> {}

/**
 * Failure raised when invoking an RPC method on a service binding.
 */
export class ServiceBindingRpcError extends Data.TaggedError("ServiceBindingRpcError")<{
  readonly binding: string;
  readonly method: string;
  readonly cause: unknown;
}> {}

type ServiceMethodKey<Api> = RpcInvocation.AsyncMethodKey<Api>;
type ServiceMethodArgs<Api, Method extends keyof Api> = RpcInvocation.AsyncMethodArgs<Api, Method>;
type ServiceMethodSuccess<Api, Method extends keyof Api> = RpcInvocation.AsyncMethodSuccess<
  Api,
  Method
>;
type ServiceMethodCloudflareReturn<
  Api,
  Method extends keyof Api,
> = RpcInvocation.AsyncMethodCloudflareReturn<Api, Method>;

type ServiceCall<R, Api> = <Method extends ServiceMethodKey<Api>>(
  method: Method,
  ...args: ServiceMethodArgs<Api, Method>
) => Effect.Effect<ServiceMethodSuccess<Api, Method>, ServiceBindingRpcError, R>;

type DefinitionDirectMethods<R, Definition extends WorkerDefinition.Definition.Any> = {
  readonly [Method in RpcDefinition.Definition.MethodNames<Definition>]: (
    ...args: RpcDefinition.Method.Args<Definition["methods"][Method]>
  ) => Effect.Effect<
    RpcDefinition.Method.Success<Definition["methods"][Method]>,
    ServiceBindingRpcError,
    R
  >;
};

type DirectMethods<R, Definition> = Definition extends WorkerDefinition.Definition.Any
  ? DefinitionDirectMethods<R, Definition>
  : {};

export type ServiceBindingEffectClient<
  Api extends object,
  Definition extends WorkerDefinition.Definition.Any | undefined = undefined,
> = DirectMethods<never, Definition> & {
  /**
   * Forwards an HTTP request to the bound Worker service.
   *
   * Use this when the service binding is acting as an HTTP origin rather than a
   * Cloudflare RPC target.
   *
   * @example
   * ```ts
   * import { Effect } from "effect";
   *
   * const program = Effect.gen(function* () {
   *   const api = yield* ApiWorker;
   *   return yield* api.fetch(new Request("https://internal.example/users"));
   * });
   * ```
   */
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<globalThis.Response, ServiceBindingFetchError>;
  /**
   * Invokes a Worker RPC method and returns Cloudflare's raw RPC result.
   *
   * This preserves Cloudflare RPC behavior such as promise-like pipelining and
   * transferable / disposable result objects. It does not resolve the returned
   * promise-like value and it does not decode definition-backed success schemas.
   *
   * Most application code should use {@link call} instead.
   *
   * @example
   * ```ts
   * import { Effect } from "effect";
   *
   * const program = Effect.gen(function* () {
   *   const counter = yield* CounterService;
   *
   *   const result = yield* counter.rpc("increment", 41);
   *   const value = yield* Effect.promise(() => result);
   *
   *   return value;
   * });
   * ```
   */
  readonly rpc: <Method extends ServiceMethodKey<Api>>(
    method: Method,
    ...args: ServiceMethodArgs<Api, Method>
  ) => Effect.Effect<ServiceMethodCloudflareReturn<Api, Method>, ServiceBindingRpcError>;
  /**
   * Invokes a Worker RPC method, resolves Cloudflare's RPC result, and decodes
   * the success value when the binding was created from a definition.
   *
   * This is the normal choice when application code wants the final typed value.
   *
   * @example
   * ```ts
   * import { Effect } from "effect";
   *
   * const program = Effect.gen(function* () {
   *   const counter = yield* CounterService;
   *   const value = yield* counter.call("increment", 41);
   *
   *   return value;
   * });
   * ```
   */
  readonly call: <Method extends ServiceMethodKey<Api>>(
    method: Method,
    ...args: ServiceMethodArgs<Api, Method>
  ) => Effect.Effect<ServiceMethodSuccess<Api, Method>, ServiceBindingRpcError>;
  /**
   * Invokes a Worker RPC method in the current `Scope`, resolves Cloudflare's RPC
   * result, decodes definition-backed success values, and disposes the resolved
   * result when the scope closes if it implements `Symbol.dispose`.
   *
   * Use this for RPC methods that return Cloudflare RPC resources or other
   * disposable objects whose lifetime should be tied to an Effect scope.
   *
   * @example
   * ```ts
   * import { Effect } from "effect";
   *
   * const program = Effect.scoped(
   *   Effect.gen(function* () {
   *     const files = yield* FileService;
   *     const handle = yield* files.scopedCall("open", "report.csv");
   *
   *     return yield* handle.read();
   *   }),
   * );
   * ```
   */
  readonly scopedCall: <Method extends ServiceMethodKey<Api>>(
    method: Method,
    ...args: ServiceMethodArgs<Api, Method>
  ) => Effect.Effect<Awaited<ServiceMethodSuccess<Api, Method>>, unknown, Scope.Scope>;
};

export type ServiceBindingStaticClient<
  R,
  Api extends object,
  Definition extends WorkerDefinition.Definition.Any | undefined = undefined,
> = DirectMethods<R, Definition> & {
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<globalThis.Response, ServiceBindingFetchError, R>;
  readonly rpc: <Method extends ServiceMethodKey<Api>>(
    method: Method,
    ...args: ServiceMethodArgs<Api, Method>
  ) => Effect.Effect<ServiceMethodCloudflareReturn<Api, Method>, ServiceBindingRpcError, R>;
  readonly call: <Method extends ServiceMethodKey<Api>>(
    method: Method,
    ...args: ServiceMethodArgs<Api, Method>
  ) => Effect.Effect<ServiceMethodSuccess<Api, Method>, ServiceBindingRpcError, R>;
  readonly scopedCall: <Method extends ServiceMethodKey<Api>>(
    method: Method,
    ...args: ServiceMethodArgs<Api, Method>
  ) => Effect.Effect<Awaited<ServiceMethodSuccess<Api, Method>>, unknown, Scope.Scope | R>;
};

export const isServiceBindingClient = <Api extends object>(
  value: unknown,
): value is ServiceBindingClient<Api> =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "fetch") === "function";

export const makeClient = <
  Api extends object,
  const Definition extends WorkerDefinition.Definition.Any | undefined = undefined,
>(
  definition: ServiceBindingDefinition<Definition>,
): ((service: ServiceBindingClient<Api>) => ServiceBindingEffectClient<Api, Definition>) => {
  return (service: ServiceBindingClient<Api>) => {
    const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      Effect.tryPromise({
        try: () => service.fetch(input, init),
        catch: (cause) => new ServiceBindingFetchError({ binding: definition.binding, cause }),
      });

    const rpc = <Method extends ServiceMethodKey<Api>>(
      method: Method,
      ...args: ServiceMethodArgs<Api, Method>
    ) =>
      Effect.gen(function* () {
        const methodName = String(method);
        const encodedArgs =
          definition.definition === undefined
            ? args
            : yield* RpcDefinition.encodeArgs(
                definition.definition,
                methodName as RpcDefinition.Definition.MethodNames<NonNullable<Definition>>,
                args as never,
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServiceBindingRpcError({
                      binding: definition.binding,
                      method: methodName,
                      cause,
                    }),
                ),
              );

        return yield* RpcInvocation.invokeRpcMethod(
          service,
          method,
          encodedArgs as ServiceMethodArgs<Api, Method>,
          (cause) =>
            new ServiceBindingRpcError({
              binding: definition.binding,
              method: methodName,
              cause,
            }),
        );
      });

    const decodeSuccess = <Method extends ServiceMethodKey<Api>>(
      methodName: string,
      value: Awaited<ServiceMethodCloudflareReturn<Api, Method>>,
    ) =>
      Effect.gen(function* () {
        if (definition.definition === undefined) {
          return value as ServiceMethodSuccess<Api, Method>;
        }

        const decoded = yield* RpcDefinition.decodeSuccess(
          definition.definition,
          methodName as RpcDefinition.Definition.MethodNames<NonNullable<Definition>>,
          value,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ServiceBindingRpcError({
                binding: definition.binding,
                method: methodName,
                cause,
              }),
          ),
        );

        return decoded as ServiceMethodSuccess<Api, Method>;
      });

    const call = <Method extends ServiceMethodKey<Api>>(
      method: Method,
      ...args: ServiceMethodArgs<Api, Method>
    ) =>
      Effect.gen(function* () {
        const methodName = String(method);
        const value = yield* CloudflareRpc.resolve(yield* rpc(method, ...args)).pipe(
          Effect.mapError(
            (cause) =>
              new ServiceBindingRpcError({
                binding: definition.binding,
                method: methodName,
                cause,
              }),
          ),
        );

        return yield* decodeSuccess<Method>(methodName, value);
      });

    const scopedCall = <Method extends ServiceMethodKey<Api>>(
      method: Method,
      ...args: ServiceMethodArgs<Api, Method>
    ) =>
      Effect.gen(function* () {
        const methodName = String(method);
        const result = yield* rpc(method, ...args);
        const value = yield* CloudflareRpc.scoped(result);
        return yield* decodeSuccess<Method>(methodName, value);
      });

    const directMethods = makeDirectMethods<never, Api, Definition>(definition.definition, call);

    return Object.assign(directMethods, {
      fetch,
      rpc,
      call,
      scopedCall,
    }) as ServiceBindingEffectClient<Api, Definition>;
  };
};

export const layer = <
  Self,
  Api extends object,
  const Definition extends WorkerDefinition.Definition.Any | undefined = undefined,
>(
  tag: Context.Service<Self, ServiceBindingEffectClient<Api, Definition>>,
  definition: ServiceBindingDefinition<Definition>,
) =>
  Binding.layer(
    tag,
    definition.binding,
    (value): value is ServiceBindingClient<Api> => isServiceBindingClient<Api>(value),
    makeClient<Api, Definition>(definition),
    { expected: expectedServiceBinding },
  );

/**
 * Creates a typed Effect service for a Worker service binding.
 *
 * Returned value includes:
 * - a Context tag for dependency injection
 * - `fetch(...)` for raw HTTP forwarding
 * - `rpc(...)` for raw Cloudflare RPC results
 * - `call(...)` for resolved and decoded RPC results
 * - `scopedCall(...)` for scoped and decoded disposable RPC results
 * - direct RPC methods when `definition` is provided
 *
 * @example
 * ```ts
 * const Counter = WorkerDefinition.make("Counter", {
 *   increment: WorkerDefinition.method({
 *     args: [Schema.Number],
 *     success: Schema.Number,
 *   }),
 * });
 *
 * const CounterLive = Counter.layer({ binding: "COUNTER" });
 *
 * const program = Effect.gen(function* () {
 *   const counter = yield* Counter;
 *   const next = yield* counter.increment(1);
 *   return next;
 * });
 * ```
 */
export const Service =
  <Self, Api extends object = never>() =>
  <
    Id extends string,
    const Definition extends WorkerDefinition.Definition.Any | undefined = undefined,
  >(
    id: Id,
    definition: ServiceBindingDefinition<Definition>,
  ) => {
    type ServiceApi = ApiOrDefinition<Api, Definition>;

    const tag = Binding.Service<Self>()(
      id,
      definition.binding,
      (value): value is ServiceBindingClient<ServiceApi> => isServiceBindingClient(value),
      makeClient<ServiceApi, Definition>(definition),
    );

    const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      Effect.gen(function* () {
        const service = yield* tag;
        return yield* service.fetch(input, init);
      });

    const rpc = <Method extends ServiceMethodKey<ServiceApi>>(
      method: Method,
      ...args: ServiceMethodArgs<ServiceApi, Method>
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;
        return yield* service.rpc(method, ...args);
      });

    const call = <Method extends ServiceMethodKey<ServiceApi>>(
      method: Method,
      ...args: ServiceMethodArgs<ServiceApi, Method>
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;
        return yield* service.call(method, ...args);
      });

    const scopedCall = <Method extends ServiceMethodKey<ServiceApi>>(
      method: Method,
      ...args: ServiceMethodArgs<ServiceApi, Method>
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;
        return yield* service.scopedCall(method, ...args);
      });

    const directMethods = makeDirectMethods<Self, ServiceApi, Definition>(
      definition.definition,
      call,
    );

    return Object.assign(tag, directMethods, {
      [TypeId]: TypeId,
      definition,
      fetch,
      rpc,
      call,
      scopedCall,
    }) as typeof tag &
      DirectMethods<Self, Definition> & {
        readonly [TypeId]: typeof TypeId;
        readonly definition: ServiceBindingDefinition<Definition>;
        readonly fetch: typeof fetch;
        readonly rpc: typeof rpc;
        readonly call: typeof call;
        readonly scopedCall: typeof scopedCall;
      };
  };

export const makeDirectMethods = <
  R,
  Api,
  Definition extends WorkerDefinition.Definition.Any | undefined,
>(
  rpcDefinition: Definition | undefined,
  call: ServiceCall<R, Api>,
): DirectMethods<R, Definition> => {
  const methods = {} as Record<string, unknown>;

  if (rpcDefinition !== undefined) {
    for (const methodName of Object.keys(rpcDefinition.methods)) {
      methods[methodName] = (...args: Array<unknown>) =>
        (call as (method: string, ...args: Array<unknown>) => unknown)(methodName, ...args);
    }
  }

  return methods as DirectMethods<R, Definition>;
};
