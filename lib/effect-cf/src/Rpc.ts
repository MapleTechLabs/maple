import { RpcStub, RpcTarget } from "cloudflare:workers";
import { Effect, type Scope } from "effect";

export { RpcStub, RpcTarget };

export type Stubable = Rpc.Stubable;

export type Stub<T extends Stubable> = Rpc.Stub<T>;

export type Provider<T extends object, Reserved extends string = never> = Rpc.Provider<T, Reserved>;

type BaseType =
  | void
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | TypedArray
  | ArrayBuffer
  | DataView
  | Date
  | Error
  | RegExp
  | ReadableStream<Uint8Array>
  | WritableStream<Uint8Array>
  | Request
  | Response
  | Headers;

export type Serializable<T> =
  | BaseType
  | Map<
      T extends Map<infer Key, unknown> ? Serializable<Key> : never,
      T extends Map<unknown, infer Value> ? Serializable<Value> : never
    >
  | Set<T extends Set<infer Value> ? Serializable<Value> : never>
  | ReadonlyArray<T extends ReadonlyArray<infer Value> ? Serializable<Value> : never>
  | {
      [Key in keyof T]: Key extends number | string ? Serializable<T[Key]> : never;
    }
  | Stub<Stubable>
  | Stubable;

export type Stubify<T> = T extends Stubable
  ? Stub<T>
  : T extends Map<infer Key, infer Value>
    ? Map<Stubify<Key>, Stubify<Value>>
    : T extends Set<infer Value>
      ? Set<Stubify<Value>>
      : T extends Array<infer Value>
        ? Array<Stubify<Value>>
        : T extends ReadonlyArray<infer Value>
          ? ReadonlyArray<Stubify<Value>>
          : T extends BaseType
            ? T
            : T extends {
                  [key: string | number]: unknown;
                }
              ? {
                  [Key in keyof T]: Stubify<T[Key]>;
                }
              : T;

type MaybeProvider<T> = T extends object ? Provider<T> : unknown;
type MaybeDisposable<T> = T extends object ? Disposable : unknown;

export type Result<T> = T extends Stubable
  ? Promise<Stub<T>> & Provider<T>
  : T extends Serializable<T>
    ? Promise<Stubify<T> & MaybeDisposable<T>> & MaybeProvider<T>
    : never;

export type MethodKey<Api> = {
  [Key in keyof Api]-?: Key extends string
    ? Api[Key] extends (...args: Array<any>) => unknown
      ? Key
      : never
    : never;
}[keyof Api];

export type MethodArgs<Api, Method extends keyof Api> = Api[Method] extends (
  ...args: infer Args
) => unknown
  ? Args
  : never;

export type MethodReturn<Api, Method extends keyof Api> = Api[Method] extends (
  ...args: Array<any>
) => infer Return
  ? Return
  : never;

export type DisposableValue = {
  [Symbol.dispose](): void;
};

export const isDisposable = (value: unknown): value is DisposableValue =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  Symbol.dispose in value &&
  typeof (value as { readonly [Symbol.dispose]?: unknown })[Symbol.dispose] === "function";

export const dispose = (value: unknown): Effect.Effect<void> =>
  Effect.sync(() => {
    if (isDisposable(value)) {
      value[Symbol.dispose]();
    }
  });

export const resolve = <A>(value: A): Effect.Effect<Awaited<A>, unknown> =>
  isPromiseLike(value)
    ? Effect.tryPromise({
        try: () => value,
        catch: (cause) => cause,
      })
    : Effect.sync(() => value as Awaited<A>);

export const scoped = <A>(value: A): Effect.Effect<Awaited<A>, unknown, Scope.Scope> =>
  Effect.acquireRelease(resolve(value), (resolved) => dispose(resolved));

const isPromiseLike = <A>(value: A): value is A & PromiseLike<Awaited<A>> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "then" in value &&
  typeof (value as { readonly then?: unknown }).then === "function";
