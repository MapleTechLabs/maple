import { Data, Effect, Schema as S } from "effect";

import type * as Rpc from "./Rpc";

export class RpcReservedMethodNameError extends Data.TaggedError("RpcReservedMethodNameError")<{
  readonly definition: string;
  readonly method: string;
}> {}

export class RpcArgumentCountError extends Data.TaggedError("RpcArgumentCountError")<{
  readonly definition: string;
  readonly method: string;
  readonly expected: number;
  readonly actual: number;
}> {}

export class RpcArgumentDecodeError extends Data.TaggedError("RpcArgumentDecodeError")<{
  readonly definition: string;
  readonly method: string;
  readonly index: number;
  readonly cause: unknown;
}> {}

export class RpcArgumentEncodeError extends Data.TaggedError("RpcArgumentEncodeError")<{
  readonly definition: string;
  readonly method: string;
  readonly index: number;
  readonly cause: unknown;
}> {}

export class RpcSuccessDecodeError extends Data.TaggedError("RpcSuccessDecodeError")<{
  readonly definition: string;
  readonly method: string;
  readonly cause: unknown;
}> {}

export class RpcSuccessEncodeError extends Data.TaggedError("RpcSuccessEncodeError")<{
  readonly definition: string;
  readonly method: string;
  readonly cause: unknown;
}> {}

export const reservedMethodNames = new Set([
  "constructor",
  "fetch",
  "connect",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
  "then",
  "dup",
  "dispose",
  "serialize",
  "deserialize",
]);

export type ReservedMethodName =
  | "constructor"
  | "fetch"
  | "connect"
  | "alarm"
  | "webSocketMessage"
  | "webSocketClose"
  | "webSocketError"
  | "then"
  | "dup"
  | "dispose"
  | "serialize"
  | "deserialize";

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

export type NoReservedMethods<
  MethodsShape extends Methods,
  Reserved extends string = ReservedMethodName,
> = Extract<keyof MethodsShape, Reserved> extends never ? MethodsShape : never;

export interface Definition<Id extends string = string, MethodsShape extends Methods = Methods> {
  readonly id: Id;
  readonly methods: MethodsShape;
}

export namespace Definition {
  export type Any = Definition<string, Methods>;

  export type ServerApi<Self extends Any> = {
    readonly [Key in keyof Self["methods"]]: (
      ...args: Method.Args<Self["methods"][Key]>
    ) => Promise<Method.Success<Self["methods"][Key]>>;
  };

  export type Api<Self extends Any, Reserved extends string = never> = Rpc.Provider<
    ServerApi<Self>,
    Reserved
  >;

  export type MethodNames<Self extends Any> = Extract<keyof Self["methods"], string>;
}

export class ReservedMethodNameError extends Error {
  readonly method: string;
  readonly target: string;

  constructor(target: string, method: string) {
    super(`${target} RPC method "${method}" is reserved by Cloudflare Workers RPC`);
    this.name = "ReservedMethodNameError";
    this.target = target;
    this.method = method;
  }
}

export const assertNoReservedMethods = (
  target: string,
  methods: Record<string, unknown>,
  reserved: ReadonlySet<string>,
) => {
  for (const method of Object.keys(methods)) {
    if (reserved.has(method)) {
      throw new ReservedMethodNameError(target, method);
    }
  }
};

export function method<Success extends ServiceFreeSchema>(definition: {
  readonly success: Success;
}): Method<readonly [], Success>;
export function method<
  const Args extends ReadonlyArray<ServiceFreeSchema>,
  Success extends ServiceFreeSchema,
>(definition: { readonly args: Args; readonly success: Success }): Method<Args, Success>;
export function method(definition: {
  readonly args?: ReadonlyArray<ServiceFreeSchema>;
  readonly success: ServiceFreeSchema;
}) {
  return {
    args: definition.args ?? [],
    success: definition.success,
  };
}

export const assertNoReservedMethodNames = (
  definition: Definition.Any,
): Effect.Effect<void, RpcReservedMethodNameError> =>
  Effect.forEach(Object.keys(definition.methods), (method) =>
    reservedMethodNames.has(method)
      ? Effect.fail(new RpcReservedMethodNameError({ definition: definition.id, method }))
      : Effect.void,
  ).pipe(Effect.asVoid);

export const decodeArgs = <
  const Self extends Definition.Any,
  MethodName extends Definition.MethodNames<Self>,
>(
  definition: Self,
  methodName: MethodName,
  args: ReadonlyArray<unknown>,
): Effect.Effect<
  Method.Args<Self["methods"][MethodName]>,
  RpcArgumentCountError | RpcArgumentDecodeError
> =>
  Effect.gen(function* () {
    const methodDefinition = definition.methods[methodName];

    if (args.length !== methodDefinition.args.length) {
      return yield* Effect.fail(
        new RpcArgumentCountError({
          definition: definition.id,
          method: methodName,
          expected: methodDefinition.args.length,
          actual: args.length,
        }),
      );
    }

    const decoded: Array<unknown> = [];

    for (let index = 0; index < methodDefinition.args.length; index++) {
      const schema = methodDefinition.args[index];
      decoded.push(
        yield* (S.decodeUnknownEffect(schema)(args[index]) as Effect.Effect<unknown, unknown>).pipe(
          Effect.mapError(
            (cause) =>
              new RpcArgumentDecodeError({
                definition: definition.id,
                method: methodName,
                index,
                cause,
              }),
          ),
        ),
      );
    }

    return decoded as Method.Args<Self["methods"][MethodName]>;
  });

export const encodeArgs = <
  const Self extends Definition.Any,
  MethodName extends Definition.MethodNames<Self>,
>(
  definition: Self,
  methodName: MethodName,
  args: Method.Args<Self["methods"][MethodName]>,
): Effect.Effect<
  Method.EncodedArgs<Self["methods"][MethodName]>,
  RpcArgumentCountError | RpcArgumentEncodeError
> =>
  Effect.gen(function* () {
    const methodDefinition = definition.methods[methodName];

    if (args.length !== methodDefinition.args.length) {
      return yield* Effect.fail(
        new RpcArgumentCountError({
          definition: definition.id,
          method: methodName,
          expected: methodDefinition.args.length,
          actual: args.length,
        }),
      );
    }

    const encoded: Array<unknown> = [];

    for (let index = 0; index < methodDefinition.args.length; index++) {
      const schema = methodDefinition.args[index];
      encoded.push(
        yield* (S.encodeEffect(schema)(args[index]) as Effect.Effect<unknown, unknown>).pipe(
          Effect.mapError(
            (cause) =>
              new RpcArgumentEncodeError({
                definition: definition.id,
                method: methodName,
                index,
                cause,
              }),
          ),
        ),
      );
    }

    return encoded as Method.EncodedArgs<Self["methods"][MethodName]>;
  });

export const encodeSuccess = <
  const Self extends Definition.Any,
  MethodName extends Definition.MethodNames<Self>,
>(
  definition: Self,
  methodName: MethodName,
  value: Method.Success<Self["methods"][MethodName]>,
): Effect.Effect<Method.EncodedSuccess<Self["methods"][MethodName]>, RpcSuccessEncodeError> => {
  const methodDefinition = definition.methods[methodName];

  return (
    S.encodeEffect(methodDefinition.success)(value) as Effect.Effect<
      Method.EncodedSuccess<Self["methods"][MethodName]>,
      unknown
    >
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RpcSuccessEncodeError({
          definition: definition.id,
          method: methodName,
          cause,
        }),
    ),
  );
};

export const decodeSuccess = <
  const Self extends Definition.Any,
  MethodName extends Definition.MethodNames<Self>,
>(
  definition: Self,
  methodName: MethodName,
  value: unknown,
): Effect.Effect<Method.Success<Self["methods"][MethodName]>, RpcSuccessDecodeError> => {
  const methodDefinition = definition.methods[methodName];

  return (
    S.decodeUnknownEffect(methodDefinition.success)(value) as Effect.Effect<
      Method.Success<Self["methods"][MethodName]>,
      unknown
    >
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RpcSuccessDecodeError({
          definition: definition.id,
          method: methodName,
          cause,
        }),
    ),
  );
};

export const make = <Id extends string, const MethodsShape extends Methods>(
  id: Id,
  methods: MethodsShape,
): Definition<Id, MethodsShape> => {
  const definition = { id, methods } as Definition<Id, MethodsShape>;
  const reserved = Object.keys(definition.methods).find((methodName) =>
    reservedMethodNames.has(methodName),
  );

  if (reserved !== undefined) {
    throw new RpcReservedMethodNameError({ definition: id, method: reserved });
  }

  return definition;
};
