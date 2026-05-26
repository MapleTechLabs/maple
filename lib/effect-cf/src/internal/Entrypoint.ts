import { Effect, Layer } from "effect";

import * as RpcDefinition from "../RpcDefinition";

type AnyArgs = Array<any>;
type EntrypointRpcMethod = (...args: AnyArgs) => Effect.Effect<any, any, any>;

export type EntrypointRpc = Record<string, EntrypointRpcMethod>;

export const provideEntrypointServices = <ROut, LayerError, RIn>(
  layer: Layer.Layer<ROut, LayerError, RIn>,
  services: Layer.Layer<RIn, never, never>,
): Layer.Layer<ROut | RIn, LayerError, never> =>
  layer.pipe(Layer.provideMerge(services)) as Layer.Layer<ROut | RIn, LayerError, never>;

export const defineEntrypointRpcMethods = <Self>(
  target: string,
  prototype: object,
  rpc: EntrypointRpc | undefined,
  reservedMethodNames: ReadonlySet<string>,
  run: (self: Self, effect: Effect.Effect<any, any, any>) => Promise<unknown>,
): void => {
  const methods = rpc ?? {};

  RpcDefinition.assertNoReservedMethods(target, methods, reservedMethodNames);

  for (const [key, method] of Object.entries(methods)) {
    Object.defineProperty(prototype, key, {
      enumerable: true,
      value(this: Self, ...args: AnyArgs) {
        return run(
          this,
          Effect.suspend(() => method(...args)),
        );
      },
    });
  }
};

export const assumeEntrypointClass = <Class>(entrypoint: unknown): Class => entrypoint as Class;
