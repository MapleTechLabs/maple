/**
 * This module provides small, allocation-free utilities for working with values of type
 * `A | undefined`, where `undefined` means "no value".
 *
 * Why not `Option<A>`?
 * In TypeScript, `Option<A>` is often unnecessary. If `undefined` already models absence
 * in your domain, using `A | undefined` keeps types simple, avoids extra wrappers, and
 * reduces overhead. The key is that `A` itself must not include `undefined`; in this
 * module `undefined` is reserved to mean "no value".
 *
 * When to use `A | undefined`:
 * - Absence can be represented by `undefined` in your domain model.
 * - You do not need to distinguish between "no value" and "value is undefined".
 * - You want straightforward ergonomics and zero extra allocations.
 *
 * When to prefer `Option<A>`:
 * - You must distinguish `None` from `Some(undefined)` (that is, `undefined` is a valid
 *   payload and carries meaning on its own).
 * - You need a tagged representation for serialization or pattern matching across
 *   boundaries where `undefined` would be ambiguous.
 * - You want the richer `Option` API and are comfortable with the extra wrapper.
 *
 * Lawfulness note:
 * All helpers treat `undefined` as absence. Do not use these utilities with payloads
 * where `A` can itself be `undefined`, or you will lose information. If you need to
 * carry `undefined` as a valid payload, use `Option<A>` instead.
 *
 * @since 4.0.0
 */
import * as Combiner from "./Combiner.ts"
import type { LazyArg } from "./Function.ts"
import { dual } from "./Function.ts"
import * as Reducer from "./Reducer.ts"

/**
 * Maps a defined value with `f`, or returns `undefined` unchanged.
 *
 * @category mapping
 * @since 4.0.0
 */
export const map: {
  <A, B>(f: (a: A) => B): (self: A | undefined) => B | undefined
  <A, B>(self: A | undefined, f: (a: A) => B): B | undefined
} = dual(2, (self, f) => (self === undefined ? undefined : f(self)))

/**
 * Pattern matches on an `A | undefined` value, running `onDefined` when the
 * value is present or evaluating `onUndefined` when the value is `undefined`.
 *
 * @category pattern matching
 * @since 4.0.0
 */
export const match: {
  <B, A, C = B>(options: {
    readonly onUndefined: LazyArg<B>
    readonly onDefined: (a: A) => C
  }): (self: A | undefined) => B | C
  <A, B, C = B>(self: A | undefined, options: {
    readonly onUndefined: LazyArg<B>
    readonly onDefined: (a: A) => C
  }): B | C
} = dual(
  2,
  <A, B, C = B>(self: A | undefined, { onDefined, onUndefined }: {
    readonly onUndefined: LazyArg<B>
    readonly onDefined: (a: A) => C
  }): B | C => self === undefined ? onUndefined() : onDefined(self)
)

/**
 * Returns the defined value, or throws the value produced by `onUndefined`
 * when the input is `undefined`.
 *
 * @category getters
 * @since 4.0.0
 */
export const getOrThrowWith: {
  (onUndefined: () => unknown): <A>(self: A | undefined) => A
  <A>(self: A | undefined, onUndefined: () => unknown): A
} = dual(2, <A>(self: A | undefined, onUndefined: () => unknown): A => {
  if (self !== undefined) {
    return self
  }
  throw onUndefined()
})

/**
 * Returns the defined value, or throws a default `Error` when the input is
 * `undefined`.
 *
 * @category getters
 * @since 4.0.0
 */
export const getOrThrow: <A>(self: A | undefined) => A = getOrThrowWith(() =>
  new Error("getOrThrow called on a undefined")
)

/**
 * Converts a throwing function into one that returns successful results
 * unchanged and returns `undefined` when the function throws.
 *
 * @category converting
 * @since 4.0.0
 */
export const liftThrowable = <A extends ReadonlyArray<unknown>, B>(
  f: (...a: A) => B
): (...a: A) => B | undefined =>
(...a) => {
  try {
    return f(...a)
  } catch {
    return undefined
  }
}

/**
 * Creates a `Reducer` for `UndefinedOr<A>` that prioritizes the first non-`undefined`
 * value and combines values when both operands are present.
 *
 * **When to use**
 *
 * - Take the first available value (like a fallback chain)
 * - Combine values when both are present
 * - Maintain a `undefined` state only when all values are `undefined`
 *
 * **Details**
 *
 * - `undefined` + `undefined` -> `undefined`
 * - `a` + `undefined` -> `a` (first value wins)
 * - `undefined` + `b` -> `b` (second value wins)
 * - `a` + `b` -> `combiner.combine(a, b)`
 * - Initial value is `undefined`
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeReducer<A>(combiner: Combiner.Combiner<A>): Reducer.Reducer<A | undefined> {
  return Reducer.make((self, that) => {
    if (self === undefined) return that
    if (that === undefined) return self
    return combiner.combine(self, that)
  }, undefined as A | undefined)
}

/**
 * Creates a `Combiner` for `A | undefined` that combines values only when both
 * operands are defined.
 *
 * **Details**
 *
 * - `undefined` combined with any value returns `undefined`
 * - Any value combined with `undefined` returns `undefined`
 * - `a` combined with `b` returns `combiner.combine(a, b)`
 *
 * @see {@link makeReducerFailFast} if you have a `Reducer` and want to lift it
 * to `UndefinedOr` values.
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeCombinerFailFast<A>(combiner: Combiner.Combiner<A>): Combiner.Combiner<A | undefined> {
  return Combiner.make((self, that) => {
    if (self === undefined || that === undefined) return undefined
    return combiner.combine(self, that)
  })
}

/**
 * Creates a `Reducer` for `A | undefined` by wrapping an existing reducer with
 * fail-fast semantics.
 *
 * **When to use**
 *
 * - Wrapping an existing `Reducer` to work with `A | undefined` values
 * - Reductions where any `undefined` value should abort the entire result
 *
 * **Details**
 *
 * - Initial value is the wrapped reducer's `initialValue`
 * - Combining two defined values delegates to the wrapped reducer
 * - If the accumulator or next value is `undefined`, the reduction returns `undefined`
 *
 * @see {@link makeCombinerFailFast} if you only have a `Combiner` and want to
 * lift it to `UndefinedOr` values.
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeReducerFailFast<A>(reducer: Reducer.Reducer<A>): Reducer.Reducer<A | undefined> {
  const combine = makeCombinerFailFast(reducer).combine
  const initialValue = reducer.initialValue as A | undefined
  return Reducer.make(combine, initialValue, (collection) => {
    let out = initialValue
    for (const value of collection) {
      out = combine(out, value)
      if (out === undefined) return out
    }
    return out
  })
}
