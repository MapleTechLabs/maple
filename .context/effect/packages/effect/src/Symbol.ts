/**
 * The `Symbol` module provides a small runtime guard for working with
 * JavaScript `symbol` values. Use {@link isSymbol} when validating unknown
 * input, narrowing union types, or building predicates that need to recognize
 * primitive symbols such as those created by `Symbol()` or `Symbol.for`.
 *
 * The guard checks for the primitive `symbol` type; boxed objects created with
 * `Object(Symbol())` are objects and do not satisfy this predicate.
 *
 * @since 2.0.0
 */

import * as predicate from "./Predicate.ts"

/**
 * Tests if a value is a `symbol`.
 *
 * **Example** (Checking for symbols)
 *
 * ```ts
 * import { Symbol } from "effect"
 *
 * console.log(Symbol.isSymbol(globalThis.Symbol.for("a"))) // true
 * console.log(Symbol.isSymbol("a")) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isSymbol: (u: unknown) => u is symbol = predicate.isSymbol
