import { Effect } from "effect";

import type * as CloudflareRpc from "../Rpc";

type AnyArgs = Array<any>;

export type AsyncMethodKey<Api> = {
  [Key in keyof Api]-?: Key extends string
    ? Api[Key] extends (...args: AnyArgs) => Promise<unknown>
      ? Key
      : never
    : never;
}[keyof Api];

export type AsyncMethodArgs<Api, Method extends keyof Api> = Api[Method] extends (
  ...args: infer Args
) => Promise<unknown>
  ? Args
  : never;

export type AsyncMethodSuccess<Api, Method extends keyof Api> = Api[Method] extends (
  ...args: AnyArgs
) => Promise<infer A>
  ? A
  : never;

export type AsyncMethodCloudflareReturn<Api, Method extends keyof Api> = CloudflareRpc.Result<
  AsyncMethodSuccess<Api, Method>
>;

const isPropertyTarget = (value: unknown): value is object =>
  (typeof value === "object" || typeof value === "function") && value !== null;

export const lookupRpcMethod = <Api, Method extends AsyncMethodKey<Api>, Error>(
  target: unknown,
  method: Method,
  makeError: (cause: unknown) => Error,
): Effect.Effect<
  (...args: AsyncMethodArgs<Api, Method>) => AsyncMethodCloudflareReturn<Api, Method>,
  Error
> =>
  Effect.try({
    try: () => {
      if (!isPropertyTarget(target)) {
        throw new TypeError(`RPC target is not object-like`);
      }

      const value = Reflect.get(target, method);

      if (typeof value !== "function") {
        throw new TypeError(`RPC method "${String(method)}" is not callable`);
      }

      return ((...args: AsyncMethodArgs<Api, Method>) => Reflect.apply(value, target, args)) as (
        ...args: AsyncMethodArgs<Api, Method>
      ) => AsyncMethodCloudflareReturn<Api, Method>;
    },
    catch: makeError,
  });

export const invokeRpcMethod = <Api, Method extends AsyncMethodKey<Api>, Error>(
  target: unknown,
  method: Method,
  args: AsyncMethodArgs<Api, Method>,
  makeError: (cause: unknown) => Error,
): Effect.Effect<AsyncMethodCloudflareReturn<Api, Method>, Error> =>
  Effect.gen(function* () {
    const fn = yield* lookupRpcMethod<Api, Method, Error>(target, method, makeError);
    return yield* Effect.try({
      try: () => fn(...args),
      catch: makeError,
    });
  });
