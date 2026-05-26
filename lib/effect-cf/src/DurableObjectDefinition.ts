import { Context, Effect, type Layer } from "effect";
import type { Schema as S } from "effect";

import * as Binding from "./Binding";
import * as DurableObjectEntrypoint from "./DurableObject";
import type { DurableObjectHandler } from "./DurableObject";
import * as DurableObjectNamespace from "./DurableObjectNamespace";
import type { DurableObjectState } from "./DurableObjectState";
import type * as Rpc from "./Rpc";
import * as RpcDefinition from "./RpcDefinition";
import type { WorkerEnvironment } from "./Environment";

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

  type EncodedArgsFromSchemas<Args extends ReadonlyArray<ServiceFreeSchema>> =
    Args extends readonly []
      ? []
      : Args extends readonly [
            infer Head extends ServiceFreeSchema,
            ...infer Tail extends ReadonlyArray<ServiceFreeSchema>,
          ]
        ? [S.Codec.Encoded<Head>, ...EncodedArgsFromSchemas<Tail>]
        : Array<S.Codec.Encoded<Args[number]>>;

  export type Args<Self extends Any> = ArgsFromSchemas<Self["args"]>;

  export type EncodedArgs<Self extends Any> = EncodedArgsFromSchemas<Self["args"]>;

  export type Success<Self extends Any> = S.Schema.Type<Self["success"]>;

  export type EncodedSuccess<Self extends Any> = S.Codec.Encoded<Self["success"]>;
}

export type Methods = Record<string, Method.Any>;

/**
 * RPC contract for a Durable Object class.
 */
export interface Definition<Id extends string = string, MethodsShape extends Methods = Methods> {
  readonly id: Id;
  readonly methods: MethodsShape;
}

export namespace Definition {
  export type Any = Definition<string, Methods>;
}

export type ReservedMethodName =
  | RpcDefinition.ReservedMethodName
  | "fetch"
  | "alarm"
  | "webSocketMessage"
  | "webSocketClose"
  | "webSocketError";

export type NoReservedMethods<MethodsShape extends Methods> =
  Extract<keyof MethodsShape, ReservedMethodName> extends never ? MethodsShape : never;

const reservedMethodNames = new Set<string>([
  "constructor",
  "dup",
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

/**
 * Promise-based client API derived from a Durable Object definition.
 */
export type ServerApi<Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Method.Args<Self["methods"][Key]>
  ) => Promise<Method.Success<Self["methods"][Key]>>;
};

export type Api<Self extends Definition.Any> = Rpc.Provider<ServerApi<Self>, ReservedMethodName>;

/**
 * Effect handlers for each RPC method in a Durable Object definition.
 */
export type Handlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Method.Args<Self["methods"][Key]>
  ) => DurableObjectHandler<ROut, Method.Success<Self["methods"][Key]>>;
};

type BoundaryHandlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Array<unknown>
  ) => DurableObjectHandler<ROut, Method.EncodedSuccess<Self["methods"][Key]>>;
};

/**
 * Durable Object constructor options for a specific RPC definition.
 */
export interface Options<ROut, Self extends Definition.Any> extends Omit<
  DurableObjectEntrypoint.DurableObjectOptions<ROut, Handlers<ROut, Self>>,
  "rpc"
> {
  readonly rpc: Handlers<ROut, Self>;
}

export type LayerOptions = {
  readonly binding: string;
};

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
    ) => DurableObjectEntrypoint.DurableObjectClass<
      Handlers<ROut, Definition<Id, MethodsShape>>,
      ROut
    >;
    readonly layer: (
      options: LayerOptions,
    ) => Layer.Layer<
      Self,
      Binding.BindingNotFoundError | Binding.BindingValidationError,
      WorkerEnvironment
    >;
  };

/**
 * Defines a single RPC method schema in a Durable Object definition.
 */
export const method = RpcDefinition.method as {
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

/**
 * Creates a Durable Object RPC definition plus implementation/binding helpers.
 *
 * @example
 * ```ts
 * const ChatRoom = DurableObjectDefinition.make("ChatRoom", {
 *   postMessage: DurableObjectDefinition.method({
 *     args: [Schema.String],
 *     success: Schema.Void,
 *   }),
 * });
 * ```
 */
const makeDefinition = <Id extends string, const MethodsShape extends Methods>(
  id: Id,
  methods: MethodsShape & NoReservedMethods<MethodsShape>,
) => {
  type SelfDefinition = Definition<Id, MethodsShape>;
  RpcDefinition.assertNoReservedMethods("Durable Object", methods, reservedMethodNames);
  const definition: SelfDefinition = RpcDefinition.make(id, methods);

  return Object.assign(definition, {
    make: <ROut, LayerError>(
      layer: Layer.Layer<ROut, LayerError, DurableObjectState | WorkerEnvironment>,
      options: Options<ROut, SelfDefinition>,
    ) =>
      DurableObjectEntrypoint.make(layer, {
        ...options,
        rpc: wrapHandlers(definition, options.rpc),
      }),
  });
};

export const make = <Id extends string, const MethodsShape extends Methods>(
  id: Id,
  methods: MethodsShape & NoReservedMethods<MethodsShape>,
) =>
  Tag<Definition<Id, MethodsShape>>()<Id, MethodsShape>(
    id,
    methods as MethodsShape & NoReservedMethods<MethodsShape>,
  );

export const Tag =
  <Self>() =>
  <Id extends string, const MethodsShape extends Methods>(
    id: Id,
    methods: MethodsShape & NoReservedMethods<MethodsShape>,
  ) => {
    const definition = makeDefinition<Id, MethodsShape>(id, methods);
    type SelfDefinition = Definition<Id, MethodsShape>;
    type ClientApi = Api<SelfDefinition>;
    const tag = Context.Service<
      Self,
      DurableObjectNamespace.DurableObjectNamespaceEffectClient<ClientApi, SelfDefinition>
    >()(id);

    const bindingDefinition = (binding: LayerOptions) => ({
      ...binding,
      definition,
    });

    const layer = (binding: LayerOptions) =>
      DurableObjectNamespace.layer<Self, ClientApi, SelfDefinition>(
        tag,
        bindingDefinition(binding),
      );

    const newUniqueId = Effect.fnUntraced(function* (
      options?: globalThis.DurableObjectNamespaceNewUniqueIdOptions,
    ) {
      const namespace = yield* tag;
      return yield* namespace.newUniqueId(options);
    });

    const idFromName = Effect.fnUntraced(function* (name: string) {
      const namespace = yield* tag;
      return yield* namespace.idFromName(name);
    });

    const idFromString = Effect.fnUntraced(function* (value: string) {
      const namespace = yield* tag;
      return yield* namespace.idFromString(value);
    });

    const get = Effect.fnUntraced(function* (
      objectId: globalThis.DurableObjectId,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) {
      const namespace = yield* tag;
      return yield* namespace.get(objectId, options);
    });

    const getByName = Effect.fnUntraced(function* (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) {
      const namespace = yield* tag;
      return yield* namespace.getByName(name, options);
    });

    const jurisdiction = Effect.fnUntraced(function* (value: globalThis.DurableObjectJurisdiction) {
      const namespace = yield* tag;
      return yield* namespace.jurisdiction(value);
    });

    const fetch = (
      stub: DurableObjectNamespace.DurableObjectStubClient<ClientApi>,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) =>
      Effect.gen(function* () {
        const namespace = yield* tag;
        return yield* namespace.fetch(stub, input, init);
      });

    const rpc = <Method extends keyof ClientApi>(
      stub: DurableObjectNamespace.DurableObjectStubClient<ClientApi>,
      method: Method,
      ...args: ClientApi[Method] extends (...args: infer Args) => unknown ? Args : never
    ) =>
      Effect.gen(function* () {
        const namespace = yield* tag;
        return yield* namespace.rpc(stub, method as never, ...(args as never));
      });

    const call = <Method extends keyof ClientApi>(
      stub: DurableObjectNamespace.DurableObjectStubClient<ClientApi>,
      method: Method,
      ...args: ClientApi[Method] extends (...args: infer Args) => unknown ? Args : never
    ) =>
      Effect.gen(function* () {
        const namespace = yield* tag;
        return yield* namespace.call(stub, method as never, ...(args as never));
      });

    const scopedCall = <Method extends keyof ClientApi>(
      stub: DurableObjectNamespace.DurableObjectStubClient<ClientApi>,
      method: Method,
      ...args: ClientApi[Method] extends (...args: infer Args) => unknown ? Args : never
    ) =>
      Effect.gen(function* () {
        const namespace = yield* tag;
        return yield* namespace.scopedCall(stub, method as never, ...(args as never));
      });

    const unsafeRaw = Effect.fnUntraced(function* () {
      const namespace = yield* tag;
      return yield* namespace.unsafeRaw;
    });

    const directMethods = DurableObjectNamespace.makeDirectMethods<Self, ClientApi, SelfDefinition>(
      definition,
      {
        call: call as never,
        fetch,
        get,
        getByName,
      },
    );

    return Object.assign(tag, directMethods, {
      id: definition.id,
      methods: definition.methods,
      make: definition.make,
      layer,
      newUniqueId,
      idFromName,
      idFromString,
      get,
      getByName,
      jurisdiction,
      fetch,
      rpc,
      call,
      scopedCall,
      unsafeRaw,
    }) as unknown as TagClass<Self, Id, MethodsShape>;
  };

export const DurableObject = Tag;

const wrapHandlers = <ROut, const Self extends Definition.Any>(
  definition: Self,
  handlers: Handlers<ROut, Self>,
): BoundaryHandlers<ROut, Self> => {
  const wrapped = {} as Record<string, unknown>;

  for (const key of Object.keys(definition.methods) as Array<
    RpcDefinition.Definition.MethodNames<Self>
  >) {
    const handler = handlers[key];
    wrapped[key] = (...args: Array<unknown>) =>
      Effect.gen(function* () {
        const decodedArgs = yield* RpcDefinition.decodeArgs(definition, key, args);
        const value = yield* handler(...decodedArgs);
        return yield* RpcDefinition.encodeSuccess(definition, key, value);
      });
  }

  return wrapped as BoundaryHandlers<ROut, Self>;
};

/**
 * Helper for implementing handlers with the exact method shape of a definition.
 */
export const implement = <ROut, const Self extends Definition.Any>(
  _definition: Self,
  handlers: Handlers<ROut, Self>,
): Handlers<ROut, Self> => handlers;

/**
 * Convenience alias for a single Durable Object RPC handler Effect.
 */
export type HandlerEffect<
  ROut,
  Self extends Definition.Any,
  Key extends keyof Self["methods"],
> = DurableObjectHandler<ROut, Method.Success<Self["methods"][Key]>>;
