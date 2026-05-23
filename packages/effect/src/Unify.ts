/**
 * The `Unify` module contains the type-level protocol Effect uses to normalize
 * unions of data types that opt in to unification. It is primarily a library
 * authoring tool: data types expose hidden symbol properties describing how
 * their variants should be widened, and {@link Unify} turns those protocol
 * entries into the user-facing union type that TypeScript should infer.
 *
 * Most application code does not need to interact with these symbols directly.
 * The main runtime helper, {@link unify}, is an identity function that preserves
 * values and functions at runtime while applying {@link Unify} to the relevant
 * static type. This is useful when authoring APIs that return branded or
 * protocol-enabled values and need inference to collapse to the public Effect
 * data type rather than exposing implementation details.
 *
 * @since 2.0.0
 */

import { identity } from "./Function.ts"

/**
 * A unique symbol used to identify unification behavior in Effect types.
 *
 * **Details**
 *
 * This symbol is used internally by the Effect type system to enable automatic
 * unification of Effect types in unions and complex type operations.
 *
 * @category symbols
 * @since 2.0.0
 */
export declare const unifySymbol: unique symbol

/**
 * The type of the unifySymbol.
 *
 * **Details**
 *
 * This type represents the unique symbol used for identifying unification
 * behavior in Effect types. It's typically used in type-level operations
 * to enable automatic type unification.
 *
 * @category symbols
 * @since 2.0.0
 */
export type unifySymbol = typeof unifySymbol

/**
 * A unique symbol used to identify the type information for unification.
 *
 * **Details**
 *
 * This symbol is used internally by the Effect type system to store type
 * information that can be used during type unification operations.
 *
 * @category symbols
 * @since 2.0.0
 */
export declare const typeSymbol: unique symbol

/**
 * The type of the typeSymbol.
 *
 * **Details**
 *
 * This type represents the unique symbol used for storing type information
 * in types that support unification. It's used in type-level operations
 * to access and manipulate type information.
 *
 * @category symbols
 * @since 2.0.0
 */
export type typeSymbol = typeof typeSymbol

/**
 * A unique symbol used to specify types that should be ignored during unification.
 *
 * **Details**
 *
 * This symbol is used internally by the Effect type system to mark types
 * that should be excluded from the unification process, allowing for more
 * precise type handling in complex scenarios.
 *
 * @category symbols
 * @since 2.0.0
 */
export declare const ignoreSymbol: unique symbol

/**
 * The type of the ignoreSymbol.
 *
 * **Details**
 *
 * This type represents the unique symbol used for marking types that should
 * be ignored during unification operations. It's used in type-level operations
 * to exclude specific types from the unification process.
 *
 * @category symbols
 * @since 2.0.0
 */
export type ignoreSymbol = typeof ignoreSymbol

type MaybeReturn<F> = F extends () => infer R ? R : NonNullable<F>

type Keys<X extends [any, any]> = X extends [infer A, infer Ignore] ? Exclude<keyof A, Ignore>
  : never

type Values<X extends [any, any]> = X extends [infer A, infer Ignore]
  ? Keys<[A, Ignore]> extends infer K ? K extends keyof A ? MaybeReturn<A[K]> : never : never
  : never

type Ignore<X> = X extends { [ignoreSymbol]?: infer Obj } ? keyof NonNullable<Obj>
  : never

type ExtractTypes<
  X
> = X extends {
  [typeSymbol]?: infer _Type
  [unifySymbol]?: infer _Unify
} ? [NonNullable<_Unify>, Ignore<X>]
  : never

type FilterIn<A> = A extends any ? typeSymbol extends keyof A ? A : never : never

type FilterInUnmatched<A, K> = A extends any
  ? typeSymbol extends keyof A
    ? A extends { [unifySymbol]?: infer U } ? [Extract<keyof NonNullable<U>, K>] extends [never] ? A : never
    : A
  : never
  : never

type FilterOut<A> = A extends any ? typeSymbol extends keyof A ? never : A : never

/**
 * Unifies types that implement the unification protocol.
 *
 * **Details**
 *
 * This type performs automatic type unification for types that contain
 * the unification symbols (`unifySymbol`, `typeSymbol`, `ignoreSymbol`).
 * It's primarily used internally by the Effect type system to handle
 * complex type unions and provide better type inference.
 *
 * **Example** (Unifying protocol types)
 *
 * ```ts
 * import type { Unify } from "effect"
 *
 * // Example of types that can be unified
 * type UnifiableA = {
 *   value: string
 *   [Unify.typeSymbol]?: string
 *   [Unify.unifySymbol]?: { String: () => string }
 * }
 *
 * type UnifiableB = {
 *   value: number
 *   [Unify.typeSymbol]?: number
 *   [Unify.unifySymbol]?: { Number: () => number }
 * }
 *
 * // Unify automatically handles the union
 * type Unified = Unify.Unify<UnifiableA | UnifiableB>
 * // Results in a properly unified type
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export type Unify<A> = Values<
  ExtractTypes<
    (
      & FilterIn<A>
      & { [typeSymbol]: A }
    )
  >
> extends infer Z ?
    | Z
    | FilterInUnmatched<
      A,
      Keys<
        ExtractTypes<
          (
            & FilterIn<A>
            & { [typeSymbol]: A }
          )
        >
      >
    >
    | FilterOut<A>
  : never

/**
 * Applies `Unify` to a value or function return type at compile time.
 *
 * **Details**
 *
 * This is an identity function at runtime. For functions, the returned function
 * has the same runtime behavior while its return type is normalized with the
 * Effect unification protocol.
 *
 * **Example** (Unifying values and function results)
 *
 * ```ts
 * import { Unify } from "effect"
 *
 * // Unify a simple value
 * const unifiedValue = Unify.unify("hello")
 * // Type: string
 *
 * // Unify a function result
 * const createUnifiableValue = () => ({
 *   value: "test",
 *   [Unify.typeSymbol]: "string" as const,
 *   [Unify.unifySymbol]: { String: () => "test" as const }
 * })
 *
 * const unifiedFunction = Unify.unify(createUnifiableValue)
 * // The result will be properly unified
 *
 * // Unify with curried functions
 * const curriedFunction = (a: string) => (b: number) => ({ result: a + b })
 * const unifiedCurried = Unify.unify(curriedFunction)
 * // Type: (a: string) => (b: number) => Unify<{ result: string }>
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const unify: {
  <
    Args extends Array<any>,
    Args2 extends Array<any>,
    Args3 extends Array<any>,
    Args4 extends Array<any>,
    Args5 extends Array<any>,
    T
  >(
    x: (...args: Args) => (...args: Args2) => (...args: Args3) => (...args: Args4) => (...args: Args5) => T
  ): (...args: Args) => (...args: Args2) => (...args: Args3) => (...args: Args4) => (...args: Args5) => Unify<T>
  <
    Args extends Array<any>,
    Args2 extends Array<any>,
    Args3 extends Array<any>,
    Args4 extends Array<any>,
    T
  >(
    x: (...args: Args) => (...args: Args2) => (...args: Args3) => (...args: Args4) => T
  ): (...args: Args) => (...args: Args2) => (...args: Args3) => (...args: Args4) => Unify<T>
  <
    Args extends Array<any>,
    Args2 extends Array<any>,
    Args3 extends Array<any>,
    T
  >(
    x: (...args: Args) => (...args: Args2) => (...args: Args3) => T
  ): (...args: Args) => (...args: Args2) => (...args: Args3) => Unify<T>
  <
    Args extends Array<any>,
    Args2 extends Array<any>,
    T
  >(
    x: (...args: Args) => (...args: Args2) => T
  ): (...args: Args) => (...args: Args2) => Unify<T>
  <
    Args extends Array<any>,
    T
  >(x: (...args: Args) => T): (...args: Args) => Unify<T>
  <T>(x: T): Unify<T>
} = identity as any
