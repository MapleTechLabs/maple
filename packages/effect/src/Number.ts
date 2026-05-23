/**
 * This module provides utility functions and type class instances for working with the `number` type in TypeScript.
 * It includes functions for basic arithmetic operations.
 *
 * @since 2.0.0
 */
import * as Equ from "./Equivalence.ts"
import { dual } from "./Function.ts"
import * as Option from "./Option.ts"
import * as order from "./Order.ts"
import type { Ordering } from "./Ordering.ts"
import * as predicate from "./Predicate.ts"
import * as Reducer from "./Reducer.ts"

/**
 * The global `Number` constructor.
 *
 * **Example** (Coercing values to numbers)
 *
 * ```ts
 * import { Number as N } from "effect"
 *
 * const num = N.Number("42")
 * console.log(num) // 42
 *
 * const float = N.Number("3.14")
 * console.log(float) // 3.14
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const Number = globalThis.Number

/**
 * Tests if a value is a `number`.
 *
 * **Example** (Checking for numbers)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.isNumber(2), true)
 * assert.deepStrictEqual(Number.isNumber("2"), false)
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isNumber: (input: unknown) => input is number = predicate.isNumber

/**
 * Provides an addition operation on `number`s.
 *
 * **Example** (Adding numbers)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.sum(2, 3), 5)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const sum: {
  (that: number): (self: number) => number
  (self: number, that: number): number
} = dual(2, (self: number, that: number): number => self + that)

/**
 * Provides a multiplication operation on `number`s.
 *
 * **Example** (Multiplying numbers)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.multiply(2, 3), 6)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const multiply: {
  (that: number): (self: number) => number
  (self: number, that: number): number
} = dual(2, (self: number, that: number): number => self * that)

/**
 * Provides a subtraction operation on `number`s.
 *
 * **Example** (Subtracting numbers)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.subtract(2, 3), -1)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const subtract: {
  (that: number): (self: number) => number
  (self: number, that: number): number
} = dual(2, (self: number, that: number): number => self - that)

/**
 * Provides a division operation on `number`s, returning `Option.none()` if the divisor is `0`.
 *
 * **Example** (Dividing numbers safely)
 *
 * ```ts
 * import { Number } from "effect"
 *
 * Number.divide(6, 3) // Option.some(2)
 * Number.divide(6, 0) // Option.none()
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const divide: {
  (that: number): (self: number) => Option.Option<number>
  (self: number, that: number): Option.Option<number>
} = dual(
  2,
  (self: number, that: number): Option.Option<number> => that === 0 ? Option.none() : Option.some(self / that)
)

/**
 * Provides an unsafe division operation on `number`s that throws a `RangeError` if the divisor is `0`.
 *
 * **Example** (Dividing numbers unsafely)
 *
 * ```ts
 * import { Number } from "effect"
 *
 * console.log(Number.divideUnsafe(6, 3)) // 2
 *
 * // Passing 0 as the divisor throws a RangeError("Division by zero").
 * ```
 *
 * @category math
 * @since 4.0.0
 */
export const divideUnsafe: {
  (that: number): (self: number) => number
  (self: number, that: number): number
} = dual(
  2,
  (self: number, that: number): number =>
    Option.getOrThrowWith(divide(self, that), () => new RangeError("Division by zero"))
)

/**
 * Returns the result of adding `1` to a given number.
 *
 * **Example** (Incrementing a number)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.increment(2), 3)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const increment = (n: number): number => n + 1

/**
 * Decrements a number by `1`.
 *
 * **Example** (Decrementing a number)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.decrement(3), 2)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const decrement = (n: number): number => n - 1

/**
 * An `Order` instance for `number` values.
 *
 * **Example** (Comparing numbers)
 *
 * ```ts
 * import { Number } from "effect"
 *
 * console.log(Number.Order(1, 2)) // -1
 * console.log(Number.Order(2, 1)) // 1
 * console.log(Number.Order(1, 1)) // 0
 * ```
 *
 * @category instances
 * @since 2.0.0
 */
export const Order: order.Order<number> = order.Number

/**
 * An `Equivalence` instance for numbers where `NaN` is considered equal to `NaN`.
 *
 * **Example** (Comparing numbers for equivalence)
 *
 * ```ts
 * import { Number } from "effect"
 *
 * console.log(Number.Equivalence(1, 1)) // true
 * console.log(Number.Equivalence(1, 2)) // false
 * console.log(Number.Equivalence(NaN, NaN)) // true
 * ```
 *
 * @category instances
 * @since 2.0.0
 */
export const Equivalence: Equ.Equivalence<number> = Equ.Number

/**
 * Returns `true` if the first argument is less than the second, otherwise `false`.
 *
 * **Example** (Checking less-than comparisons)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.isLessThan(2, 3), true)
 * assert.deepStrictEqual(Number.isLessThan(3, 3), false)
 * assert.deepStrictEqual(Number.isLessThan(4, 3), false)
 * ```
 *
 * @category predicates
 * @since 4.0.0
 */
export const isLessThan: {
  (that: number): (self: number) => boolean
  (self: number, that: number): boolean
} = order.isLessThan(Order)

/**
 * Returns a function that checks if a given `number` is less than or equal to the provided one.
 *
 * **Example** (Checking less-than-or-equal comparisons)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.isLessThanOrEqualTo(2, 3), true)
 * assert.deepStrictEqual(Number.isLessThanOrEqualTo(3, 3), true)
 * assert.deepStrictEqual(Number.isLessThanOrEqualTo(4, 3), false)
 * ```
 *
 * @category predicates
 * @since 4.0.0
 */
export const isLessThanOrEqualTo: {
  (that: number): (self: number) => boolean
  (self: number, that: number): boolean
} = order.isLessThanOrEqualTo(Order)

/**
 * Returns `true` if the first argument is greater than the second, otherwise `false`.
 *
 * **Example** (Checking greater-than comparisons)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.isGreaterThan(2, 3), false)
 * assert.deepStrictEqual(Number.isGreaterThan(3, 3), false)
 * assert.deepStrictEqual(Number.isGreaterThan(4, 3), true)
 * ```
 *
 * @category predicates
 * @since 4.0.0
 */
export const isGreaterThan: {
  (that: number): (self: number) => boolean
  (self: number, that: number): boolean
} = order.isGreaterThan(Order)

/**
 * Returns a function that checks if a given `number` is greater than or equal to the provided one.
 *
 * **Example** (Checking greater-than-or-equal comparisons)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.isGreaterThanOrEqualTo(2, 3), false)
 * assert.deepStrictEqual(Number.isGreaterThanOrEqualTo(3, 3), true)
 * assert.deepStrictEqual(Number.isGreaterThanOrEqualTo(4, 3), true)
 * ```
 *
 * @category predicates
 * @since 4.0.0
 */
export const isGreaterThanOrEqualTo: {
  (that: number): (self: number) => boolean
  (self: number, that: number): boolean
} = order.isGreaterThanOrEqualTo(Order)

/**
 * Checks if a `number` is between a `minimum` and `maximum` value (inclusive).
 *
 * **Example** (Checking inclusive ranges)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * const between = Number.between({ minimum: 0, maximum: 5 })
 *
 * assert.deepStrictEqual(between(3), true)
 * assert.deepStrictEqual(between(-1), false)
 * assert.deepStrictEqual(between(6), false)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const between: {
  (options: {
    minimum: number
    maximum: number
  }): (self: number) => boolean
  (self: number, options: {
    minimum: number
    maximum: number
  }): boolean
} = order.isBetween(Order)

/**
 * Restricts the given `number` to be within the range specified by the `minimum` and `maximum` values.
 *
 * **Details**
 *
 * - If the `number` is less than the `minimum` value, the function returns the `minimum` value.
 * - If the `number` is greater than the `maximum` value, the function returns the `maximum` value.
 * - Otherwise, it returns the original `number`.
 *
 * **Example** (Clamping to a range)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * const clamp = Number.clamp({ minimum: 1, maximum: 5 })
 *
 * assert.equal(clamp(3), 3)
 * assert.equal(clamp(0), 1)
 * assert.equal(clamp(6), 5)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const clamp: {
  (options: {
    minimum: number
    maximum: number
  }): (self: number) => number
  (self: number, options: {
    minimum: number
    maximum: number
  }): number
} = order.clamp(Order)

/**
 * Returns the minimum between two `number`s.
 *
 * **Example** (Finding the minimum)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.min(2, 3), 2)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const min: {
  (that: number): (self: number) => number
  (self: number, that: number): number
} = order.min(Order)

/**
 * Returns the maximum between two `number`s.
 *
 * **Example** (Finding the maximum)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.max(2, 3), 3)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const max: {
  (that: number): (self: number) => number
  (self: number, that: number): number
} = order.max(Order)

/**
 * Determines the sign of a given `number`.
 *
 * **Example** (Determining the sign)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.sign(-5), -1)
 * assert.deepStrictEqual(Number.sign(0), 0)
 * assert.deepStrictEqual(Number.sign(5), 1)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const sign = (n: number): Ordering => Order(n, 0)

/**
 * Takes an `Iterable` of `number`s and returns their sum as a single `number`.
 *
 * **Example** (Summing an iterable)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.sumAll([2, 3, 4]), 9)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const sumAll = (collection: Iterable<number>): number => {
  let out = 0
  for (const n of collection) {
    out += n
  }
  return out
}

/**
 * Takes an `Iterable` of `number`s and returns their multiplication as a single `number`.
 *
 * **Example** (Multiplying an iterable)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.multiplyAll([2, 3, 4]), 24)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const multiplyAll = (collection: Iterable<number>): number => {
  let out = 1
  for (const n of collection) {
    if (n === 0) {
      return 0
    }
    out *= n
  }
  return out
}

/**
 * Returns the remainder left over when one operand is divided by a second operand, always taking the sign of the dividend.
 *
 * **Example** (Calculating remainders)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.remainder(2, 2), 0)
 * assert.deepStrictEqual(Number.remainder(3, 2), 1)
 * assert.deepStrictEqual(Number.remainder(-4, 2), -0)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const remainder: {
  (divisor: number): (self: number) => number
  (self: number, divisor: number): number
} = dual(2, (self: number, divisor: number): number => {
  const selfDecCount = decimalCount(self)
  const divisorDecCount = decimalCount(divisor)
  const decCount = selfDecCount > divisorDecCount ? selfDecCount : divisorDecCount
  const selfInt = parseInt(self.toFixed(decCount).replace(".", ""))
  const divisorInt = parseInt(divisor.toFixed(decCount).replace(".", ""))
  return (selfInt % divisorInt) / Math.pow(10, decCount)
})

function decimalCount(n: number): number {
  const s = n.toString()
  const eIndex = s.indexOf("e-")
  if (eIndex !== -1) {
    const exp = parseInt(s.slice(eIndex + 2))
    const mantissaDecimals = (s.slice(0, eIndex).split(".")[1] || "").length
    return mantissaDecimals + exp
  }
  return (s.split(".")[1] || "").length
}

/**
 * Returns the next power of 2 from the given number.
 *
 * **Example** (Finding the next power of two)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.nextPow2(5), 8)
 * assert.deepStrictEqual(Number.nextPow2(17), 32)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const nextPow2 = (n: number): number => {
  const nextPow = Math.ceil(Math.log(n) / Math.log(2))
  return Math.max(Math.pow(2, nextPow), 2)
}

/**
 * Tries to parse a `number` from a `string` using the `Number()` function.
 * The following special string values are supported: "NaN", "Infinity", "-Infinity".
 *
 * **Example** (Parsing numbers from strings)
 *
 * ```ts
 * import { Number } from "effect"
 *
 * Number.parse("42") // Option.some(42)
 * Number.parse("3.14") // Option.some(3.14)
 * Number.parse("NaN") // Option.some(NaN)
 * Number.parse("Infinity") // Option.some(Infinity)
 * Number.parse("-Infinity") // Option.some(-Infinity)
 * Number.parse("not a number") // Option.none()
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const parse = (s: string): Option.Option<number> => {
  if (s === "NaN") {
    return Option.some(NaN)
  }
  if (s === "Infinity") {
    return Option.some(Infinity)
  }
  if (s === "-Infinity") {
    return Option.some(-Infinity)
  }
  if (s.trim() === "") {
    return Option.none()
  }
  const n = Number(s)
  return Number.isNaN(n) ? Option.none() : Option.some(n)
}

/**
 * Returns the number rounded with the given precision.
 *
 * **Example** (Rounding with precision)
 *
 * ```ts
 * import { Number } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Number.round(1.1234, 2), 1.12)
 * assert.deepStrictEqual(Number.round(1.567, 2), 1.57)
 * ```
 *
 * @category math
 * @since 3.8.0
 */
export const round: {
  (precision: number): (self: number) => number
  (self: number, precision: number): number
} = dual(2, (self: number, precision: number): number => {
  const factor = Math.pow(10, precision)
  return Math.round(self * factor) / factor
})

/**
 * A `Reducer` for combining `number`s using addition.
 *
 * @category math
 * @since 4.0.0
 */
export const ReducerSum: Reducer.Reducer<number> = Reducer.make((a, b) => a + b, 0)

/**
 * A `Reducer` for combining `number`s using multiplication.
 *
 * @category math
 * @since 4.0.0
 */
export const ReducerMultiply: Reducer.Reducer<number> = Reducer.make((a, b) => a * b, 1, (collection) => {
  let acc = 1
  for (const n of collection) {
    if (n === 0) return 0
    acc *= n
  }
  return acc
})

/**
 * A `Reducer` for reducing `number`s by keeping the maximum value.
 *
 * @category math
 * @since 4.0.0
 */
export const ReducerMax: Reducer.Reducer<number> = Reducer.make((a, b) => Math.max(a, b), -Infinity)

/**
 * A `Reducer` for reducing `number`s by keeping the minimum value.
 *
 * @category math
 * @since 4.0.0
 */
export const ReducerMin: Reducer.Reducer<number> = Reducer.make((a, b) => Math.min(a, b), Infinity)
