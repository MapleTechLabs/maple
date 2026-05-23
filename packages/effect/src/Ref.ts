/**
 * This module provides utilities for working with mutable references in a functional context.
 *
 * A Ref is a mutable reference that can be read, written, and atomically modified. Unlike plain
 * mutable variables, Refs are thread-safe and work seamlessly with Effect's concurrency model.
 * They provide atomic operations for safe state management in concurrent programs.
 *
 * **Example** (Managing shared state with refs)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a ref with initial value
 *   const counter = yield* Ref.make(0)
 *
 *   // Atomic operations
 *   yield* Ref.update(counter, (n) => n + 1)
 *   yield* Ref.update(counter, (n) => n * 2)
 *
 *   const value = yield* Ref.get(counter)
 *   console.log(value) // 2
 *
 *   // Atomic modify with return value
 *   const previous = yield* Ref.getAndSet(counter, 100)
 *   console.log(previous) // 2
 * })
 * ```
 *
 * @since 2.0.0
 */
import * as Effect from "./Effect.ts"
import { dual, identity } from "./Function.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import * as MutableRef from "./MutableRef.ts"
import type * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { Invariant } from "./Types.ts"

const TypeId = "~effect/Ref"

/**
 * A mutable reference that provides atomic read, write, and update operations.
 *
 * **Details**
 *
 * A `Ref` is a thread-safe mutable reference type for shared state. It supports
 * simple read and write operations as well as atomic transformations.
 *
 * **Example** (Reading and updating a ref)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a ref with initial value
 *   const counter = yield* Ref.make(0)
 *
 *   // Read the current value
 *   const value = yield* Ref.get(counter)
 *   console.log(value) // 0
 *
 *   // Update the value atomically
 *   yield* Ref.update(counter, (n) => n + 1)
 *
 *   // Read the updated value
 *   const newValue = yield* Ref.get(counter)
 *   console.log(newValue) // 1
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Ref<in out A> extends Ref.Variance<A>, Pipeable {
  readonly ref: MutableRef.MutableRef<A>
}

/**
 * The Ref namespace containing type definitions and utilities.
 *
 * @since 2.0.0
 */
export declare namespace Ref {
  /**
   * Variance interface for Ref types, defining the type parameter constraints.
   *
   * **Example** (Using invariant refs)
   *
   * ```ts
   * import { Effect, Ref } from "effect"
   *
   * // This interface defines the invariant nature of Ref's type parameter
   * // A Ref<A> is both a producer and consumer of A
   * const program = Effect.gen(function*() {
   *   const ref = yield* Ref.make(42)
   *
   *   // Ref is invariant - it can both produce and consume numbers
   *   const value = yield* Ref.get(ref) // produces number
   *   yield* Ref.set(ref, value + 1) // consumes number
   * })
   * ```
   *
   * @category models
   * @since 2.0.0
   */
  export interface Variance<in out A> {
    readonly [TypeId]: {
      readonly _A: Invariant<A>
    }
  }
}

const RefProto = {
  [TypeId]: {
    _A: identity
  },
  ...PipeInspectableProto,
  toJSON(this: Ref<any>) {
    return {
      _id: "Ref",
      ref: this.ref
    }
  }
}

/**
 * Creates a new Ref with the specified initial value (unsafe version).
 *
 * **When to use**
 *
 * Use this when you need immediate synchronous construction and can guarantee
 * that creating the `Ref` outside of `Effect` is safe.
 *
 * **Gotchas**
 *
 * Prefer `Ref.make` for Effect-wrapped creation in Effect programs.
 *
 * **Example** (Creating a ref unsafely)
 *
 * ```ts
 * import { Ref } from "effect"
 *
 * // Create a ref directly without Effect
 * const counter = Ref.makeUnsafe(0)
 *
 * // Get the current value
 * const value = Ref.getUnsafe(counter)
 * console.log(value) // 0
 *
 * // Note: This is unsafe and should be used carefully
 * // Prefer Ref.make for Effect-wrapped creation
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeUnsafe = <A>(value: A): Ref<A> => {
  const self = Object.create(RefProto)
  self.ref = MutableRef.make(value)
  return self
}

/**
 * Creates a new Ref with the specified initial value.
 *
 * **Example** (Creating a ref)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* Ref.make(42)
 *   const value = yield* Ref.get(ref)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = <A>(value: A): Effect.Effect<Ref<A>> => Effect.sync(() => makeUnsafe(value))

/**
 * Gets the current value of the Ref.
 *
 * **Example** (Getting the current value)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* Ref.make(42)
 *   const value = yield* Ref.get(ref)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const get = <A>(self: Ref<A>) => Effect.sync(() => self.ref.current)

/**
 * Sets the value of the Ref to the specified value.
 *
 * **Example** (Setting a value)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* Ref.make(0)
 *   yield* Ref.set(ref, 42)
 *   const value = yield* Ref.get(ref)
 *   console.log(value) // 42
 * })
 *
 * // Using multiple operations
 * const program2 = Effect.gen(function*() {
 *   const ref = yield* Ref.make(0)
 *   yield* Ref.set(ref, 100)
 *   const value = yield* Ref.get(ref)
 *   console.log(value) // 100
 * })
 * ```
 *
 * @category setters
 * @since 2.0.0
 */
export const set = dual<
  <A>(value: A) => (self: Ref<A>) => Effect.Effect<void>,
  <A>(self: Ref<A>, value: A) => Effect.Effect<void>
>(2, <A>(self: Ref<A>, value: A) => Effect.sync(() => MutableRef.set(self.ref, value)))

/**
 * Atomically gets the current value of the Ref, sets it to the specified value, and returns the previous value.
 *
 * **Example** (Replacing a value atomically)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* Ref.make("initial")
 *
 *   // Get current value and set new value atomically
 *   const previous = yield* Ref.getAndSet(ref, "updated")
 *   console.log(previous) // "initial"
 *
 *   const current = yield* Ref.get(ref)
 *   console.log(current) // "updated"
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const getAndSet = dual<
  <A>(value: A) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, value: A) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, value: A) =>
  Effect.sync(() => {
    const current = self.ref.current
    self.ref.current = value
    return current
  }))

/**
 * Atomically gets the current value of the Ref, updates it with the given function, and returns the previous value.
 *
 * **Example** (Updating and returning the previous value)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(10)
 *
 *   // Get current value and update it atomically
 *   const previous = yield* Ref.getAndUpdate(counter, (n) => n * 2)
 *   console.log(previous) // 10
 *
 *   const current = yield* Ref.get(counter)
 *   console.log(current) // 20
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const getAndUpdate = dual<
  <A>(f: (a: A) => A) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, f: (a: A) => A) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, f: (a: A) => A) =>
  Effect.sync(() => {
    const current = self.ref.current
    self.ref.current = f(current)
    return current
  }))

/**
 * Atomically gets the current value of the Ref and updates it with the given partial function.
 *
 * **Details**
 *
 * If the partial function returns `Option.some`, the Ref is updated with the
 * new value. If it returns `Option.none`, the Ref is left unchanged. The effect
 * always returns the value that was in the Ref before the attempted update.
 *
 * **Example** (Conditionally updating and returning the previous value)
 *
 * ```ts
 * import { Effect, Option, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *
 *   // Only update if value is greater than 3
 *   const previous1 = yield* Ref.getAndUpdateSome(
 *     counter,
 *     (n) => n > 3 ? Option.some(n * 2) : Option.none()
 *   )
 *   console.log(previous1) // 5
 *
 *   const current1 = yield* Ref.get(counter)
 *   console.log(current1) // 10
 *
 *   // Try to update again (won't update since 10 > 3 is true but let's say condition is n < 3)
 *   const previous2 = yield* Ref.getAndUpdateSome(
 *     counter,
 *     (n) => n < 3 ? Option.some(n * 2) : Option.none()
 *   )
 *   console.log(previous2) // 10
 *
 *   const current2 = yield* Ref.get(counter)
 *   console.log(current2) // 10 (unchanged)
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const getAndUpdateSome = dual<
  <A>(pf: (a: A) => Option.Option<A>) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, pf: (a: A) => Option.Option<A>) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, pf: (a: A) => Option.Option<A>) =>
  Effect.sync(() => {
    const current = self.ref.current
    const option = pf(current)
    if (option._tag === "Some") {
      self.ref.current = option.value
    }
    return current
  }))

/**
 * Atomically sets the value of the Ref to the specified value and returns the new value.
 *
 * **When to use**
 *
 * Use this when you want to set a value and immediately get it back in one
 * atomic operation.
 *
 * **Example** (Setting and returning the new value)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* Ref.make(10)
 *
 *   // Set new value and get it back in one operation
 *   const newValue = yield* Ref.setAndGet(ref, 42)
 *   console.log(newValue) // 42
 *
 *   // Verify the ref contains the new value
 *   const current = yield* Ref.get(ref)
 *   console.log(current) // 42
 * })
 *
 * // Useful for sequential operations
 * const program2 = Effect.gen(function*() {
 *   const counter = yield* Ref.make(0)
 *
 *   const newValue = yield* Ref.setAndGet(counter, 20)
 *   console.log(newValue) // 20
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const setAndGet = dual<
  <A>(value: A) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, value: A) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, value: A) => Effect.sync(() => self.ref.current = value))

/**
 * Atomically modifies the value of the Ref using the given function.
 *
 * **Details**
 *
 * The function receives the current value and returns a tuple of
 * `[result, newValue]`. The Ref is updated with `newValue`, and `result` is
 * returned by the effect.
 *
 * **Example** (Modifying a value atomically)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(10)
 *
 *   // Modify the ref and return some computation result
 *   const result = yield* Ref.modify(counter, (n) => [
 *     `Previous value was ${n}`, // Return value
 *     n * 2 // New ref value
 *   ])
 *
 *   console.log(result) // "Previous value was 10"
 *
 *   const current = yield* Ref.get(counter)
 *   console.log(current) // 20
 * })
 *
 * // Example with more complex computation
 * const program2 = Effect.gen(function*() {
 *   const state = yield* Ref.make({ count: 0, total: 0 })
 *
 *   const incremented = yield* Ref.modify(state, (s) => [
 *     s.count, // Return previous count
 *     { count: s.count + 1, total: s.total + s.count + 1 } // New state
 *   ])
 *
 *   console.log(incremented) // 0
 * })
 * ```
 *
 * @category setters
 * @since 2.0.0
 */
export const modify = dual<
  <A, B>(f: (a: A) => readonly [B, A]) => (self: Ref<A>) => Effect.Effect<B>,
  <A, B>(self: Ref<A>, f: (a: A) => readonly [B, A]) => Effect.Effect<B>
>(2, (self, f) =>
  Effect.sync(() => {
    const [b, a] = f(self.ref.current)
    self.ref.current = a
    return b
  }))

/**
 * Atomically computes a result and optionally updates the value of the `Ref`.
 *
 * **Details**
 *
 * The callback receives the current value and returns `[result, nextValue]`,
 * where `nextValue` is an `Option`. If `nextValue` is `Option.some(value)`,
 * the `Ref` is updated to `value`; if it is `Option.none()`, the `Ref` is left
 * unchanged. The returned effect always succeeds with `result`.
 *
 * **Example** (Conditionally modifying a value)
 *
 * ```ts
 * import { Effect, Option, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *
 *   // Only modify if value is greater than 3
 *   const result1 = yield* Ref.modifySome(
 *     counter,
 *     (n) =>
 *       n > 3
 *         ? [`incremented ${n}`, Option.some(n + 10)]
 *         : ["no change", Option.none()]
 *   )
 *
 *   console.log(result1) // "incremented 5"
 *
 *   const current1 = yield* Ref.get(counter)
 *   console.log(current1) // 15
 *
 *   // Try to modify with a condition that fails
 *   const result2 = yield* Ref.modifySome(
 *     counter,
 *     (n) =>
 *       n < 10
 *         ? [`decremented ${n}`, Option.some(n - 5)]
 *         : ["no change", Option.none()]
 *   )
 *
 *   console.log(result2) // "no change"
 *
 *   const current2 = yield* Ref.get(counter)
 *   console.log(current2) // 15 (unchanged)
 * })
 * ```
 *
 * @category setters
 * @since 2.0.0
 */
export const modifySome: {
  <B, A>(pf: (a: A) => readonly [B, Option.Option<A>]): (self: Ref<A>) => Effect.Effect<B>
  <A, B>(self: Ref<A>, pf: (a: A) => readonly [B, Option.Option<A>]): Effect.Effect<B>
} = dual<
  <B, A>(
    pf: (a: A) => readonly [B, Option.Option<A>]
  ) => (self: Ref<A>) => Effect.Effect<B>,
  <A, B>(
    self: Ref<A>,
    pf: (a: A) => readonly [B, Option.Option<A>]
  ) => Effect.Effect<B>
>(2, (self, pf) =>
  modify(self, (value) => {
    const [b, option] = pf(value)
    return [b, option._tag === "None" ? value : option.value]
  }))

/**
 * Atomically updates the value of the Ref using the given function.
 *
 * **Example** (Updating a value)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *
 *   // Update the value
 *   yield* Ref.update(counter, (n) => n * 2)
 *
 *   const value = yield* Ref.get(counter)
 *   console.log(value) // 10
 * })
 *
 * // Using multiple operations
 * const program2 = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *   yield* Ref.update(counter, (n: number) => n + 10)
 *   const value = yield* Ref.get(counter)
 *   console.log(value) // 15
 * })
 * ```
 *
 * @category setters
 * @since 2.0.0
 */
export const update = dual<
  <A>(f: (a: A) => A) => (self: Ref<A>) => Effect.Effect<void>,
  <A>(self: Ref<A>, f: (a: A) => A) => Effect.Effect<void>
>(2, <A>(self: Ref<A>, f: (a: A) => A) =>
  Effect.sync(() => {
    self.ref.current = f(self.ref.current)
  }))

/**
 * Atomically updates the value of the Ref using the given function and returns the new value.
 *
 * **Example** (Updating and returning the new value)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *
 *   // Update and get the new value in one operation
 *   const newValue = yield* Ref.updateAndGet(counter, (n) => n * 3)
 *   console.log(newValue) // 15
 *
 *   // Verify the ref contains the new value
 *   const current = yield* Ref.get(counter)
 *   console.log(current) // 15
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const updateAndGet = dual<
  <A>(f: (a: A) => A) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, f: (a: A) => A) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, f: (a: A) => A) => Effect.sync(() => self.ref.current = f(self.ref.current)))

/**
 * Atomically updates the value of the Ref using the given partial function.
 *
 * **Details**
 *
 * If the partial function returns `Option.some`, the Ref is updated with the
 * new value. If it returns `Option.none`, the Ref is left unchanged.
 *
 * **Example** (Conditionally updating a value)
 *
 * ```ts
 * import { Effect, Option, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *
 *   // Only update if value is even
 *   yield* Ref.updateSome(
 *     counter,
 *     (n) => n % 2 === 0 ? Option.some(n * 2) : Option.none()
 *   )
 *
 *   let current = yield* Ref.get(counter)
 *   console.log(current) // 5 (unchanged because 5 is odd)
 *
 *   // Set to even number and try again
 *   yield* Ref.set(counter, 6)
 *   yield* Ref.updateSome(
 *     counter,
 *     (n) => n % 2 === 0 ? Option.some(n * 2) : Option.none()
 *   )
 *
 *   current = yield* Ref.get(counter)
 *   console.log(current) // 12 (updated because 6 is even)
 * })
 * ```
 *
 * @category setters
 * @since 2.0.0
 */
export const updateSome = dual<
  <A>(f: (a: A) => Option.Option<A>) => (self: Ref<A>) => Effect.Effect<void>,
  <A>(self: Ref<A>, f: (a: A) => Option.Option<A>) => Effect.Effect<void>
>(2, <A>(self: Ref<A>, f: (a: A) => Option.Option<A>) =>
  Effect.sync(() => {
    const option = f(self.ref.current)
    if (option._tag === "Some") {
      self.ref.current = option.value
    }
  }))

/**
 * Atomically updates the value of the Ref using the given partial function and returns the current value.
 *
 * **Details**
 *
 * If the partial function returns `Option.some`, the Ref is updated with the
 * new value. If it returns `Option.none`, the Ref is left unchanged. The effect
 * returns the current value of the Ref after the potential update.
 *
 * **Example** (Conditionally updating and returning the current value)
 *
 * ```ts
 * import { Effect, Option, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(10)
 *
 *   // Only update if value is greater than 5
 *   const result1 = yield* Ref.updateSomeAndGet(
 *     counter,
 *     (n) => n > 5 ? Option.some(n / 2) : Option.none()
 *   )
 *   console.log(result1) // 5 (updated and returned)
 *
 *   // Try to update again with same condition
 *   const result2 = yield* Ref.updateSomeAndGet(
 *     counter,
 *     (n) => n > 5 ? Option.some(n / 2) : Option.none()
 *   )
 *   console.log(result2) // 5 (unchanged because 5 is not > 5)
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const updateSomeAndGet = dual<
  <A>(pf: (a: A) => Option.Option<A>) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, pf: (a: A) => Option.Option<A>) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, pf: (a: A) => Option.Option<A>) =>
  Effect.sync(() => {
    const option = pf(self.ref.current)
    if (option._tag === "Some") {
      self.ref.current = option.value
    }
    return self.ref.current
  }))

/**
 * Gets the current value of the Ref synchronously (unsafe version).
 *
 * **When to use**
 *
 * Use this when you need immediate synchronous access and can guarantee that
 * reading the `Ref` outside of `Effect` is safe.
 *
 * **Gotchas**
 *
 * Prefer `Ref.get` for Effect-wrapped access in Effect programs.
 *
 * **Example** (Reading a ref unsafely)
 *
 * ```ts
 * import { Ref } from "effect"
 *
 * // Create a ref directly
 * const counter = Ref.makeUnsafe(42)
 *
 * // Get the value synchronously
 * const value = Ref.getUnsafe(counter)
 * console.log(value) // 42
 *
 * // Note: This is unsafe and should be used carefully
 * // Prefer Ref.get for Effect-wrapped access
 * ```
 *
 * @category getters
 * @since 4.0.0
 */
export const getUnsafe = <A>(self: Ref<A>): A => self.ref.current
