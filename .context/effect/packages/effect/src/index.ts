/**
 * @since 2.0.0
 */

export {
  /**
   * @since 2.0.0
   */
  absurd,
  /**
   * @since 2.0.0
   */
  cast,
  /**
   * @since 2.0.0
   */
  flow,
  /**
   * @since 2.0.0
   */
  hole,
  /**
   * @since 2.0.0
   */
  identity,
  /**
   * @since 2.0.0
   */
  pipe
} from "./Function.ts"

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Utilities for working with immutable arrays (and non-empty arrays) in a
 * functional style. All functions treat arrays as immutable — they return new
 * arrays rather than mutating the input.
 *
 * ## Mental model
 *
 * - **`Array<A>`** is a standard JS array. All functions in this module return
 *   new arrays; the input is never mutated.
 * - **`NonEmptyReadonlyArray<A>`** (`readonly [A, ...Array<A>]`) is a readonly
 *   array guaranteed to have at least one element. Many functions preserve or
 *   require this guarantee at the type level.
 * - **`NonEmptyArray<A>`** is the mutable counterpart: `[A, ...Array<A>]`.
 * - Most functions are **dual** — they can be called either as
 *   `Array.fn(array, arg)` (data-first) or piped as
 *   `pipe(array, Array.fn(arg))` (data-last).
 * - Functions that access elements by index return `Option<A>` for safety; use
 *   the `*NonEmpty` variants (e.g. {@link headNonEmpty}) when you already know
 *   the array is non-empty.
 * - Set-like operations ({@link union}, {@link intersection},
 *   {@link difference}) use `Equal.equivalence()` by default; use the `*With`
 *   variants for custom equality.
 *
 * ## Common tasks
 *
 * - **Create** an array: {@link make}, {@link of}, {@link empty},
 *   {@link fromIterable}, {@link range}, {@link makeBy}, {@link replicate},
 *   {@link unfold}
 * - **Access** elements: {@link head}, {@link last}, {@link get}, {@link tail},
 *   {@link init}
 * - **Transform**: {@link map}, {@link flatMap}, {@link flatten}
 * - **Filter**: {@link filter}, {@link partition}, {@link dedupe}
 * - **Combine**: {@link append}, {@link prepend}, {@link appendAll},
 *   {@link prependAll}, {@link zip}, {@link cartesian}
 * - **Split**: {@link splitAt}, {@link chunksOf}, {@link span}, {@link window}
 * - **Search**: {@link findFirst}, {@link findLast}, {@link contains}
 * - **Sort**: {@link sort}, {@link sortBy}, {@link sortWith}
 * - **Fold**: {@link reduce}, {@link scan}, {@link join}
 * - **Group**: {@link groupBy}, {@link group}, {@link groupWith}
 * - **Set operations**: {@link union}, {@link intersection},
 *   {@link difference}
 * - **Match** on empty vs non-empty: {@link match}, {@link matchLeft},
 *   {@link matchRight}
 * - **Check** properties: {@link isArray}, {@link isArrayNonEmpty},
 *   {@link every}, {@link some}
 *
 * ## Gotchas
 *
 * - {@link fromIterable} returns the original array reference when given an
 *   array; if you need a copy, use {@link copy}.
 * - `sort`, `reverse`, etc. always allocate a new array — the input is never
 *   mutated.
 * - {@link makeBy} and {@link replicate} normalize `n` to an integer >= 1 —
 *   they never produce an empty array.
 * - {@link range}`(start, end)` is inclusive on both ends. If `start > end` it
 *   returns `[start]`.
 * - Functions returning `Option` (e.g. {@link head}, {@link findFirst}) return
 *   `Option.none()` for empty inputs — they never throw.
 *
 * ## Quickstart
 *
 * **Example** (Basic array operations)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const numbers = Array.make(1, 2, 3, 4, 5)
 *
 * const doubled = Array.map(numbers, (n) => n * 2)
 * console.log(doubled) // [2, 4, 6, 8, 10]
 *
 * const evens = Array.filter(numbers, (n) => n % 2 === 0)
 * console.log(evens) // [2, 4]
 *
 * const sum = Array.reduce(numbers, 0, (acc, n) => acc + n)
 * console.log(sum) // 15
 * ```
 *
 * @see {@link make} — create a non-empty array from elements
 * @see {@link map} — transform each element
 * @see {@link filter} — keep elements matching a predicate
 * @see {@link reduce} — fold an array to a single value
 *
 * @since 2.0.0
 */
export * as Array from "./Array.ts"

/**
 * This module provides utility functions and type class instances for working with the `BigDecimal` type in TypeScript.
 * It includes functions for basic arithmetic operations.
 *
 * A `BigDecimal` allows storing any real number to arbitrary precision; which avoids common floating point errors
 * (such as 0.1 + 0.2 ≠ 0.3) at the cost of complexity.
 *
 * Internally, `BigDecimal` uses a `BigInt` object, paired with a 64-bit integer which determines the position of the
 * decimal point. Therefore, the precision *is not* actually arbitrary, but limited to 2<sup>63</sup> decimal places.
 *
 * It is not recommended to convert a floating point number to a decimal directly, as the floating point representation
 * may be unexpected.
 *
 * @since 2.0.0
 */
export * as BigDecimal from "./BigDecimal.ts"

/**
 * This module provides utility functions and type class instances for working with the `bigint` type in TypeScript.
 * It includes functions for basic arithmetic operations.
 *
 * @since 2.0.0
 */
export * as BigInt from "./BigInt.ts"

/**
 * This module provides utility functions and type class instances for working with the `boolean` type in TypeScript.
 * It includes functions for basic boolean operations.
 *
 * @since 2.0.0
 */
export * as Boolean from "./Boolean.ts"

/**
 * This module provides types and utility functions to create and work with
 * branded types, which are TypeScript types with an added type tag to prevent
 * accidental usage of a value in the wrong context.
 *
 * @since 2.0.0
 */
export * as Brand from "./Brand.ts"

/**
 * The `Cache` module provides an effectful, mutable key-value cache for values
 * that are computed by a lookup function. A `Cache<Key, A, E, R>` stores lookup
 * results for keys, shares concurrent lookups for the same key, and manages
 * entry lifetime with capacity limits and optional time-to-live policies.
 *
 * **Mental model**
 *
 * - A cache is created from a lookup function and a maximum capacity
 * - {@link get} returns a cached value when present, or runs the lookup on a miss
 * - Concurrent misses for the same key share one pending lookup
 * - Lookup failures are cached as failures until the entry expires, is invalidated, or is refreshed
 * - Entries can live forever, expire after a fixed duration, or use a dynamic TTL based on the lookup `Exit`
 * - Capacity is enforced by removing the oldest stored entries when new entries are added
 *
 * **Common tasks**
 *
 * - Create a cache: {@link make}, {@link makeWith}
 * - Read values: {@link get}, {@link getOption}, {@link getSuccess}
 * - Seed or overwrite values: {@link set}
 * - Refresh values: {@link refresh}
 * - Remove entries: {@link invalidate}, {@link invalidateWhen}, {@link invalidateAll}
 * - Inspect contents: {@link has}, {@link size}, {@link keys}, {@link values}, {@link entries}
 *
 * **Gotchas**
 *
 * - {@link getOption} does not run the lookup; it only reads an existing non-expired entry
 * - {@link size} may include expired entries until they are observed and removed
 * - {@link values} and {@link entries} include only successfully resolved entries
 * - Use `Data` or another `Equal`-compatible key type when keys need structural equality
 *
 * **See also**
 *
 * - {@link Duration} for configuring fixed or dynamic time-to-live values
 * - {@link Effect} for the lookup effects used to compute cached values
 *
 * @since 4.0.0
 */
export * as Cache from "./Cache.ts"

/**
 * Structured representation of how an Effect can fail.
 *
 * A `Cause<E>` holds a flat array of `Reason` values, where each reason is one of:
 *
 * - **Fail** — a typed, expected error `E` (created by `Effect.fail`)
 * - **Die** — an untyped defect (`unknown`) from `Effect.die` or uncaught throws
 * - **Interrupt** — a fiber interruption, optionally carrying the interrupting fiber's ID
 *
 * ## Mental model
 *
 * - A `Cause` is always flat: concurrent and sequential failures are stored together
 *   in `cause.reasons` (a `ReadonlyArray<Reason<E>>`).
 * - Each `Reason` carries an `annotations` map with tracing metadata (stack frames, spans).
 * - An empty `reasons` array means the computation succeeded or the cause was empty
 *   ({@link empty}).
 * - `Cause` implements `Equal`, so two causes with identical reasons compare as equal.
 *
 * ## Common tasks
 *
 * | Intent | API |
 * |--------|-----|
 * | Create a cause | {@link fail}, {@link die}, {@link interrupt}, {@link fromReasons} |
 * | Test for reason types | {@link hasFails}, {@link hasDies}, {@link hasInterrupts} |
 * | Extract the first error/defect | {@link findError}, {@link findDefect}, {@link findFail}, {@link findDie} |
 * | Iterate over reasons manually | `cause.reasons.filter(Cause.isFailReason)` |
 * | Combine two causes | {@link combine} |
 * | Transform errors | {@link map} |
 * | Collapse to a single thrown value | {@link squash} |
 * | Render for logging | {@link pretty}, {@link prettyErrors} |
 * | Attach/read tracing metadata | {@link annotate}, {@link annotations}, {@link reasonAnnotations} |
 *
 * ## Gotchas
 *
 * - `findError`/`findDefect` return `Filter.fail` (not `Option.none`) when no match is
 *   found. Use {@link findErrorOption} if you need an `Option`.
 * - `squash` picks the first `Fail` error, then the first `Die` defect, then falls back
 *   to a generic "interrupted" / "empty" error. It is lossy — use `prettyErrors` or
 *   iterate `reasons` directly when you need all failures.
 * - The module also exports several built-in error classes (`NoSuchElementError`,
 *   `TimeoutError`, `IllegalArgumentError`, `ExceededCapacityError`, `UnknownError`)
 *   and the `Done` completion signal. These all implement `YieldableError` and can be
 *   yielded directly inside `Effect.gen`.
 *
 * **Example** (inspecting a concurrent failure)
 *
 * ```ts
 * import { Cause, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const cause = yield* Effect.sandbox(
 *     Effect.all([
 *       Effect.fail("err1"),
 *       Effect.die("defect"),
 *       Effect.fail("err2")
 *     ], { concurrency: "unbounded" })
 *   ).pipe(Effect.flip)
 *
 *   const errors = cause.reasons
 *     .filter(Cause.isFailReason)
 *     .map((r) => r.error)
 *
 *   const defects = cause.reasons
 *     .filter(Cause.isDieReason)
 *     .map((r) => r.defect)
 *
 *   console.log(errors)  // ["err1", "err2"]  (order may vary)
 *   console.log(defects) // ["defect"]
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @see {@link Cause} — the core interface
 * @see {@link Reason} — the union of failure kinds
 * @see {@link pretty} — human-readable rendering
 *
 * @since 2.0.0
 */
export * as Cause from "./Cause.ts"

/**
 * The `Channel` module provides a powerful abstraction for bi-directional communication
 * and streaming operations. A `Channel` is a nexus of I/O operations that supports both
 * reading and writing, forming the foundation for Effect's Stream and Sink abstractions.
 *
 * ## What is a Channel?
 *
 * A `Channel<OutElem, OutErr, OutDone, InElem, InErr, InDone, Env>` represents:
 * - **OutElem**: The type of elements the channel outputs
 * - **OutErr**: The type of errors the channel can produce
 * - **OutDone**: The type of the final value when the channel completes
 * - **InElem**: The type of elements the channel reads
 * - **InErr**: The type of errors the channel can receive
 * - **InDone**: The type of the final value from upstream
 * - **Env**: The environment/context required by the channel
 *
 * ## Key Features
 *
 * - **Bi-directional**: Channels can both read and write
 * - **Composable**: Channels can be piped, sequenced, and concatenated
 * - **Resource-safe**: Automatic cleanup and resource management
 * - **Error-handling**: Built-in error propagation and handling
 * - **Concurrent**: Support for concurrent operations
 *
 * ## Composition Patterns
 *
 * 1. **Piping**: Connect channels where output of one becomes input of another
 * 2. **Sequencing**: Use the result of one channel to create another
 * 3. **Concatenating**: Combine multiple channels into a single channel
 *
 * **Example** (Creating a simple channel)
 *
 * ```ts
 * import { Channel } from "effect"
 *
 * // Simple channel that outputs numbers
 * const numberChannel = Channel.succeed(42)
 *
 * // Transform channel that doubles values
 * const doubleChannel = Channel.map(numberChannel, (n) => n * 2)
 *
 * // Running the channel would output: 84
 * ```
 *
 * **Example** (Transforming array-backed channels)
 *
 * ```ts
 * import { Channel } from "effect"
 *
 * // Channel from an array of values
 * const arrayChannel = Channel.fromArray([1, 2, 3, 4, 5])
 *
 * // Transform the channel by mapping over values
 * const transformedChannel = Channel.map(arrayChannel, (n) => n * 2)
 *
 * // This channel will output: 2, 4, 6, 8, 10
 * ```
 *
 * @since 2.0.0
 */
export * as Channel from "./Channel.ts"

/**
 * The `ChannelSchema` module provides helpers for applying `Schema` encoding
 * and decoding at `Channel` boundaries. It is useful when a channel should
 * expose typed values to application code while communicating with an upstream
 * or downstream component through an encoded representation such as JSON-ready
 * data, wire protocol values, or any other schema-defined format.
 *
 * **Mental model**
 *
 * - A channel schema adapter is a streaming boundary: chunks flow through a
 *   `Channel`, and each non-empty chunk is validated and transformed with a
 *   `Schema`
 * - `encode` turns typed schema values into their encoded representation before
 *   they leave a typed part of a pipeline
 * - `decode` turns encoded input into typed schema values before application
 *   code consumes them
 * - `duplex` wraps a bidirectional channel so callers work with typed input and
 *   output while the wrapped channel continues to operate on encoded chunks
 * - Schema failures are surfaced through the channel error type as
 *   `SchemaError`, and schema services are reflected in the channel
 *   requirements
 *
 * **Common tasks**
 *
 * - Encode typed channel input before sending it to an encoded transport:
 *   {@link encode}
 * - Decode encoded channel output before handling it as domain data:
 *   {@link decode}
 * - Use unknown encoded boundaries when static encoded types are intentionally
 *   erased: {@link encodeUnknown} and {@link decodeUnknown}
 * - Wrap a bidirectional encoded channel with typed input and output schemas:
 *   {@link duplex} or {@link duplexUnknown}
 *
 * **Gotchas**
 *
 * - These helpers operate on `NonEmptyReadonlyArray` chunks, so schemas are
 *   applied to non-empty batches rather than individual scalar values
 * - Encoding and decoding can require services from the schema; those
 *   requirements become part of the resulting channel type
 * - `duplex` encodes values flowing into the wrapped channel and decodes values
 *   emitted by it, so choose `inputSchema` and `outputSchema` from the
 *   perspective of the typed caller
 *
 * @since 4.0.0
 */
export * as ChannelSchema from "./ChannelSchema.ts"

/**
 * The `Chunk` module provides an immutable, high-performance sequence data structure
 * optimized for functional programming patterns. A `Chunk` is a persistent data structure
 * that supports efficient append, prepend, and concatenation operations.
 *
 * ## What is a Chunk?
 *
 * A `Chunk<A>` is an immutable sequence of elements of type `A` that provides:
 * - **O(1) append and prepend operations**
 * - **Efficient concatenation** through tree-like structure
 * - **Memory efficiency** with structural sharing
 * - **Rich API** with functional programming operations
 * - **Type safety** with full TypeScript integration
 *
 * ## Key Features
 *
 * - **Immutable**: All operations return new chunks without modifying the original
 * - **Efficient**: Optimized data structure with logarithmic complexity for most operations
 * - **Functional**: Rich set of transformation and combination operators
 * - **Lazy evaluation**: Many operations are deferred until needed
 * - **Interoperable**: Easy conversion to/from arrays and other collections
 *
 * ## Performance Characteristics
 *
 * - **Append/Prepend**: O(1) amortized
 * - **Random Access**: O(log n)
 * - **Concatenation**: O(log min(m, n))
 * - **Iteration**: O(n)
 * - **Memory**: Structural sharing minimizes allocation
 *
 * **Example** (Creating and combining chunks)
 *
 * ```ts
 * import { Chunk } from "effect"
 *
 * // Creating chunks
 * const chunk1 = Chunk.fromIterable([1, 2, 3])
 * const chunk2 = Chunk.fromIterable([4, 5, 6])
 * const empty = Chunk.empty<number>()
 *
 * // Combining chunks
 * const combined = Chunk.appendAll(chunk1, chunk2)
 * console.log(Chunk.toReadonlyArray(combined)) // [1, 2, 3, 4, 5, 6]
 * ```
 *
 * **Example** (Transforming chunks)
 *
 * ```ts
 * import { Chunk } from "effect"
 *
 * // Functional transformations
 * const numbers = Chunk.range(1, 5) // [1, 2, 3, 4, 5]
 * const doubled = Chunk.map(numbers, (n) => n * 2) // [2, 4, 6, 8, 10]
 * const evens = Chunk.filter(doubled, (n) => n % 4 === 0) // [4, 8]
 * const sum = Chunk.reduce(evens, 0, (acc, n) => acc + n) // 12
 * ```
 *
 * **Example** (Processing chunks with Effect)
 *
 * ```ts
 * import { Chunk, Effect } from "effect"
 *
 * // Working with Effects
 * const processChunk = Effect.fnUntraced(function*(chunk: Chunk.Chunk<number>) {
 *   const mapped = Chunk.map(chunk, (n) => n * 2)
 *   const filtered = Chunk.filter(mapped, (n) => n > 5)
 *   return Chunk.toReadonlyArray(filtered)
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as Chunk from "./Chunk.ts"

/**
 * The `Clock` module provides functionality for time-based operations in Effect applications.
 * It offers precise time measurements, scheduling capabilities, and controlled time management
 * for testing scenarios.
 *
 * The Clock service is a core component of the Effect runtime, providing:
 * - Current time access in milliseconds and nanoseconds
 * - Sleep operations for delaying execution
 * - Time-based scheduling primitives
 * - Testable time control through `TestClock`
 *
 * ## Key Features
 *
 * - **Precise timing**: Access to both millisecond and nanosecond precision
 * - **Sleep operations**: Non-blocking sleep with proper interruption handling
 * - **Service integration**: Seamless integration with Effect's dependency injection
 * - **Testable**: Mock time control for deterministic testing
 * - **Resource-safe**: Automatic cleanup of time-based resources
 *
 * **Example** (Measuring elapsed time)
 *
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * // Get current time in milliseconds
 * const getCurrentTime = Clock.currentTimeMillis
 *
 * // Sleep for 1 second
 * const sleep1Second = Effect.sleep("1 seconds")
 *
 * // Measure execution time
 * const measureTime = Effect.gen(function*() {
 *   const start = yield* Clock.currentTimeMillis
 *   yield* Effect.sleep("100 millis")
 *   const end = yield* Clock.currentTimeMillis
 *   return end - start
 * })
 * ```
 *
 * **Example** (Using the Clock service)
 *
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * // Using Clock service directly
 * const program = Effect.gen(function*() {
 *   const clock = yield* Clock.Clock
 *   const currentTime = yield* clock.currentTimeMillis
 *   console.log(`Current time: ${currentTime}`)
 *
 *   // Sleep for 500ms
 *   yield* Effect.sleep("500 millis")
 *
 *   const afterSleep = yield* clock.currentTimeMillis
 *   console.log(`After sleep: ${afterSleep}`)
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as Clock from "./Clock.ts"

/**
 * A module for combining two values of the same type into one.
 *
 * A `Combiner<A>` wraps a single binary function `(self: A, that: A) => A`.
 * It describes *how* two values merge but carries no initial/empty value
 * (for that, see {@link Reducer} which extends `Combiner` with an
 * `initialValue`).
 *
 * ## Mental model
 *
 * - **Combiner** – an object with a `combine(self, that)` method that returns
 *   a value of the same type.
 * - **Argument order** – `self` is the "left" / accumulator side, `that` is
 *   the "right" / incoming side.
 * - **No identity element** – unlike a monoid, a `Combiner` does not require
 *   a neutral element. Use {@link Reducer} when you need one.
 * - **Purity** – all combiners produced by this module are pure; they never
 *   mutate their arguments.
 * - **Composability** – combiners can be lifted into `Option`, `Struct`,
 *   `Tuple`, and other container types via helpers in those modules.
 *
 * ## Common tasks
 *
 * - Create a combiner from any binary function → {@link make}
 * - Swap argument order → {@link flip}
 * - Pick the smaller / larger of two values → {@link min} / {@link max}
 * - Always keep the first or last value → {@link first} / {@link last}
 * - Ignore both values and return a fixed result → {@link constant}
 * - Insert a separator between combined values → {@link intercalate}
 *
 * ## Gotchas
 *
 * - `min` and `max` require an `Order<A>`, not a raw comparator. Import from
 *   e.g. `Number.Order` or `String.Order`.
 * - `intercalate` is curried: call it with the separator first, then pass the
 *   base combiner.
 * - A `Reducer` (which adds `initialValue`) is also a valid `Combiner` — you
 *   can pass a `Reducer` anywhere a `Combiner` is expected.
 *
 * ## Quickstart
 *
 * **Example** (combining strings with a separator)
 *
 * ```ts
 * import { Combiner, String } from "effect"
 *
 * const csv = Combiner.intercalate(",")(String.ReducerConcat)
 *
 * console.log(csv.combine("a", "b"))
 * // Output: "a,b"
 *
 * console.log(csv.combine(csv.combine("a", "b"), "c"))
 * // Output: "a,b,c"
 * ```
 *
 * ## See also
 *
 * - {@link make} – the primary constructor
 * - {@link Combiner} – the core interface
 *
 * @since 4.0.0
 */
export * as Combiner from "./Combiner.ts"

/**
 * Declarative, schema-driven configuration loading. A `Config<T>` describes
 * how to read and validate a value of type `T` from a `ConfigProvider`. Configs
 * can be composed, transformed, and used directly as Effects.
 *
 * ## Mental model
 *
 * - **Config\<T\>** – a recipe for extracting a typed value from a
 *   `ConfigProvider`. Created via convenience constructors or {@link schema}.
 * - **ConfigProvider** – the backing data source (env vars, JSON, `.env`
 *   files). See the `ConfigProvider` module.
 * - **ConfigError** – wraps either a `SourceError` (provider I/O failure) or
 *   a `SchemaError` (validation / decoding failure).
 * - **parse** – instance method on every `Config` that takes a provider and
 *   returns `Effect<T, ConfigError>`.
 * - **Yieldable** – every `Config` can be yielded inside `Effect.gen`. It
 *   automatically resolves the current `ConfigProvider` from the context.
 *
 * ## Common tasks
 *
 * - Read a single env var → {@link string}, {@link number}, {@link boolean},
 *   {@link int}, {@link port}, {@link url}, {@link date}, {@link duration},
 *   {@link logLevel}, {@link redacted}
 * - Read a structured config → {@link schema} with a `Schema.Struct`
 * - Provide a default → {@link withDefault}
 * - Make a config optional → {@link option}
 * - Transform a value → {@link map} / {@link mapOrFail}
 * - Fall back on error → {@link orElse}
 * - Combine multiple configs → {@link all}
 * - Build from a `Schema.Codec` → {@link schema}
 * - Always succeed or fail → {@link succeed} / {@link fail}
 *
 * ## Gotchas
 *
 * - `withDefault` and `option` only apply when the error is caused by
 *   **missing data**. Validation errors (wrong type, out of range) still
 *   propagate.
 * - When yielded in `Effect.gen`, the config resolves using the current
 *   `ConfigProvider` service. To use a specific provider, call `.parse(provider)`
 *   instead.
 * - The `name` parameter on convenience constructors (e.g. `Config.string("HOST")`)
 *   sets the root path segment. Omit it when the config is part of a larger
 *   schema.
 *
 * ## Quickstart
 *
 * **Example** (Reading typed config from environment variables)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect, Schema } from "effect"
 *
 * const AppConfig = Config.schema(
 *   Schema.Struct({
 *     host: Schema.String,
 *     port: Schema.Int
 *   }),
 *   "app"
 * )
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: { app_host: "localhost", app_port: "8080" }
 * })
 *
 * // Effect.runSync(AppConfig.parse(provider))
 * // { host: "localhost", port: 8080 }
 * ```
 *
 * @see {@link schema} – build a Config from any Schema.Codec
 * @see {@link ConfigError} – the error type for config failures
 * @see {@link make} – low-level Config constructor
 *
 * @since 4.0.0
 */
export * as Config from "./Config.ts"

/**
 * Provides the data source layer for the `Config` module. A `ConfigProvider`
 * knows how to load raw configuration nodes from a backing store (environment
 * variables, JSON objects, `.env` files, file trees) and expose them through a
 * uniform `Node` interface that `Config` schemas consume.
 *
 * ## Mental model
 *
 * - **Node** – a discriminated union (`Value | Record | Array`) that describes
 *   what lives at a given path in the configuration tree.
 * - **Path** – an array of string or numeric segments used to address a node
 *   (e.g. `["database", "host"]`).
 * - **ConfigProvider** – an object with a `load(path)` method that resolves a
 *   path to a `Node | undefined`. Providers can be composed and transformed.
 * - **Context.Reference** – `ConfigProvider` is registered as a reference
 *   service that defaults to `fromEnv()`, so it works without explicit
 *   provision.
 * - **SourceError** – the typed error returned when a backing store is
 *   unreadable (I/O failure, permission error, etc.).
 *
 * ## Common tasks
 *
 * - Read from environment variables → {@link fromEnv}
 * - Read from a JSON / plain object → {@link fromUnknown}
 * - Parse a `.env` string → {@link fromDotEnvContents}
 * - Load a `.env` file → {@link fromDotEnv}
 * - Read from a directory tree → {@link fromDir}
 * - Build a custom provider → {@link make}
 * - Fall back to another provider → {@link orElse}
 * - Scope a provider under a prefix → {@link nested}
 * - Convert path segments to `CONSTANT_CASE` → {@link constantCase}
 * - Transform path segments arbitrarily → {@link mapInput}
 * - Install a provider as a Layer → {@link layer} / {@link layerAdd}
 *
 * ## Gotchas
 *
 * - `fromEnv` joins path segments with `_` for lookup **and** splits env var
 *   names on `_` to discover child keys. `DATABASE_HOST=x` is therefore
 *   accessible at both `["DATABASE_HOST"]` and `["DATABASE", "HOST"]`.
 * - Because of `_` splitting, querying a parent path like `["DATABASE"]`
 *   returns a `Record` node with child key `"HOST"`, even if no env var
 *   named `DATABASE` exists.
 * - When using `fromEnv` with schemas that use camelCase keys, pipe the
 *   provider through {@link constantCase} so `databaseHost` resolves to
 *   `DATABASE_HOST`.
 * - `orElse` only falls back when the primary provider returns `undefined`
 *   (path not found). It does **not** catch `SourceError`.
 * - `nested` prepends segments to the path *after* `mapInput` has run, so
 *   the order of composition matters.
 *
 * ## Quickstart
 *
 * **Example** (Reading config from environment variables)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: { APP_PORT: "3000", APP_HOST: "localhost" }
 * })
 *
 * const port = Config.number("port")
 *
 * const program = port.parse(
 *   provider.pipe(
 *     ConfigProvider.nested("app"),
 *     ConfigProvider.constantCase
 *   )
 * )
 *
 * // Effect.runSync(program) // 3000
 * ```
 *
 * @see {@link make} – build a provider from a lookup function
 * @see {@link fromEnv} – the default provider backed by `process.env`
 * @see {@link fromUnknown} – provider backed by a plain JS object
 *
 * @since 4.0.0
 */
export * as ConfigProvider from "./ConfigProvider.ts"

/**
 * The `Console` module provides a functional interface for console operations within
 * the Effect ecosystem. It offers type-safe logging, debugging, and console manipulation
 * capabilities with built-in support for testing and environment isolation.
 *
 * ## Key Features
 *
 * - **Type-safe logging**: All console operations return Effects for composability
 * - **Testable**: Mock console output for testing scenarios
 * - **Service-based**: Integrated with Effect's dependency injection system
 * - **Environment isolation**: Different console implementations per environment
 * - **Rich API**: Support for all standard console methods (log, error, debug, etc.)
 * - **Performance tracking**: Built-in timing and profiling capabilities
 *
 * ## Core Operations
 *
 * - **Basic logging**: `log`, `error`, `warn`, `info`, `debug`
 * - **Assertions**: `assert` for conditional logging
 * - **Grouping**: `group`, `groupCollapsed`, `groupEnd` for organized output
 * - **Timing**: `time`, `timeEnd`, `timeLog` for performance measurement
 * - **Data display**: `table`, `dir`, `dirxml` for structured data visualization
 * - **Utilities**: `clear`, `count`, `countReset`, `trace`
 *
 * **Example** (Logging basic messages)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Basic logging
 * const program = Effect.gen(function*() {
 *   yield* Console.log("Hello, World!")
 *   yield* Console.error("Something went wrong")
 *   yield* Console.warn("This is a warning")
 *   yield* Console.info("Information message")
 * })
 * ```
 *
 * **Example** (Grouping timed logs)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Grouped logging with timing
 * const debugProgram = Console.withGroup(
 *   Effect.gen(function*() {
 *     yield* Console.log("Step 1: Loading...")
 *     yield* Effect.sleep("100 millis")
 *
 *     yield* Console.log("Step 2: Processing...")
 *     yield* Effect.sleep("200 millis")
 *   }),
 *   { label: "Processing Data" }
 * )
 * ```
 *
 * **Example** (Displaying structured data)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Data visualization and debugging
 * const dataProgram = Effect.gen(function*() {
 *   const users = [
 *     { id: 1, name: "Alice", age: 30 },
 *     { id: 2, name: "Bob", age: 25 }
 *   ]
 *
 *   yield* Console.table(users)
 *   yield* Console.dir(users[0], { depth: 2 })
 *   yield* Console.assert(users.length > 0, "Users array should not be empty")
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as Console from "./Console.ts"

/**
 * This module provides a data structure called `Context` that can be used
 * for dependency injection in effectful programs. It is essentially a table
 * mapping `Service`s identifiers to their implementations, and can be used to
 * manage dependencies in a type-safe way. The `Context` data structure is
 * essentially a way of providing access to a set of related services that can
 * be passed around as a single unit. This module provides functions to create,
 * modify, and query the contents of a `Context`, as well as a number of
 * utility types for working with a `Context`.
 *
 * @since 4.0.0
 */
export * as Context from "./Context.ts"

/**
 * The `Cron` module provides utilities for representing recurring calendar
 * schedules with cron expressions. A `Cron` value stores allowed seconds,
 * minutes, hours, days of month, months, weekdays, and an optional time zone,
 * then uses those constraints to test dates and find scheduled occurrences.
 *
 * **Mental model**
 *
 * - A cron schedule is a set of allowed values for each time field
 * - Expressions may use five fields (`minute hour day month weekday`) or six
 *   fields (`second minute hour day month weekday`); five-field expressions
 *   default seconds to `0`
 * - Each field supports `*`, comma-separated values, ranges, and step syntax
 * - Month and weekday fields support aliases such as `JAN`, `DEC`, `SUN`, and
 *   `MON`
 * - Empty internal field sets represent an unconstrained field, the same idea
 *   as `*`
 * - When both day-of-month and weekday are constrained, matching uses cron's
 *   inclusive behavior: either field may match
 *
 * **Common tasks**
 *
 * - Build directly from field constraints: {@link make}
 * - Parse expressions safely: {@link parse}
 * - Parse expressions and throw on invalid input: {@link parseUnsafe}
 * - Check whether a date satisfies a schedule: {@link match}
 * - Find adjacent scheduled dates: {@link next}, {@link prev}
 * - Iterate future scheduled dates: {@link sequence}
 * - Compare schedule constraints: {@link equals}, {@link Equivalence}
 * - Detect parse failures: {@link CronParseError}, {@link isCronParseError}
 *
 * **Gotchas**
 *
 * - Weekdays are numbered `0` through `6`, with `0` representing Sunday
 * - Months are numbered `1` through `12`, while JavaScript `Date` months are
 *   zero-based
 * - `*` normalizes to an empty set internally, so inspect schedules with the
 *   public helpers instead of assuming every allowed value is stored
 * - `next` and `prev` search strictly after or before the provided instant
 * - Time-zone-aware schedules account for daylight saving transitions; during
 *   a fall-back transition, repeated local times are emitted once when moving
 *   forward
 *
 * @since 2.0.0
 */
export * as Cron from "./Cron.ts"

/**
 * The `Crypto` module provides a platform-agnostic service for cryptographic
 * operations. Runtime packages such as `@effect/platform-node`,
 * `@effect/platform-bun`, and `@effect/platform-browser` provide concrete
 * implementations backed by the host platform's cryptography APIs.
 *
 * Use `Crypto` for cryptographic randomness, UUID generation, random values,
 * and message digests. The base `Random` service is not cryptographically
 * secure unless you replace it with a cryptographically secure implementation.
 *
 * **Example** (Providing a test Crypto service)
 *
 * ```ts
 * import { Console, Crypto, Effect, Layer } from "effect"
 *
 * const TestCrypto = Layer.succeed(
 *   Crypto.Crypto,
 *   Crypto.make({
 *     randomBytes: (size) => new Uint8Array(size),
 *     digest: (_algorithm, data) => Effect.succeed(data)
 *   })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const crypto = yield* Crypto.Crypto
 *   const id = yield* crypto.randomUUIDv4
 *   yield* Console.log(`Created id: ${id}`)
 * })
 *
 * Effect.runPromise(Effect.provide(program, TestCrypto))
 * ```
 *
 * **Example** (Generating random bytes)
 *
 * ```ts
 * import { Crypto, Effect, Layer } from "effect"
 *
 * const TestCrypto = Layer.succeed(
 *   Crypto.Crypto,
 *   Crypto.make({
 *     randomBytes: (size) => new Uint8Array(size),
 *     digest: (_algorithm, data) => Effect.succeed(data)
 *   })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const crypto = yield* Crypto.Crypto
 *   return yield* crypto.randomBytes(32)
 * })
 *
 * Effect.runPromise(Effect.provide(program, TestCrypto))
 * ```
 *
 * @since 4.0.0
 */
export * as Crypto from "./Crypto.ts"

/**
 * Immutable data constructors with discriminated-union support.
 *
 * The `Data` module provides base classes and factory functions for creating
 * immutable value types with a `_tag` field for discriminated unions.
 * It is the recommended way to define domain models, error types, and
 * lightweight ADTs in Effect applications.
 *
 * ## Mental model
 *
 * - **`Class`** — base class for plain immutable data. Extend it with a type
 *   parameter to declare the fields. Instances are `Pipeable`.
 * - **`TaggedClass`** — like `Class` but automatically adds a `readonly _tag`
 *   string literal field. Useful for single-variant types or ad-hoc tagged
 *   values.
 * - **`TaggedEnum`** (type) + **`taggedEnum`** (value) — define a multi-variant
 *   discriminated union from a simple record. `taggedEnum()` returns per-variant
 *   constructors plus `$is` / `$match` helpers.
 * - **`Error`** — like `Class` but extends `Cause.YieldableError`, so instances
 *   can be yielded inside `Effect.gen` to fail the effect.
 * - **`TaggedError`** — like `TaggedClass` but extends `Cause.YieldableError`.
 *   Works with `Effect.catchTag` for tag-based error recovery.
 *
 * ## Common tasks
 *
 * - Define a simple value class → {@link Class}
 * - Define a value class with a `_tag` → {@link TaggedClass}
 * - Define a discriminated union with constructors → {@link TaggedEnum} + {@link taggedEnum}
 * - Define a yieldable error → {@link Error}
 * - Define a yieldable tagged error → {@link TaggedError}
 * - Type-guard a tagged value → `$is` from {@link taggedEnum}
 * - Pattern-match on a tagged union → `$match` from {@link taggedEnum}
 *
 * ## Gotchas
 *
 * - Variant records passed to `TaggedEnum` must **not** contain a `_tag` key;
 *   the `_tag` is added automatically from the record key.
 * - When a class has no fields, the constructor argument is optional (`void`).
 * - `taggedEnum()` creates **plain objects**, not class instances. If you need
 *   class-based variants, use `TaggedClass` or `TaggedError` instead.
 * - `TaggedEnum.WithGenerics` supports up to 4 generic type parameters.
 *
 * ## Quickstart
 *
 * **Example** (tagged union with pattern matching)
 *
 * ```ts
 * import { Data } from "effect"
 *
 * type Shape = Data.TaggedEnum<{
 *   Circle: { readonly radius: number }
 *   Rect: { readonly width: number; readonly height: number }
 * }>
 * const { Circle, Rect, $match } = Data.taggedEnum<Shape>()
 *
 * const area = $match({
 *   Circle: ({ radius }) => Math.PI * radius ** 2,
 *   Rect: ({ width, height }) => width * height
 * })
 *
 * console.log(area(Circle({ radius: 5 })))
 * // 78.53981633974483
 * console.log(area(Rect({ width: 3, height: 4 })))
 * // 12
 * ```
 *
 * @see {@link Class} — plain immutable data class
 * @see {@link TaggedEnum} — discriminated union type
 * @see {@link taggedEnum} — discriminated union constructors
 * @see {@link TaggedError} — yieldable tagged error class
 *
 * @since 2.0.0
 */
export * as Data from "./Data.ts"

/**
 * The `DateTime` module provides immutable data types and utilities for working
 * with instants, UTC date-times, zoned date-times, and time zones. A
 * `DateTime` is always an absolute point in time, represented internally by
 * epoch milliseconds, and may also carry a `TimeZone` for zone-aware calendar
 * parts and formatting.
 *
 * **Mental model**
 *
 * - `DateTime` is a discriminated union: `Utc | Zoned`
 * - `Utc` stores an absolute instant without an associated time zone
 * - `Zoned` stores the same kind of absolute instant plus a `TimeZone`
 * - Time zones can be fixed offsets or named IANA zones such as `"Europe/Rome"`
 * - Comparison and ordering use the instant, so two values in different zones
 *   can still be equivalent
 * - Calendar parts and formatted output depend on whether you ask for UTC parts
 *   or zone-adjusted parts
 *
 * **Common tasks**
 *
 * - Construct values: {@link make}, {@link makeUnsafe}, {@link makeZoned}, {@link makeZonedUnsafe}
 * - Get the current instant: {@link now}, {@link nowInCurrentZone}
 * - Create time zones: {@link zoneMakeOffset}, {@link zoneMakeNamed}, {@link zoneFromString}
 * - Attach or change zones: {@link setZone}, {@link setZoneNamed}, {@link setZoneCurrent}, {@link toUtc}
 * - Convert to platform values or parts: {@link toDate}, {@link toDateUtc}, {@link toEpochMillis}, {@link toParts}, {@link toPartsUtc}
 * - Compare and bound values: {@link Equivalence}, {@link Order}, {@link distance}, {@link min}, {@link max}, {@link clamp}, {@link between}
 * - Transform values: {@link add}, {@link subtract}, {@link startOf}, {@link endOf}, {@link nearest}, {@link setParts}, {@link mutate}
 * - Format values: {@link format}, {@link formatUtc}, {@link formatLocal}, {@link formatIntl}, {@link formatIso}, {@link formatIsoZoned}
 * - Provide an application time zone: {@link CurrentTimeZone}, {@link withCurrentZone}, {@link layerCurrentZone}
 *
 * **Gotchas**
 *
 * - `make` and `makeZoned` return `Option`; unsafe constructors throw on invalid
 *   input
 * - `DateTime` equality is instant-based, not display-time-based
 * - `setZone` changes the zone used for local parts and formatting without
 *   changing the represented instant
 * - Use `adjustForTimeZone` with {@link makeZoned} when input parts should be
 *   interpreted as wall-clock time in the target zone
 * - Daylight-saving gaps and repeated local times are resolved with
 *   `Disambiguation`
 * - Prefer the Clock-backed {@link now} and `CurrentTimeZone` services in
 *   Effect workflows; unsafe helpers read from the host environment directly
 *
 * **See also**
 *
 * - {@link DateTime} for the UTC/zoned data model
 * - {@link TimeZone} for offset and named time-zone values
 * - {@link Disambiguation} for daylight-saving ambiguity handling
 *
 * @since 3.6.0
 */
export * as DateTime from "./DateTime.ts"

/**
 * This module provides utilities for working with `Deferred`, a powerful concurrency
 * primitive that represents an asynchronous variable that can be set exactly once.
 * Multiple fibers can await the same `Deferred` and will all be notified when it
 * completes.
 *
 * A `Deferred<A, E>` can be:
 * - **Completed successfully** with a value of type `A`
 * - **Failed** with an error of type `E`
 * - **Interrupted** if the fiber setting it is interrupted
 *
 * Key characteristics:
 * - **Single assignment**: Can only be completed once
 * - **Multiple waiters**: Many fibers can await the same `Deferred`
 * - **Fiber-safe**: Thread-safe operations across concurrent fibers
 * - **Composable**: Works seamlessly with other Effect operations
 *
 * **Example** (Coordinating fibers with a Deferred)
 *
 * ```ts
 * import { Deferred, Effect, Fiber } from "effect"
 *
 * // Basic usage: coordinate between fibers
 * const program = Effect.gen(function*() {
 *   const deferred = yield* Deferred.make<string, never>()
 *
 *   // Fiber 1: waits for the value
 *   const waiter = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       const value = yield* Deferred.await(deferred)
 *       console.log("Received:", value)
 *       return value
 *     })
 *   )
 *
 *   // Fiber 2: sets the value after a delay
 *   const setter = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("1 second")
 *       yield* Deferred.succeed(deferred, "Hello from setter!")
 *     })
 *   )
 *
 *   // Wait for both fibers
 *   yield* Fiber.join(waiter)
 *   yield* Fiber.join(setter)
 * })
 *
 * // Producer-consumer pattern
 * const producerConsumer = Effect.gen(function*() {
 *   const buffer = yield* Deferred.make<Array<number>, never>()
 *
 *   const producer = Effect.gen(function*() {
 *     const data = [1, 2, 3, 4, 5]
 *     yield* Deferred.succeed(buffer, data)
 *   })
 *
 *   const consumer = Effect.gen(function*() {
 *     const data = yield* Deferred.await(buffer)
 *     return data.reduce((sum, n) => sum + n, 0)
 *   })
 *
 *   const [, result] = yield* Effect.all([producer, consumer])
 *   return result // 15
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as Deferred from "./Deferred.ts"

/**
 * The `Differ` module defines the core abstraction for describing changes to a
 * value. A `Differ<T, Patch>` knows how to compare two `T` values, produce a
 * patch that represents the difference, combine multiple patches, and apply a
 * patch to an old value to obtain the updated value.
 *
 * **Mental model**
 *
 * - A differ separates "what changed" from "the value after the change"
 * - `diff(oldValue, newValue)` produces a `Patch` that can later be applied
 * - `patch(oldValue, patch)` replays a patch against a value of the same domain
 * - `empty` is the identity patch: applying it should leave the value unchanged
 * - `combine(first, second)` composes patches in sequence, where `second`
 *   represents changes that happen after `first`
 * - Patch types are chosen by the differ implementation and may be compact,
 *   domain-specific, or compatible with a serialization format such as JSON
 *   Patch
 *
 * **Common tasks**
 *
 * - Construct a differ by providing the four operations of the {@link Differ}
 *   interface
 * - Compute a patch with `diff` when you have an old value and a new value
 * - Store, transmit, or aggregate patches instead of storing full replacement
 *   values
 * - Combine incremental updates with `combine` before applying them
 * - Apply updates with `patch` to reconstruct the next value from a previous
 *   value and a patch
 *
 * **Gotchas**
 *
 * - `combine` is order-sensitive for most patch formats
 * - A patch is generally meaningful only for values that belong to the same
 *   domain and assumptions used by the differ that created it
 * - Differs should make `empty` a true identity and should make combined
 *   patches behave the same as applying the original patches in order
 *
 * @since 4.0.0
 */
export * as Differ from "./Differ.ts"

/**
 * This module provides utilities for working with durations of time. A `Duration`
 * is an immutable data type that represents a span of time with high precision,
 * supporting operations from nanoseconds to weeks.
 *
 * Durations support:
 * - **High precision**: Nanosecond-level accuracy using BigInt
 * - **Multiple formats**: Numbers (millis), BigInt (nanos), tuples, strings
 * - **Arithmetic operations**: Add, subtract, multiply, divide
 * - **Comparisons**: Equal, less than, greater than
 * - **Conversions**: Between different time units
 * - **Human-readable formatting**: Pretty printing and parsing
 *
 * @since 2.0.0
 */
export * as Duration from "./Duration.ts"

/**
 * The `Effect` module is the core of the Effect library, providing a powerful and expressive
 * way to model and compose asynchronous, concurrent, and effectful computations.
 *
 * An `Effect<A, E, R>` represents a computation that:
 * - May succeed with a value of type `A`
 * - May fail with an error of type `E`
 * - Requires a context/environment of type `R`
 *
 * Effects are lazy and immutable - they describe computations that can be executed later.
 * This allows for powerful composition, error handling, resource management, and concurrency
 * patterns.
 *
 * ## Key Features
 *
 * - **Type-safe error handling**: Errors are tracked in the type system
 * - **Resource management**: Automatic cleanup with scoped resources
 * - **Structured concurrency**: Safe parallel and concurrent execution
 * - **Composable**: Effects can be combined using operators like `flatMap`, `map`, `zip`
 * - **Testable**: Built-in support for testing with controlled environments
 * - **Interruptible**: Effects can be safely interrupted and cancelled
 *
 * **Example** (Creating and running effects)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Creating a simple effect
 * const hello = Effect.succeed("Hello, World!")
 *
 * // Composing effects
 * const program = Effect.gen(function*() {
 *   const message = yield* hello
 *   yield* Console.log(message)
 *   return message.length
 * })
 *
 * // Running the effect
 * Effect.runPromise(program).then(console.log) // 13
 * ```
 *
 * **Example** (Handling typed failures)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class DiscountRateError extends Data.TaggedError("DiscountRateError")<{}> {}
 *
 * // Effect that may fail
 * const divide = (a: number, b: number) =>
 *   b === 0
 *     ? Effect.fail(new DiscountRateError())
 *     : Effect.succeed(a / b)
 *
 * // Error handling
 * const program = Effect.gen(function*() {
 *   const result = yield* divide(10, 2)
 *   console.log("Result:", result) // Result: 5
 *   return result
 * })
 *
 * // Handle errors
 * const safeProgram = program.pipe(
 *   Effect.match({
 *     onFailure: (error) => -1,
 *     onSuccess: (value) => value
 *   })
 * )
 * ```
 *
 * @since 2.0.0
 */
export * as Effect from "./Effect.ts"

/**
 * The `Effectable` module provides low-level building blocks for defining
 * custom values that behave like `Effect`s. It is primarily used by library
 * authors who need domain-specific effect-like data types, such as service
 * keys, configuration descriptions, prompts, or other declarative programs
 * that can be yielded inside `Effect.gen`.
 *
 * **Mental model**
 *
 * - `Effectable` does not run effects by itself; it provides prototypes that
 *   implement the internal Effect protocol.
 * - {@link Prototype} creates a primitive Effect prototype with a custom
 *   evaluation function that receives the current `Fiber`.
 * - {@link Class} is an abstract base class for defining custom classes whose
 *   instances are also `Effect` values.
 * - The success, error, and service requirements of the custom type are
 *   preserved through the `Effect.Effect<A, E, R>` type parameters.
 *
 * **Common tasks**
 *
 * - Build an effect-like interface around a declarative data structure.
 * - Implement a custom `evaluate` hook that interprets the value in terms of
 *   the current fiber and returns the underlying `Effect`.
 * - Extend {@link Class} when a nominal class-based API is more convenient
 *   than manually wiring a prototype.
 *
 * **Gotchas**
 *
 * - This module is intentionally low-level; most application code should use
 *   `Effect` constructors and combinators instead.
 * - `evaluate` must return an `Effect` with the same success, error, and
 *   service types as the custom value.
 * - Because these APIs participate in the internal Effect protocol, keep
 *   implementations small and follow existing modules such as `Config` and
 *   `Context` when adding new effect-like types.
 *
 * @since 4.0.0
 */
export * as Effectable from "./Effectable.ts"

/**
 * Encoding & decoding for Base64 (RFC4648), Base64Url, and Hex.
 *
 * @since 4.0.0
 */
export * as Encoding from "./Encoding.ts"

/**
 * Structural and custom equality for Effect values.
 *
 * The `Equal` module provides deep structural comparison for primitives, plain
 * objects, arrays, Maps, Sets, Dates, and RegExps. Types that implement the
 * {@link Equal} interface can supply their own comparison logic while staying
 * compatible with the rest of the ecosystem (HashMap, HashSet, etc.).
 *
 * ## Mental model
 *
 * - **Structural equality** — two values are equal when their contents match,
 *   not when they share the same reference.
 * - **Hash-first shortcut** — before comparing fields, the module checks
 *   {@link Hash.hash}. If the hashes differ the objects are unequal without
 *   further traversal.
 * - **Equal interface** — any object that implements both {@link symbol} (the
 *   equality method) and `Hash.symbol` (the hash method) can define custom
 *   comparison logic.
 * - **Caching** — comparison results for object pairs are cached in a WeakMap.
 *   This makes repeated checks fast but **requires immutability** after the
 *   first comparison.
 * - **By-reference opt-out** — {@link byReference} and {@link byReferenceUnsafe}
 *   let you switch individual objects back to reference equality when you need
 *   mutable identity semantics.
 *
 * ## Common tasks
 *
 * - Compare two values → {@link equals}
 * - Check if a value implements `Equal` → {@link isEqual}
 * - Use `equals` where an `Equivalence` is expected → {@link asEquivalence}
 * - Implement custom equality on a class → implement {@link Equal} (see
 *   example on the interface)
 * - Opt an object out of structural equality → {@link byReference} /
 *   {@link byReferenceUnsafe}
 *
 * ## Gotchas
 *
 * - Objects **must be treated as immutable** after their first equality check.
 *   Results are cached; mutating an object afterwards yields stale results.
 * - `NaN` is considered equal to `NaN` (unlike `===`).
 * - Functions without an `Equal` implementation are compared by reference.
 * - Map and Set comparisons are order-independent but O(n²) in size.
 * - If only one of two objects implements `Equal`, they are never equal.
 *
 * ## Quickstart
 *
 * **Example** (basic structural comparison)
 *
 * ```ts
 * import { Equal } from "effect"
 *
 * // Primitives
 * console.log(Equal.equals(1, 1))       // true
 * console.log(Equal.equals("a", "b"))   // false
 *
 * // Objects and arrays
 * console.log(Equal.equals({ x: 1 }, { x: 1 })) // true
 * console.log(Equal.equals([1, 2], [1, 2]))       // true
 *
 * // Curried form
 * const is42 = Equal.equals(42)
 * console.log(is42(42)) // true
 * console.log(is42(0))  // false
 * ```
 *
 * @see {@link equals} — the main comparison function
 * @see {@link Equal} — the interface for custom equality
 * @see {@link Hash} — the companion hashing module
 *
 * @since 2.0.0
 */
export * as Equal from "./Equal.ts"

/**
 * Utilities for defining equivalence relations - binary relations that determine when two values
 * should be considered equivalent. Equivalence relations are used for comparing, deduplicating,
 * and organizing data in collections and data structures.
 *
 * ## Mental model
 *
 * - **Equivalence relation**: A function `(a: A, b: A) => boolean` that returns `true` when values are equivalent
 * - **Reflexive property**: Every value is equivalent to itself (`eq(a, a) === true`)
 * - **Symmetric property**: If `a` is equivalent to `b`, then `b` is equivalent to `a` (`eq(a, b) === eq(b, a)`)
 * - **Transitive property**: If `a` is equivalent to `b` and `b` is equivalent to `c`, then `a` is equivalent to `c`
 * - **Reference equality optimization**: {@link make} checks `===` first for performance before calling the custom function
 * - **Composition**: Equivalences can be combined using {@link combine} and {@link combineAll} to create more complex relations
 *
 * ## Common tasks
 *
 * - Creating custom equivalences → {@link make}
 * - Using strict equality (`===`) → {@link strictEqual}
 * - Combining multiple equivalences (AND logic) → {@link combine}, {@link combineAll}
 * - Transforming input before comparison → {@link mapInput}
 * - Creating equivalences for structured types → {@link Struct}, {@link Tuple}, {@link Array_}, {@link Record}
 *
 * ## Gotchas
 *
 * - `strictEqual` uses `===`, so `NaN !== NaN` and objects are compared by reference, not structure
 * - `make` optimizes with a reference equality check, so identical references return `true` without calling the function
 * - `combineAll` with an empty collection returns an equivalence that always returns `true`
 * - `Tuple` and `Array` require matching lengths; different lengths are never equivalent
 *
 * ## Quickstart
 *
 * **Example** (Case-insensitive string equivalence)
 *
 * ```ts
 * import { Array, Equivalence } from "effect"
 *
 * const caseInsensitive = Equivalence.make<string>((a, b) =>
 *   a.toLowerCase() === b.toLowerCase()
 * )
 *
 * const strings = ["Hello", "world", "HELLO", "World"]
 * const deduplicated = Array.dedupeWith(strings, caseInsensitive)
 * console.log(deduplicated) // ["Hello", "world"]
 * ```
 *
 * ## See also
 *
 * - {@link Equal} - For structural equality (can convert to Equivalence)
 * - {@link Array_.dedupeWith} - Remove duplicates using an equivalence
 * - {@link Chunk} - Collections that use equivalences for operations
 *
 * @since 2.0.0
 */
export * as Equivalence from "./Equivalence.ts"

/**
 * Pluggable error reporting for Effect programs.
 *
 * Reporting is triggered by `Effect.withErrorReporting`,
 * `ErrorReporter.report`, or built-in reporting boundaries in the HTTP and
 * RPC server modules.
 *
 * Each reporter receives a structured callback with the failing `Cause`, a
 * pretty-printed `Error`, severity, and any extra attributes attached to the
 * original error — making it straightforward to forward failures to Sentry,
 * Datadog, or a custom logging backend.
 *
 * Use the annotation symbols (`ignore`, `severity`, `attributes`) on your
 * error classes to control reporting behavior per-error.
 *
 * **Example** (Reporting errors with annotations)
 *
 * ```ts
 * import { Data, Effect, ErrorReporter } from "effect"
 *
 * // A reporter that logs to the console
 * const consoleReporter = ErrorReporter.make(({ error, severity }) => {
 *   console.error(`[${severity}]`, error.message)
 * })
 *
 * // An error that should be ignored by reporters
 * class NotFoundError extends Data.TaggedError("NotFoundError")<{}> {
 *   readonly [ErrorReporter.ignore] = true
 * }
 *
 * // An error with custom severity and attributes
 * class RateLimitError extends Data.TaggedError("RateLimitError")<{
 *   readonly retryAfter: number
 * }> {
 *   readonly [ErrorReporter.severity] = "Warn" as const
 *   readonly [ErrorReporter.attributes] = {
 *     retryAfter: this.retryAfter
 *   }
 * }
 *
 * // Opt in to error reporting with Effect.withErrorReporting
 * const program = Effect.gen(function*() {
 *   return yield* new RateLimitError({ retryAfter: 60 })
 * }).pipe(
 *   Effect.withErrorReporting,
 *   Effect.provide(ErrorReporter.layer([consoleReporter]))
 * )
 * ```
 *
 * @since 4.0.0
 */
export * as ErrorReporter from "./ErrorReporter.ts"

/**
 * The `ExecutionPlan` module provides a way to describe ordered fallback
 * strategies for effects and streams that need different resources across
 * repeated attempts. An `ExecutionPlan` is a non-empty list of steps, where
 * each step supplies a `Context` or `Layer` and may control retries with an
 * attempt limit, a `Schedule`, or a `while` predicate.
 *
 * **Mental model**
 *
 * - A plan is evaluated step by step until the wrapped effect or stream
 *   succeeds, or until every step has been exhausted
 * - Each step provides the services used while that step is active
 * - `attempts` limits how many times a step may be tried
 * - `schedule` controls retry timing and receives the failure input
 * - `while` can stop retrying a step based on the failure input
 * - `CurrentMetadata` exposes the current 1-based attempt and 0-based step
 *   index to code running under a plan
 *
 * **Common tasks**
 *
 * - Build a plan with {@link make}
 * - Run an effect with a plan using `Effect.withExecutionPlan`
 * - Run a stream with a plan using `Stream.withExecutionPlan`
 * - Combine plans in order with {@link merge}
 * - Capture required services up front with `captureRequirements`
 * - Inspect the current attempt and step with {@link CurrentMetadata}
 *
 * **Gotchas**
 *
 * - Plans must contain at least one step
 * - `attempts` must be greater than zero when provided
 * - If `attempts` is omitted, a step is attempted once unless a `schedule` is
 *   provided
 * - A `while` predicate returning `false` skips the remaining retries for that
 *   step and moves the plan forward
 * - Layer, schedule, and predicate requirements are tracked in the plan type
 *   until they are provided or captured
 *
 * @since 3.16.0
 */
export * as ExecutionPlan from "./ExecutionPlan.ts"

/**
 * Represents the outcome of an Effect computation as a plain, synchronously
 * inspectable value.
 *
 * ## Mental model
 *
 * - `Exit<A, E>` is a union of two cases: `Success<A, E>` and `Failure<A, E>`
 * - A `Success` wraps a value of type `A`
 * - A `Failure` wraps a `Cause<E>`, which may contain typed errors, defects, or interruptions
 * - `Exit` is also an `Effect`, so you can yield it directly inside `Effect.gen`
 * - Constructors mirror the failure modes: {@link fail} for typed errors, {@link die} for defects, {@link interrupt} for fiber interruptions
 * - Use `Exit` when you need to inspect an Effect result without running further effects
 *
 * ## Common tasks
 *
 * - Create a success: {@link succeed}
 * - Create a typed failure: {@link fail}
 * - Create a failure from a Cause: {@link failCause}
 * - Create a defect: {@link die}
 * - Create an interruption: {@link interrupt}
 * - Check the outcome: {@link isSuccess}, {@link isFailure}, {@link match}
 * - Extract values optionally: {@link getSuccess}, {@link getCause}, {@link findErrorOption}
 * - Transform the result: {@link map}, {@link mapError}, {@link mapBoth}
 * - Combine multiple exits: {@link asVoidAll}
 * - Inspect failure categories: {@link hasFails}, {@link hasDies}, {@link hasInterrupts}
 *
 * ## Gotchas
 *
 * - A `Failure` wraps a `Cause<E>`, not a bare `E`. Use Cause utilities to drill into it.
 * - {@link mapError} and {@link mapBoth} only transform typed errors (Fail reasons in the Cause). If the Cause contains only defects or interruptions, the original failure passes through unchanged.
 * - Filter-based APIs ({@link filterSuccess}, {@link filterValue}, etc.) return `Filter.fail` markers for pipeline composition. They are not `Option` values or Effect failures.
 * - {@link findError} and {@link findDefect} return only the first matching reason from the Cause.
 *
 * ## Quickstart
 *
 * **Example** (Creating and inspecting exits)
 *
 * ```ts
 * import { Exit } from "effect"
 *
 * const success = Exit.succeed(42)
 * const failure = Exit.fail("not found")
 *
 * const message = Exit.match(success, {
 *   onSuccess: (value) => `Got: ${value}`,
 *   onFailure: () => "Failed"
 * })
 * console.log(message) // "Got: 42"
 * ```
 *
 * ## See also
 *
 * - {@link Exit} the core union type
 * - {@link succeed} and {@link fail} the most common constructors
 * - {@link match} for pattern matching on an Exit
 *
 * @since 2.0.0
 */
export * as Exit from "./Exit.ts"

/**
 * This module provides utilities for working with `Fiber`, the fundamental unit of
 * concurrency in Effect. Fibers are lightweight, user-space threads that allow
 * multiple Effects to run concurrently with structured concurrency guarantees.
 *
 * Key characteristics of Fibers:
 * - **Lightweight**: Much lighter than OS threads, you can create millions
 * - **Structured concurrency**: Parent fibers manage child fiber lifecycles
 * - **Cancellation safety**: Proper resource cleanup when interrupted
 * - **Cooperative**: Fibers yield control at effect boundaries
 * - **Traceable**: Each fiber has an ID for debugging and monitoring
 *
 * Common patterns:
 * - **Fork and join**: Start concurrent work and wait for results
 * - **Race conditions**: Run multiple effects, take the first to complete
 * - **Supervision**: Monitor and restart failed fibers
 * - **Resource management**: Ensure proper cleanup on interruption
 *
 * **Example** (Running effects in fibers)
 *
 * ```ts
 * import { Console, Effect, Fiber } from "effect"
 *
 * // Basic fiber operations
 * const basicExample = Effect.gen(function*() {
 *   // Fork an effect to run concurrently
 *   const fiber = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("2 seconds")
 *       yield* Console.log("Background task completed")
 *       return "background result"
 *     })
 *   )
 *
 *   // Do other work while the fiber runs
 *   yield* Console.log("Doing other work...")
 *   yield* Effect.sleep("1 second")
 *
 *   // Wait for the fiber to complete
 *   const result = yield* Fiber.join(fiber)
 *   yield* Console.log(`Fiber result: ${result}`)
 * })
 *
 * // Joining multiple fibers
 * const joinExample = Effect.gen(function*() {
 *   const task1 = Effect.delay(Effect.succeed("task1"), "1 second")
 *   const task2 = Effect.delay(Effect.succeed("task2"), "2 seconds")
 *
 *   // Start both effects as fibers
 *   const fiber1 = yield* Effect.forkChild(task1)
 *   const fiber2 = yield* Effect.forkChild(task2)
 *
 *   // Wait for both to complete
 *   const result1 = yield* Fiber.join(fiber1)
 *   const result2 = yield* Fiber.join(fiber2)
 *   return [result1, result2] // ["task1", "task2"]
 * })
 *
 * // Parallel execution with structured concurrency
 * const parallelExample = Effect.gen(function*() {
 *   const tasks = [1, 2, 3, 4, 5].map((n) =>
 *     Effect.gen(function*() {
 *       yield* Effect.sleep(`${n * 100} millis`)
 *       return n * n
 *     })
 *   )
 *
 *   // Run all tasks in parallel, wait for all to complete
 *   const results = yield* Effect.all(tasks, { concurrency: "unbounded" })
 *   return results // [1, 4, 9, 16, 25]
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as Fiber from "./Fiber.ts"

/**
 * The `FiberHandle` module provides a scoped handle for managing the lifecycle
 * of at most one fiber at a time. A `FiberHandle<A, E>` can hold one
 * `Fiber<A, E>`; when a new fiber is installed, the previous fiber is
 * interrupted unless the operation is configured with `onlyIfMissing`.
 *
 * **Mental model**
 *
 * - A handle is either open with zero or one current fiber, or closed by its
 *   surrounding `Scope`
 * - Closing the scope interrupts the current fiber and prevents new work from
 *   being accepted
 * - Completed fibers remove themselves from the handle, so the handle can be
 *   reused for later work
 * - Replacing a fiber uses the handle's internal interruption id, allowing
 *   expected replacement interruptions to be distinguished from real failures
 *
 * **Common tasks**
 *
 * - Create a scoped handle: {@link make}
 * - Fork an effect into the handle: {@link run}
 * - Store an existing fiber: {@link set}
 * - Read or clear the current fiber: {@link get}, {@link clear}
 * - Capture runtime-specific runners: {@link makeRuntime}, {@link runtime}
 * - Run handled effects as Promises: {@link makeRuntimePromise},
 *   {@link runtimePromise}
 * - Wait for failure or closure: {@link join}
 * - Wait until the current fiber is gone: {@link awaitEmpty}
 *
 * **Gotchas**
 *
 * - The handle never contains more than one live fiber; starting or setting
 *   another fiber interrupts the previous one by default
 * - Use `onlyIfMissing` when a call should leave an already running fiber in
 *   place instead of replacing it
 * - `join` observes the handle's failure/close signal; successful fiber
 *   completion only empties the handle
 * - `awaitEmpty` waits for the fiber that is current when it starts; later
 *   calls to {@link run} or {@link set} can install new work
 *
 * @since 2.0.0
 */
export * as FiberHandle from "./FiberHandle.ts"

/**
 * The `FiberMap` module provides a scoped, mutable collection for managing
 * fibers by key. A `FiberMap<K, A, E>` owns a set of running fibers, interrupts
 * them when its scope closes, and automatically removes each entry when the
 * corresponding fiber completes.
 *
 * **Mental model**
 *
 * - A `FiberMap` is a keyed registry of fibers with lifecycle management
 * - Keys identify the currently active fiber for a logical task or resource
 * - Adding a fiber under an existing key interrupts the previous fiber by default
 * - Completed fibers remove themselves from the map if they are still current
 * - Closing the map's scope interrupts every fiber that remains in the map
 * - The map can surface the first non-ignored managed fiber failure via {@link join}
 *
 * **Common tasks**
 *
 * - Create a scoped map: {@link make}
 * - Fork effects into the map: {@link run}
 * - Add existing fibers: {@link set}
 * - Create captured runners: {@link makeRuntime}, {@link runtime}
 * - Bridge to Promise-based callers: {@link makeRuntimePromise}, {@link runtimePromise}
 * - Inspect entries: {@link get}, {@link has}, {@link size}
 * - Stop work: {@link remove}, {@link clear}
 * - Coordinate completion or failure: {@link awaitEmpty}, {@link join}
 *
 * **Gotchas**
 *
 * - `FiberMap` is scoped; use it with `Effect.scoped` or another scope owner so
 *   managed fibers are interrupted when the scope closes
 * - Reusing a key is a replacement operation unless `onlyIfMissing` is enabled
 * - `join` waits for the map to fail or close; use {@link awaitEmpty} to wait
 *   until all currently managed fibers have completed
 * - The `Unsafe` variants mutate synchronously and should only be used when the
 *   caller already controls the surrounding execution context
 *
 * @since 2.0.0
 */
export * as FiberMap from "./FiberMap.ts"

/**
 * The `FiberSet` module provides a scoped container for managing many fibers as
 * one lifecycle. A `FiberSet<A, E>` tracks fibers whose successful values are
 * compatible with `A` and whose failures are compatible with `E`, removes each
 * fiber when it completes, and interrupts all still-running fibers when the
 * owning `Scope` closes.
 *
 * **Mental model**
 *
 * - A `FiberSet` is an owned, scoped collection of fibers
 * - Fibers can be added directly with {@link add} / {@link addUnsafe}
 * - Effects can be forked into the set with {@link run}, {@link runtime}, or
 *   {@link runtimePromise}
 * - Completed fibers are automatically removed from the set
 * - Closing the scope or calling {@link clear} interrupts the currently tracked
 *   fibers
 * - {@link join} waits for the set's first non-ignored failure, while
 *   {@link awaitEmpty} waits until all tracked fibers have completed
 *
 * **Common tasks**
 *
 * - Create a scoped set: {@link make}
 * - Create scoped runners: {@link makeRuntime}, {@link makeRuntimePromise}
 * - Add an existing fiber: {@link add}
 * - Fork an effect into the set: {@link run}
 * - Interrupt tracked fibers: {@link clear}
 * - Observe the set: {@link size}, {@link awaitEmpty}, {@link join}
 * - Check a value: {@link isFiberSet}
 *
 * **Gotchas**
 *
 * - `FiberSet` values are scoped; use them inside `Effect.scoped` or another
 *   scope owner so their fibers are interrupted reliably
 * - Adding or running into a closed set interrupts the fiber immediately
 * - By default, interruptions are not treated as failures for {@link join};
 *   use the `propagateInterruption` option when interruption should be
 *   propagated
 *
 * @since 2.0.0
 */
export * as FiberSet from "./FiberSet.ts"

/**
 * This module provides a comprehensive file system abstraction that supports both synchronous
 * and asynchronous file operations through Effect. It includes utilities for file I/O, directory
 * management, permissions, timestamps, and file watching with proper error handling.
 *
 * The `FileSystem` interface provides a cross-platform abstraction over file system operations,
 * allowing you to work with files and directories in a functional, composable way. All operations
 * return `Effect` values that can be composed, transformed, and executed safely.
 *
 * **Example** (Working with files and directories)
 *
 * ```ts
 * import { Console, Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   // Create a directory
 *   yield* fs.makeDirectory("./temp", { recursive: true })
 *
 *   // Write a file
 *   yield* fs.writeFileString("./temp/hello.txt", "Hello, World!")
 *
 *   // Read the file back
 *   const content = yield* fs.readFileString("./temp/hello.txt")
 *   yield* Console.log("File content:", content)
 *
 *   // Get file information
 *   const stats = yield* fs.stat("./temp/hello.txt")
 *   yield* Console.log("File size:", stats.size)
 *
 *   // Clean up
 *   yield* fs.remove("./temp", { recursive: true })
 * })
 * ```
 *
 * @since 4.0.0
 */
export * as FileSystem from "./FileSystem.ts"

/**
 * The `Filter` module provides composable functions for accepting, rejecting,
 * narrowing, and transforming values. A `Filter<Input, Pass, Fail>` receives an
 * input and returns a `Result`: success means the value passed the filter, while
 * failure means the value was filtered out.
 *
 * **Mental model**
 *
 * - A filter is a typed predicate that can also transform the successful value
 * - Predicate-based filters pass the original input when the predicate returns `true`
 * - Refinement-based filters narrow the successful type, for example from `unknown` to `string`
 * - Custom filters return `Result.succeed(pass)` or `Result.fail(fail)` directly
 * - Filters compose with logical and sequential combinators instead of throwing exceptions
 * - `FilterEffect` is the effectful form for filters that need asynchronous work, errors, or services
 *
 * **Common tasks**
 *
 * - Build filters: {@link make}, {@link makeEffect}, {@link fromPredicate}, {@link fromPredicateOption}
 * - Narrow unknown values: {@link string}, {@link number}, {@link boolean}, {@link bigint}, {@link symbol}, {@link date}
 * - Match shapes and variants: {@link instanceOf}, {@link tagged}, {@link reason}, {@link has}
 * - Match exact values: {@link equals}, {@link equalsStrict}
 * - Combine alternatives: {@link or}
 * - Require multiple filters: {@link zip}, {@link zipWith}, {@link andLeft}, {@link andRight}
 * - Run filters in sequence: {@link compose}, {@link composePassthrough}
 * - Convert results: {@link toPredicate}, {@link toOption}, {@link toResult}
 * - Adjust failure values: {@link mapFail}
 *
 * **Gotchas**
 *
 * - A failed filter is data in the `Result` failure channel; it is not an exception
 * - `compose` preserves intermediate failure values, while {@link composePassthrough} fails with the original input
 * - `equalsStrict` uses JavaScript `===`; use {@link equals} for structural equality
 * - `fromPredicateOption` fails with the original input when the returned `Option` is `None`
 * - Prefer refinement predicates when you want TypeScript to narrow the successful value type
 *
 * @since 4.0.0
 */
export * as Filter from "./Filter.ts"

/**
 * Utilities for converting arbitrary JavaScript values into human-readable
 * strings, with support for circular references, redaction, and common JS
 * types that `JSON.stringify` handles poorly.
 *
 * Mental model:
 * - A `Formatter<Value, Format>` is a callable `(value: Value) => Format`.
 * - {@link format} is the general-purpose pretty-printer: it handles
 *   primitives, arrays, objects, `BigInt`, `Symbol`, `Date`, `RegExp`,
 *   `Set`, `Map`, class instances, and circular references.
 * - {@link formatJson} is a safe `JSON.stringify` wrapper that silently
 *   drops circular references and applies redaction.
 * - Both functions accept a `space` option for indentation control.
 *
 * Common tasks:
 * - Pretty-print any value for debugging / logging -> {@link format}
 * - Serialize to JSON safely (no circular throws) -> {@link formatJson}
 * - Format a single object property key -> {@link formatPropertyKey}
 * - Format a property path like `["a"]["b"]` -> {@link formatPath}
 * - Format a `Date` to ISO string safely -> {@link formatDate}
 *
 * Gotchas:
 * - {@link format} output is **not** valid JSON; use {@link formatJson} when
 *   you need parseable JSON.
 * - {@link format} calls `toString()` on objects by default; pass
 *   `ignoreToString: true` to disable.
 * - {@link formatJson} silently omits circular references (the key is
 *   dropped from the output).
 * - Values implementing the `Redactable` protocol are automatically
 *   redacted by both {@link format} and {@link formatJson}.
 *
 * **Example** (Pretty-print a value)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * const obj = { name: "Alice", scores: [100, 97] }
 * console.log(Formatter.format(obj))
 * // {"name":"Alice","scores":[100,97]}
 *
 * console.log(Formatter.format(obj, { space: 2 }))
 * // {
 * //   "name": "Alice",
 * //   "scores": [
 * //     100,
 * //     97
 * //   ]
 * // }
 * ```
 *
 * See also: {@link Formatter}, {@link format}, {@link formatJson}
 *
 * @since 4.0.0
 */
export * as Formatter from "./Formatter.ts"

/**
 * The `Function` module provides small, pure helpers for defining, composing,
 * adapting, and reusing TypeScript functions. It is the foundation for the
 * data-first and data-last APIs used throughout Effect, and it includes the
 * core pipeline utilities that make those APIs ergonomic.
 *
 * **Mental model**
 *
 * - {@link pipe} starts with a value and passes it through one unary function at
 *   a time
 * - {@link flow} composes unary functions into a reusable function
 * - {@link dual} builds APIs that support both direct calls and `pipe`-friendly
 *   data-last calls
 * - {@link identity}, {@link constant}, and the `const*` helpers model common
 *   identity and thunk patterns without allocating ad hoc callbacks
 * - {@link tupled}, {@link untupled}, {@link flip}, and {@link apply} adapt
 *   call shapes without changing the underlying behavior
 * - Type helpers such as {@link LazyArg}, {@link FunctionN}, {@link satisfies},
 *   and {@link cast} describe or constrain functions at the type level
 *
 * **Common tasks**
 *
 * - Build readable transformation pipelines: {@link pipe}
 * - Create reusable composed functions: {@link flow}, {@link compose}
 * - Define functions callable in both data-first and data-last style: {@link dual}
 * - Return a value unchanged: {@link identity}
 * - Create thunks and common constant functions: {@link constant},
 *   {@link constTrue}, {@link constFalse}, {@link constNull},
 *   {@link constUndefined}, {@link constVoid}
 * - Convert between rest-argument and tuple-argument functions: {@link tupled},
 *   {@link untupled}
 * - Express impossible branches: {@link absurd}
 * - Cache results for object keys: {@link memoize}
 *
 * **Gotchas**
 *
 * - Functions passed to {@link pipe} and {@link flow} are applied left-to-right
 *   and should be unary at each step
 * - {@link dual} uses either an arity or a predicate to decide whether a call is
 *   data-first or data-last; use a predicate when optional arguments make arity
 *   ambiguous
 * - {@link cast} changes only the static TypeScript type and performs no runtime
 *   validation
 * - {@link memoize} is intended for object keys and stores cached values in a
 *   `WeakMap`
 *
 * @since 2.0.0
 */
export * as Function from "./Function.ts"

/**
 * The `Graph` module provides immutable and scoped-mutable graph data
 * structures for modeling relationships between indexed nodes and edges. A
 * graph can be directed or undirected, stores user-defined data on both nodes
 * and edges, and exposes traversal, analysis, path finding, transformation, and
 * diagram export utilities.
 *
 * **Mental model**
 *
 * - Nodes and edges are addressed by stable numeric indices: {@link NodeIndex}
 *   and {@link EdgeIndex}
 * - Node data has type `N`; edge data has type `E`
 * - {@link Graph} values are immutable snapshots; use {@link MutableGraph}
 *   through {@link mutate}, {@link beginMutation}, or constructor callbacks to
 *   add, remove, or update nodes and edges
 * - Directed graphs follow edge direction for neighbors and traversals, while
 *   undirected graphs treat each edge as connecting both endpoints
 * - Missing lookups return `Option`, while structurally invalid operations such
 *   as adding an edge to a missing node throw {@link GraphError}
 *
 * **Common tasks**
 *
 * - Create graphs: {@link directed}, {@link undirected}
 * - Mutate safely: {@link mutate}, {@link addNode}, {@link addEdge},
 *   {@link removeNode}, {@link removeEdge}
 * - Query contents: {@link getNode}, {@link getEdge}, {@link hasNode},
 *   {@link hasEdge}, {@link nodeCount}, {@link edgeCount}, {@link neighbors}
 * - Transform data: {@link updateNode}, {@link updateEdge}, {@link mapNodes},
 *   {@link mapEdges}, {@link filterNodes}, {@link filterEdges},
 *   {@link filterMapNodes}, {@link filterMapEdges}
 * - Traverse lazily: {@link dfs}, {@link bfs}, {@link topo},
 *   {@link dfsPostOrder}, {@link nodes}, {@link edges}, {@link Walker}
 * - Analyze structure: {@link isAcyclic}, {@link isBipartite},
 *   {@link connectedComponents}, {@link stronglyConnectedComponents},
 *   {@link externals}
 * - Find paths: {@link dijkstra}, {@link astar}, {@link bellmanFord},
 *   {@link floydWarshall}
 * - Export diagrams: {@link toGraphViz}, {@link toMermaid}
 *
 * **Gotchas**
 *
 * - Only mutable graphs can be changed. Create one with {@link mutate} or by
 *   passing a callback to {@link directed} / {@link undirected}.
 * - Traversal APIs return lazy {@link Walker} values. Use {@link indices},
 *   {@link values}, or {@link entries} to choose what each iteration yields.
 * - `NodeIndex` and `EdgeIndex` values are identifiers, not array offsets. They
 *   are not reused after removals.
 * - Shortest-path algorithms require a cost function. {@link dijkstra} and
 *   {@link astar} reject negative weights; use {@link bellmanFord} or
 *   {@link floydWarshall} when negative weights are part of the model.
 *
 * @since 4.0.0
 */
export * as Graph from "./Graph.ts"

/**
 * This module provides utilities for hashing values in TypeScript.
 *
 * Hashing is the process of converting data into a fixed-size numeric value,
 * typically used for data structures like hash tables, equality comparisons,
 * and efficient data storage.
 *
 * @since 2.0.0
 */
export * as Hash from "./Hash.ts"

/**
 * The `HashMap` module provides an immutable key-value data structure with
 * efficient lookup, insertion, removal, and transformation operations. A
 * `HashMap<Key, Value>` stores entries by hashing keys and resolving matches
 * with Effect's structural equality semantics.
 *
 * **Mental model**
 *
 * - A `HashMap<Key, Value>` is an immutable collection of key-value pairs
 * - Operations such as {@link set}, {@link remove}, and {@link modifyAt} return
 *   new maps; existing maps are not mutated
 * - Keys are compared using the `Equal` protocol and are grouped by hashes from
 *   the `Hash` protocol
 * - Plain JavaScript primitives work as keys, and custom objects can define
 *   `Equal` / `Hash` behavior for structural lookup
 * - Lookups with {@link get} return an `Option`, making missing keys explicit
 * - Iteration order is based on the map's internal hash structure and should
 *   not be treated as insertion order
 *
 * **Common tasks**
 *
 * - Create maps: {@link empty}, {@link make}, {@link fromIterable}
 * - Read values: {@link get}, {@link getUnsafe}, {@link has}, {@link hasBy}
 * - Add or update entries: {@link set}, {@link modify}, {@link modifyAt}, {@link setMany}
 * - Remove entries: {@link remove}, {@link removeMany}
 * - Combine maps: {@link union}
 * - Iterate or convert: {@link keys}, {@link values}, {@link entries}, {@link toValues}, {@link toEntries}
 * - Transform values: {@link map}, {@link flatMap}, {@link filter}, {@link filterMap}, {@link compact}
 * - Fold and search: {@link reduce}, {@link findFirst}, {@link some}, {@link every}
 * - Batch updates efficiently: {@link mutate}, {@link beginMutation}, {@link endMutation}
 *
 * **Gotchas**
 *
 * - {@link getUnsafe} throws when the key is absent; prefer {@link get} unless
 *   absence is impossible by construction
 * - Mutating a key object after insertion can make future lookups fail if its
 *   equality or hash changes
 * - Hash collisions are handled by equality checks, so matching hashes alone do
 *   not make two keys equal
 * - Use {@link getHash} and {@link hasHash} only when you already have the
 *   correct hash for the same key
 * - Convert entries to an array and sort them when deterministic presentation is
 *   required
 *
 * **Quickstart**
 *
 * **Example** (Working with immutable maps)
 *
 * ```ts
 * import { HashMap, Option } from "effect"
 *
 * const scores = HashMap.make(["alice", 10], ["bob", 15])
 *
 * const updated = scores.pipe(
 *   HashMap.set("carol", 20),
 *   HashMap.modify("alice", (score) => score + 1)
 * )
 *
 * console.log(HashMap.get(updated, "alice"))
 * // Output: Option.some(11)
 *
 * console.log(HashMap.get(scores, "carol"))
 * // Output: Option.none()
 *
 * console.log(Option.getOrElse(HashMap.get(updated, "dave"), () => 0))
 * // Output: 0
 * ```
 *
 * **See also**
 *
 * - {@link HashSet} for immutable sets backed by hash semantics
 * - {@link Equal} for structural equality
 * - {@link Hash} for hash implementations used by hashed collections
 *
 * @since 2.0.0
 */
export * as HashMap from "./HashMap.ts"

/**
 * The `HashRing` module provides a weighted consistent-hashing data structure
 * for assigning arbitrary string inputs to a changing set of nodes. A hash ring
 * minimizes remapping when nodes are added, removed, or reweighted, which makes
 * it useful for routing requests, partitioning keys, and distributing shards
 * across service instances or storage backends.
 *
 * **Mental model**
 *
 * - Each node is identified by its {@link PrimaryKey.PrimaryKey} value
 * - {@link add} and {@link addMany} place weighted virtual points on the ring
 * - {@link get} hashes an input string and returns the nearest node on the ring
 * - {@link getShards} assigns a fixed number of shard indexes across the nodes
 * - Higher weights receive proportionally more virtual points and shard
 *   allocations
 * - Operations mutate and return the same ring instance
 *
 * **Common tasks**
 *
 * - Create an empty ring: {@link make}
 * - Add or update nodes: {@link add}, {@link addMany}
 * - Remove nodes: {@link remove}
 * - Check membership by primary key: {@link has}
 * - Route an input key to a node: {@link get}
 * - Precompute shard ownership: {@link getShards}
 * - Guard unknown values: {@link isHashRing}
 *
 * **Gotchas**
 *
 * - Empty rings return `undefined` from {@link get} and {@link getShards}
 * - Nodes with the same primary key represent the same ring member
 * - Weights are clamped to a positive minimum so a node remains represented
 * - Mutating a ring in place is intentional; create a new ring when independent
 *   snapshots are required
 *
 * **Quickstart**
 *
 * **Example** (Routing keys across nodes)
 *
 * ```ts
 * import { HashRing, PrimaryKey } from "effect"
 *
 * class Node implements PrimaryKey.PrimaryKey {
 *   constructor(readonly id: string) {}
 *
 *   [PrimaryKey.symbol](): string {
 *     return this.id
 *   }
 * }
 *
 * const ring = HashRing.make<Node>().pipe(
 *   HashRing.add(new Node("node-a")),
 *   HashRing.add(new Node("node-b"), { weight: 2 })
 * )
 *
 * const owner = HashRing.get(ring, "user:123")
 * console.log(owner ? PrimaryKey.value(owner) : undefined)
 * ```
 *
 * @since 4.0.0
 */
export * as HashRing from "./HashRing.ts"

/**
 * The `HashSet` module provides an immutable set data structure for storing
 * unique values with efficient membership checks, additions, removals, and set
 * operations. A `HashSet<A>` contains at most one value for each equality class
 * as determined by Effect's `Equal` / `Hash` semantics.
 *
 * **Mental model**
 *
 * - `HashSet<A>` is an immutable collection of unique values of type `A`
 * - Operations such as {@link add}, {@link remove}, {@link union}, and
 *   {@link difference} return new sets; the input set is never mutated
 * - Membership is checked with {@link has}, using Effect equality and hashing
 *   rather than array-style linear scanning
 * - Duplicate values are collapsed when using {@link make}, {@link fromIterable},
 *   {@link add}, or {@link map}
 * - `HashSet` is iterable, but iteration order is not a sorting guarantee
 *
 * **Common tasks**
 *
 * - Create sets: {@link empty}, {@link make}, {@link fromIterable}
 * - Check membership and size: {@link has}, {@link size}, {@link isEmpty}
 * - Add or remove values: {@link add}, {@link remove}
 * - Combine sets: {@link union}, {@link intersection}, {@link difference}
 * - Compare sets: {@link isSubset}
 * - Transform or select values: {@link map}, {@link filter}
 * - Test values: {@link some}, {@link every}
 * - Fold values: {@link reduce}
 *
 * **Gotchas**
 *
 * - Values that should compare structurally should implement compatible
 *   `Equal` and `Hash` behavior; otherwise object identity may affect whether
 *   values are considered distinct
 * - {@link map} may reduce the set size when multiple input values map to the
 *   same output value
 * - Do not rely on iteration order for deterministic presentation; sort the
 *   values after converting to an array when order matters
 *
 * @since 2.0.0
 */
export * as HashSet from "./HashSet.ts"

/**
 * This module provides utilities for Higher-Kinded Types (HKT) in TypeScript.
 *
 * Higher-Kinded Types are types that take other types as parameters, similar to how
 * functions take values as parameters. They enable generic programming over type
 * constructors, allowing you to write code that works with any container type
 * (like Array, Option, Effect, etc.) in a uniform way.
 *
 * The HKT system in Effect uses TypeLambdas to encode type-level functions that
 * can represent complex type relationships with multiple type parameters, including
 * contravariant, covariant, and invariant positions.
 *
 * **Example** (Encoding type lambdas)
 *
 * ```ts
 * import type { HKT } from "effect"
 *
 * // Define a TypeLambda for Array
 * interface ArrayTypeLambda extends HKT.TypeLambda {
 *   readonly type: Array<this["Target"]>
 * }
 *
 * // Use Kind to get the concrete type
 * type MyArray = HKT.Kind<ArrayTypeLambda, never, never, never, string>
 * // MyArray is Array<string>
 *
 * // Define a TypeClass that works with any HKT
 * interface Functor<F extends HKT.TypeLambda> extends HKT.TypeClass<F> {
 *   map<A, B>(
 *     fa: HKT.Kind<F, never, never, never, A>,
 *     f: (a: A) => B
 *   ): HKT.Kind<F, never, never, never, B>
 * }
 * ```
 *
 * @since 2.0.0
 */
export * as HKT from "./HKT.ts"

/**
 * This module provides utilities for making values inspectable and debuggable in TypeScript.
 *
 * The Inspectable interface provides a standard way to implement custom string representations
 * for objects, making them easier to debug and inspect. It includes support for JSON
 * serialization, Node.js inspection, and safe circular reference handling.
 *
 * The module also includes redaction capabilities for sensitive data, allowing objects
 * to provide different representations based on the current execution context.
 *
 * **Example** (Creating inspectable values)
 *
 * ```ts
 * import { Formatter, Inspectable } from "effect"
 *
 * class User extends Inspectable.Class {
 *   constructor(
 *     public readonly name: string,
 *     public readonly email: string
 *   ) {
 *     super()
 *   }
 *
 *   toJSON() {
 *     return {
 *       _tag: "User",
 *       name: this.name,
 *       email: this.email
 *     }
 *   }
 * }
 *
 * const user = new User("Alice", "alice@example.com")
 * console.log(user.toString()) // Pretty printed JSON
 * console.log(Formatter.format(user)) // Same as toString()
 * ```
 *
 * @since 2.0.0
 */
export * as Inspectable from "./Inspectable.ts"

/**
 * This module provides utility functions for working with Iterables in TypeScript.
 *
 * Iterables are objects that implement the iterator protocol, allowing them to be
 * consumed with `for...of` loops, spread syntax, and other iteration constructs.
 * This module provides a comprehensive set of functions for creating, transforming,
 * and working with iterables in a functional programming style.
 *
 * Unlike arrays, iterables can be lazy and potentially infinite, making them suitable
 * for stream processing and memory-efficient data manipulation. All functions in this
 * module preserve the lazy nature of iterables where possible.
 *
 * **Example** (Working with iterables)
 *
 * ```ts
 * import { Iterable, Option } from "effect"
 *
 * // Create iterables
 * const numbers = Iterable.range(1, 5)
 * const doubled = Iterable.map(numbers, (x) => x * 2)
 * const filtered = Iterable.filter(doubled, (x) => x > 5)
 *
 * console.log(Array.from(filtered)) // [6, 8, 10]
 *
 * // Infinite iterables
 * const fibonacci = Iterable.unfold([0, 1], ([a, b]) => Option.some([a, [b, a + b]]))
 * const first10 = Iterable.take(fibonacci, 10)
 * console.log(Array.from(first10)) // [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
 * ```
 *
 * @since 2.0.0
 */
export * as Iterable from "./Iterable.ts"

/**
 * JSON Patch operations for transforming JSON documents.
 *
 * This module implements a subset of RFC 6902, providing operations that can be applied deterministically without additional context. It supports computing structural diffs between JSON values and applying patches to transform documents.
 *
 * ## Mental model
 *
 * - **JSON Patch**: An ordered sequence of operations that transform a document from one state to another
 * - **JSON Pointer**: Path syntax for targeting specific locations in a JSON document (e.g., `/users/0/name`)
 * - **Operations**: Three types - `add` (insert value), `remove` (delete value), `replace` (update value)
 * - **Immutable transformations**: All operations return new values; inputs are never mutated
 * - **Sequential application**: Operations are applied in order, with later operations observing changes from earlier ones
 * - **Structural diff**: The `get` function computes differences by comparing structure, not content semantics
 *
 * ## Common tasks
 *
 * - Computing diffs between JSON values → {@link get}
 * - Applying patches to transform documents → {@link apply}
 * - Creating patches manually → {@link JsonPatchOperation}
 * - Storing and validating patch documents → {@link JsonPatch}
 *
 * ## Gotchas
 *
 * - Array removals are emitted from highest index to lowest to avoid index shifting during application
 * - Root operations use an empty string path `""` to target the entire document
 * - Array append operations use `-` as the last token in the path (e.g., `/items/-`)
 * - Generated patches are deterministic but not guaranteed to be minimal
 * - Empty patches return the original document reference (no allocation)
 * - Invalid paths or operations throw errors rather than returning a result type
 *
 * ## Quickstart
 *
 * **Example** (Computing and applying a patch)
 *
 * ```ts
 * import { JsonPatch } from "effect"
 *
 * const oldValue = { name: "Alice", age: 30 }
 * const newValue = { name: "Alice", age: 31, city: "NYC" }
 *
 * const patch = JsonPatch.get(oldValue, newValue)
 * // [{ op: "replace", path: "/age", value: 31 }, { op: "add", path: "/city", value: "NYC" }]
 *
 * const result = JsonPatch.apply(patch, oldValue)
 * // { name: "Alice", age: 31, city: "NYC" }
 * ```
 *
 * ## See also
 *
 * - {@link JsonPointer} - Utilities for working with JSON Pointer paths
 * - {@link Schema.Json} - The JSON value type used by this module
 *
 * @since 4.0.0
 */
export * as JsonPatch from "./JsonPatch.ts"

/**
 * Utilities for escaping and unescaping JSON Pointer reference tokens according to RFC 6901.
 *
 * JSON Pointer (RFC 6901) defines a string syntax for identifying a specific value within a JSON document.
 * A JSON Pointer is a sequence of reference tokens separated by forward slashes (`/`). Each reference token
 * must be escaped when it contains special characters (`~` or `/`).
 *
 * ## Mental model
 *
 * - **Reference token**: A single segment of a JSON Pointer path (e.g., `"foo"`, `"bar/baz"`, `"key~with~tilde"`)
 * - **Escaping**: Encoding special characters in a token so it can be safely used in a JSON Pointer (`~` → `~0`, `/` → `~1`)
 * - **Unescaping**: Decoding escaped characters back to their original form (`~0` → `~`, `~1` → `/`)
 * - **RFC 6901 compliance**: These functions implement the standard escaping rules for JSON Pointer reference tokens
 * - **Pure functions**: Both operations are pure, immutable, and have no side effects
 *
 * ## Common tasks
 *
 * - Building JSON Pointers from path segments → {@link escapeToken}
 * - Parsing JSON Pointers to extract original token values → {@link unescapeToken}
 * - Escaping object keys or path segments before constructing JSON Pointers → {@link escapeToken}
 * - Extracting unescaped identifiers from JSON Pointer strings → {@link unescapeToken}
 *
 * ## Gotchas
 *
 * - These functions operate on **reference tokens**, not full JSON Pointers. A full JSON Pointer like `/foo/bar` must be split into tokens (`["foo", "bar"]`) before escaping/unescaping
 * - The order of replacement operations matters: `escapeToken` replaces `~` before `/` to avoid double-escaping
 * - Empty strings are valid tokens and are returned unchanged
 * - These functions do not validate JSON Pointer syntax; they only handle token-level escaping
 *
 * ## Quickstart
 *
 * **Example** (Building and parsing a JSON Pointer)
 *
 * ```ts
 * import { JsonPointer } from "effect"
 *
 * // Build a JSON Pointer from path segments
 * const segments = ["users", "name/alias", "value"]
 * const pointer = "/" + segments.map(JsonPointer.escapeToken).join("/")
 * // "/users/name~1alias/value"
 *
 * // Parse a JSON Pointer back to segments
 * const tokens = pointer.split("/").slice(1).map(JsonPointer.unescapeToken)
 * // ["users", "name/alias", "value"]
 * ```
 *
 * ## See also
 *
 * - {@link JsonPatch} - Uses these utilities for JSON Patch operations
 * - {@link JsonSchema} - Uses these utilities for schema reference resolution
 *
 * @since 4.0.0
 */
export * as JsonPointer from "./JsonPointer.ts"

/**
 * Convert JSON Schema documents between dialects (Draft-07, Draft-2020-12,
 * OpenAPI 3.0, OpenAPI 3.1). All dialects are normalized to an internal
 * `Document<"draft-2020-12">` representation before optional conversion to
 * an output dialect.
 *
 * ## Mental model
 *
 * - **JsonSchema** — a plain object with string keys; represents any single
 *   JSON Schema node.
 * - **Dialect** — one of `"draft-07"`, `"draft-2020-12"`, `"openapi-3.1"`,
 *   or `"openapi-3.0"`.
 * - **Document** — a structured container holding a root `schema`, its
 *   companion `definitions`, and the target `dialect`. Definitions are
 *   stored separately from the root schema so they can be relocated when
 *   converting between dialects.
 * - **MultiDocument** — same as `Document` but carries multiple root
 *   schemas (at least one). Useful when generating several schemas that
 *   share a single definitions pool.
 * - **Definitions** — a `Record<string, JsonSchema>` keyed by definition
 *   name. The ref pointer prefix depends on the dialect.
 * - **`from*` functions** — parse a raw JSON Schema object into the
 *   canonical `Document<"draft-2020-12">`.
 * - **`to*` functions** — convert from the canonical representation to a
 *   specific output dialect.
 *
 * ## Common tasks
 *
 * - Parse a Draft-07 schema → {@link fromSchemaDraft07}
 * - Parse a Draft-2020-12 schema → {@link fromSchemaDraft2020_12}
 * - Parse an OpenAPI 3.1 schema → {@link fromSchemaOpenApi3_1}
 * - Parse an OpenAPI 3.0 schema → {@link fromSchemaOpenApi3_0}
 * - Convert to Draft-07 output → {@link toDocumentDraft07}
 * - Convert to OpenAPI 3.1 output → {@link toMultiDocumentOpenApi3_1}
 * - Resolve a `$ref` against definitions → {@link resolve$ref}
 * - Inline the root `$ref` of a document → {@link resolveTopLevel$ref}
 *
 * ## Gotchas
 *
 * - All `from*` functions normalize to `Document<"draft-2020-12">`
 *   regardless of the input dialect.
 * - Unsupported or unrecognized JSON Schema keywords are silently dropped
 *   during conversion.
 * - Draft-07 tuple syntax (`items` as array + `additionalItems`) is
 *   converted to 2020-12 form (`prefixItems` + `items`), and vice-versa.
 * - OpenAPI 3.0 `nullable: true` is expanded into `type` arrays or
 *   `anyOf` unions. The `nullable` keyword is removed.
 * - OpenAPI 3.0 singular `example` is converted to `examples` (array).
 * - {@link resolve$ref} only looks up the last segment of the ref path in
 *   the definitions map; it does not follow arbitrary JSON Pointer paths.
 *
 * ## Quickstart
 *
 * **Example** (Parse a Draft-07 schema and convert to Draft-07 output)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const raw: JsonSchema.JsonSchema = {
 *   type: "object",
 *   properties: {
 *     name: { type: "string" }
 *   },
 *   required: ["name"]
 * }
 *
 * // Parse into canonical form
 * const doc = JsonSchema.fromSchemaDraft07(raw)
 *
 * // Convert back to Draft-07
 * const draft07 = JsonSchema.toDocumentDraft07(doc)
 *
 * console.log(draft07.dialect) // "draft-07"
 * console.log(draft07.schema) // { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
 * ```
 *
 * ## See also
 *
 * - {@link Document}
 * - {@link MultiDocument}
 * - {@link fromSchemaDraft07}
 * - {@link toDocumentDraft07}
 * - {@link resolve$ref}
 *
 * @since 4.0.0
 */
export * as JsonSchema from "./JsonSchema.ts"

/**
 * The `Latch` module provides a reusable synchronization primitive for
 * coordinating fibers. A `Latch` is either open or closed: when it is closed,
 * fibers that use {@link await} or {@link whenOpen} suspend until the latch is
 * opened or the current waiters are released.
 *
 * **Mental model**
 *
 * - An open latch lets current and future waiters continue immediately
 * - A closed latch causes `await` and `whenOpen` to suspend
 * - {@link open} permanently opens the latch until it is closed again
 * - {@link release} wakes only the fibers currently waiting and leaves the
 *   latch closed for future waiters
 * - {@link close} resets the latch so later waiters suspend again
 *
 * **Common tasks**
 *
 * - Create a latch inside `Effect`: {@link make}
 * - Create a latch synchronously: {@link makeUnsafe}
 * - Wait for a signal before continuing: {@link await}
 * - Guard an effect so it runs only after the latch is open: {@link whenOpen}
 * - Let all current and future waiters proceed: {@link open}
 * - Let only the current waiters proceed: {@link release}
 * - Re-enable waiting after opening: {@link close}
 *
 * **Gotchas**
 *
 * - `release` is not the same as `open`; new waiters still suspend after the
 *   current waiters are released
 * - `open` and `close` report whether they changed the latch state
 * - Prefer the effectful APIs unless synchronous allocation or mutation is
 *   required
 *
 * @since 4.0.0
 */
export * as Latch from "./Latch.ts"

/**
 * A `Layer<ROut, E, RIn>` describes how to build one or more services in your
 * application. Services can be injected into effects via
 * `Effect.provideService`. Effects can require services via `Effect.service`.
 *
 * A layer is a recipe for producing services from their dependencies:
 *
 * - `ROut` is what the layer provides.
 * - `E` is what can fail while building the layer.
 * - `RIn` is what the layer needs in order to build.
 *
 * Normal application code should ask for services. Layer code should create
 * services. The application entry point should provide the final layer once.
 * Keeping this boundary clear makes programs easier to reuse with production,
 * test, or mock implementations.
 *
 * Construction of services can be effectful and can acquire resources that must
 * be safely released when the services are no longer used. For example, a layer
 * can open a database pool during acquisition and close it in a finalizer.
 *
 * Layers are lazy: they do not build anything until they are provided to a
 * program or explicitly built. By default layers are shared, meaning that if the
 * same layer value is used twice, it is allocated only once and both users share
 * the same service instance.
 *
 * Because of their excellent composition properties, layers are the idiomatic
 * way in Effect to create services that depend on other services.
 *
 * @since 2.0.0
 */
export * as Layer from "./Layer.ts"

/**
 * The `LayerMap` module provides utilities for managing scoped resources that
 * are selected by key and built from `Layer` values. A `LayerMap<K, I, E>` turns
 * a key into a cached service `Context<I>`, so applications can lazily acquire
 * and reuse different resource instances such as tenant clients, regional
 * connections, environment-specific services, or other keyed infrastructure.
 *
 * **Mental model**
 *
 * - A `LayerMap` is a scoped, reference-counted cache of contexts produced by layers
 * - Keys identify which layer-backed resource set should be acquired
 * - Resources are acquired on demand when a key is requested
 * - The same key reuses the cached context while it remains live
 * - Cached resources are finalized when invalidated, when their scope closes, or after idle expiration
 * - The layers built by a `LayerMap` share the current layer memoization map
 *
 * **Common tasks**
 *
 * - Create from a lookup function: {@link make}
 * - Create from a fixed record of layers: {@link fromRecord}
 * - Define a service wrapper with accessor helpers: {@link Service}
 * - Retrieve a layer for a key: {@link LayerMap.get}
 * - Retrieve a scoped context directly: {@link LayerMap.contextEffect}
 * - Force a cached entry to be rebuilt later: {@link LayerMap.invalidate}
 * - Remove idle entries automatically with the `idleTimeToLive` option
 * - Eagerly build known entries with `preloadKeys` or `preload`
 *
 * **Gotchas**
 *
 * - `contextEffect` requires a `Scope.Scope` because it exposes the acquired context directly
 * - `get` returns a `Layer` that can be provided to programs expecting the keyed services
 * - Invalidating a key finalizes the current cached resources for that key; the next access rebuilds them
 * - Preloading moves layer construction errors to `LayerMap` creation instead of first use
 *
 * @since 3.14.0
 */
export * as LayerMap from "./LayerMap.ts"

/**
 * The `Logger` module defines the logging model used by the Effect runtime and
 * provides constructors for formatting, routing, batching, and installing
 * loggers. A `Logger<Message, Output>` receives each runtime log event as an
 * {@link Options} value and transforms it into an output such as a string,
 * structured object, JSON line, console write, file write, or trace span event.
 *
 * **Mental model**
 *
 * - Effect programs emit log events with APIs such as `Effect.log`,
 *   `Effect.logInfo`, `Effect.logWarning`, and `Effect.logError`
 * - Each event contains a message, log level, cause, fiber, and timestamp
 * - Loggers are ordinary values created with {@link make} and installed with
 *   {@link layer}
 * - Multiple loggers can be active at once by providing a layer with several
 *   logger values
 * - Formatter loggers such as {@link formatLogFmt}, {@link formatStructured},
 *   and {@link formatJson} return formatted data without writing it anywhere
 * - Console loggers such as {@link consolePretty}, {@link consoleLogFmt},
 *   {@link consoleStructured}, and {@link consoleJson} write formatted output
 *   to the active Effect console
 *
 * **Log output structure**
 *
 * Built-in formatters include the log level, timestamp, fiber identifier, and
 * logged message. When present, they also include the pretty-printed cause,
 * active log annotations, and active log spans. Structured and JSON loggers keep
 * these fields as machine-readable data, while logfmt and pretty loggers render
 * them as human-readable text.
 *
 * **Common tasks**
 *
 * - Create a custom logger: {@link make}
 * - Transform logger output: {@link map}
 * - Write formatter output to the console: {@link withConsoleLog},
 *   {@link withConsoleError}, {@link withLeveledConsole}
 * - Use built-in console loggers: {@link consolePretty}, {@link consoleLogFmt},
 *   {@link consoleStructured}, {@link consoleJson}
 * - Use built-in formatter loggers: {@link formatSimple}, {@link formatLogFmt},
 *   {@link formatStructured}, {@link formatJson}
 * - Batch logger output before flushing to a sink: {@link batched}
 * - Write string logger output to a file: {@link toFile}
 * - Preserve trace correlation by including {@link tracerLogger}
 * - Install or replace loggers for an effect: {@link layer}
 *
 * **Gotchas**
 *
 * - {@link layer} replaces the current logger set by default; pass
 *   `mergeWithExisting: true` when adding loggers to the existing runtime
 *   loggers
 * - Formatter loggers only produce values; wrap them with console, file, batch,
 *   or custom sink loggers when output should be written somewhere
 * - {@link batched} and {@link toFile} are scoped; keep their scope open while
 *   logs are being emitted so buffered entries can flush reliably
 * - {@link toFile} accepts only loggers that output strings, so pair it with
 *   string formatters such as {@link formatJson} or {@link formatLogFmt}
 * - The default runtime logger set includes {@link tracerLogger}; replacing
 *   loggers without merging may remove automatic log-to-trace-span recording
 *
 * **Quickstart**
 *
 * **Example** (Installing a JSON console logger)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.logInfo("request started", { method: "GET", path: "/users" })
 *   yield* Effect.logError("request failed", { status: 500 })
 * }).pipe(
 *   Effect.annotateLogs("service", "users-api"),
 *   Effect.withLogSpan("http.request"),
 *   Effect.provide(Logger.layer([Logger.consoleJson]))
 * )
 * ```
 *
 * **See also**
 *
 * - {@link make} for defining custom loggers
 * - {@link layer} for installing loggers
 * - {@link formatJson} and {@link consoleJson} for structured production logs
 * - {@link consolePretty} for readable local logs
 *
 * @since 2.0.0
 */
export * as Logger from "./Logger.ts"

/**
 * The `LogLevel` module defines the levels used by Effect logging and the
 * ordering operations used to compare, filter, and enable log output.
 *
 * **Mental model**
 *
 * - A `LogLevel` is one of `All`, `Fatal`, `Error`, `Warn`, `Info`, `Debug`,
 *   `Trace`, or `None`
 * - `Fatal` is the most severe concrete level and `Trace` is the least severe
 * - `All` and `None` are sentinel levels: `All` enables every message and
 *   `None` disables every message
 * - Ordering follows logging severity, so higher levels are more important and
 *   lower levels are more verbose
 * - Filtering is usually expressed as "log this message when its level is
 *   greater than or equal to the configured minimum"
 *
 * **Common tasks**
 *
 * - Enumerate levels with {@link values}
 * - Compare exact levels with {@link Equivalence}
 * - Sort or compare by severity with {@link Order} and {@link getOrdinal}
 * - Check thresholds with {@link isGreaterThanOrEqualTo} and
 *   {@link isLessThanOrEqualTo}
 * - Test whether a level is enabled for the current fiber with
 *   {@link isEnabled}
 *
 * **Gotchas**
 *
 * - `All` and `None` are useful for configuration boundaries, but they are not
 *   concrete message severities; use {@link Severity} when only emitted message
 *   levels are valid
 * - The comparison helpers compare severity, not declaration position in source
 *   code or alphabetical order
 * - `isEnabled` reads the current fiber's `MinimumLogLevel` reference, so it is
 *   context-sensitive; use the pure comparison helpers when checking an
 *   explicit threshold
 *
 * @since 2.0.0
 */
export * as LogLevel from "./LogLevel.ts"

/**
 * The `ManagedRuntime` module provides a way to build a reusable runtime from
 * a `Layer` and use it to run effects that require the services produced by
 * that layer. A `ManagedRuntime<R, ER>` owns the lifecycle of the layer-built
 * resources, caches the resulting `Context<R>`, and exposes runners for
 * integrating Effect programs with JavaScript entry points.
 *
 * **Mental model**
 *
 * - A managed runtime is created from a `Layer` with {@link make}
 * - The layer is built lazily the first time the runtime is used
 * - The built context is cached and reused for subsequent effect executions
 * - Resources acquired by the layer are owned by the runtime's internal scope
 * - Disposing the runtime closes that scope and releases all managed resources
 * - Effects run through the runtime receive the layer's services automatically
 *
 * **Common tasks**
 *
 * - Create a runtime from application services: {@link make}
 * - Run an effect as a `Promise`: {@link ManagedRuntime.runPromise}
 * - Run an effect and keep its `Exit`: {@link ManagedRuntime.runPromiseExit}
 * - Fork an effect into a `Fiber`: {@link ManagedRuntime.runFork}
 * - Bridge callback-style APIs: {@link ManagedRuntime.runCallback}
 * - Run synchronous effects at program boundaries: {@link ManagedRuntime.runSync},
 *   {@link ManagedRuntime.runSyncExit}
 * - Access the cached service context: {@link ManagedRuntime.context}
 * - Release layer resources: {@link ManagedRuntime.dispose},
 *   {@link ManagedRuntime.disposeEffect}
 *
 * **Gotchas**
 *
 * - Always dispose a managed runtime when it is no longer needed, especially
 *   when the layer acquires resources such as connections, servers, or files
 * - Layer construction errors are included in the error channel of runtime
 *   runners, so `ER` is combined with the effect's own error type
 * - `runSync` can only execute effects without asynchronous boundaries; use
 *   `runPromise` for asynchronous programs
 * - After disposal, the runtime cannot be reused
 *
 * @since 2.0.0
 */
export * as ManagedRuntime from "./ManagedRuntime.ts"

/**
 * The `effect/match` module provides a type-safe pattern matching system for
 * TypeScript. Inspired by functional programming, it simplifies conditional
 * logic by replacing verbose if/else or switch statements with a structured and
 * expressive API.
 *
 * This module supports matching against types, values, and discriminated unions
 * while enforcing exhaustiveness checking to ensure all cases are handled.
 *
 * Although pattern matching is not yet a native JavaScript feature,
 * `effect/match` offers a reliable implementation that is available today.
 *
 * **How Pattern Matching Works**
 *
 * Pattern matching follows a structured process:
 *
 * - **Creating a matcher**: Define a `Matcher` that operates on either a
 *   specific `Match.type` or `Match.value`.
 *
 * - **Defining patterns**: Use combinators such as `Match.when`, `Match.not`,
 *   and `Match.tag` to specify matching conditions.
 *
 * - **Completing the match**: Apply a finalizer such as `Match.exhaustive`,
 *   `Match.orElse`, or `Match.option` to determine how unmatched cases should
 *   be handled.
 *
 * @since 4.0.0
 */
export * as Match from "./Match.ts"

/**
 * The `Metric` module provides tools for defining, updating, tagging, and
 * reading application metrics from Effect programs. A `Metric<Input, State>`
 * accepts typed input values and aggregates them into a typed state that can be
 * read directly or exported from a snapshot.
 *
 * **Mental model**
 *
 * - A metric has an identifier, a type, an optional description, optional attributes, and mutable aggregate state
 * - Use counters for cumulative values such as requests, errors, retries, or bytes processed
 * - Use gauges for point-in-time values that can rise or fall, such as active connections or queue size
 * - Use frequencies to count occurrences of discrete string values, such as status codes or action names
 * - Use histograms to bucket numeric observations and inspect count, min, max, and sum
 * - Use summaries to calculate quantiles over a bounded, time-based observation window
 * - Metrics are updated from effects with {@link update} and {@link modify}, and read with {@link value}
 * - Attributes tag metrics with key-value dimensions so the same logical metric can be grouped by service, endpoint, method, or other labels
 * - Snapshots capture the currently registered metrics and their aggregate states for reporting or export
 *
 * **Common tasks**
 *
 * - Create counters: {@link counter}
 * - Create gauges: {@link gauge}
 * - Create frequencies: {@link frequency}
 * - Create histograms: {@link histogram}, {@link linearBoundaries}, {@link exponentialBoundaries}
 * - Create summaries: {@link summary}, {@link summaryWithTimestamp}
 * - Measure effect duration: {@link timer}
 * - Update a metric: {@link update}
 * - Apply relative updates where supported: {@link modify}
 * - Read one metric: {@link value}
 * - Tag a metric: {@link withAttributes}
 * - Transform accepted input values: {@link mapInput}
 * - Record a constant input for repeated events: {@link withConstantInput}
 * - Inspect all registered metrics: {@link snapshot}, {@link dump}
 * - Enable fiber runtime metrics: {@link enableRuntimeMetrics}
 *
 * **Gotchas**
 *
 * - Counter and gauge metrics can use `number` inputs by default or `bigint` inputs with the `bigint` option
 * - Incremental counters ignore negative updates; use non-incremental counters only when decreases are meaningful
 * - {@link update} sets a gauge to an absolute value, while {@link modify} changes it relative to its current value
 * - Histogram buckets are cumulative and depend on the boundaries supplied when the metric is created
 * - Summary quantiles are calculated from the configured sliding window, so old observations expire
 * - Prefer low-cardinality attributes; using unbounded values such as request IDs can create too many metric series
 *
 * **Quickstart**
 *
 * **Example** (Creating and updating metrics)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const requestCount = Metric.counter("http_requests_total", {
 *   description: "Total number of HTTP requests"
 * })
 *
 * const responseTime = Metric.histogram("http_response_time", {
 *   description: "HTTP response time in milliseconds",
 *   boundaries: Metric.linearBoundaries({ start: 0, width: 50, count: 20 })
 * })
 *
 * const handleRequest = Effect.gen(function*() {
 *   yield* Metric.update(
 *     Metric.withAttributes(requestCount, {
 *       endpoint: "/api/users",
 *       method: "GET"
 *     }),
 *     1
 *   )
 *
 *   yield* Metric.update(responseTime, 125)
 *
 *   return yield* Metric.value(requestCount)
 * })
 * ```
 *
 * **See also**
 *
 * - {@link counter} / {@link gauge} / {@link frequency} for common metric types
 * - {@link histogram} / {@link summary} for distribution metrics
 * - {@link update} / {@link modify} / {@link value} for working with metric state
 * - {@link withAttributes} for adding dimensions
 * - {@link snapshot} for exporting all registered metric values
 *
 * @since 2.0.0
 */
export * as Metric from "./Metric.ts"

/**
 * MutableHashMap is a high-performance, mutable hash map implementation designed for efficient key-value storage
 * with support for both structural and referential equality. It provides O(1) average-case performance for
 * basic operations and integrates seamlessly with Effect's Equal and Hash interfaces.
 *
 * The implementation uses a hybrid approach:
 * - Referential keys (without Equal implementation) are stored in a native Map
 * - Structural keys (with Equal implementation) are stored in hash buckets with collision handling
 *
 * Key Features:
 * - Mutable operations for performance-critical scenarios
 * - Supports both structural and referential equality
 * - Efficient collision handling through bucketing
 * - Iterable interface for easy traversal
 * - Memory-efficient storage with automatic bucket management
 *
 * Performance Characteristics:
 * - Get/Set/Has: O(1) average, O(n) worst case (hash collisions)
 * - Remove: O(1) average, O(n) worst case
 * - Clear: O(1)
 * - Size: O(1)
 * - Iteration: O(n)
 *
 * @since 2.0.0
 */
export * as MutableHashMap from "./MutableHashMap.ts"

/**
 * The `MutableHashSet` module provides a mutable hash set for storing unique
 * values with efficient membership checks, insertion, removal, and iteration.
 * It is built on {@link MutableHashMap}: each set value is stored as a map key,
 * so uniqueness follows the same hashing and equality rules as the underlying
 * mutable hash map.
 *
 * **Mental model**
 *
 * - `MutableHashSet<V>` is a mutable collection of unique values of type `V`
 * - Operations such as {@link add}, {@link remove}, and {@link clear} mutate
 *   the set in place
 * - Duplicate values are ignored according to Effect equality and hashing semantics
 * - Values that implement `Equal` / `Hash` are compared structurally
 * - Primitive values and references that do not implement Effect equality use
 *   the normal hash map behavior
 * - The set is iterable, so `Array.from(set)` or `for...of` can be used to
 *   inspect its values
 *
 * **Common tasks**
 *
 * - Create an empty set: {@link empty}
 * - Create from values: {@link make}
 * - Create from any iterable: {@link fromIterable}
 * - Add a value: {@link add}
 * - Check membership: {@link has}
 * - Remove a value: {@link remove}
 * - Remove all values: {@link clear}
 * - Count unique values: {@link size}
 * - Narrow unknown values: {@link isMutableHashSet}
 *
 * **Gotchas**
 *
 * - This data structure is intentionally mutable; keep ownership clear when
 *   sharing it between callers
 * - Mutating operations return the same set instance for convenient piping, not
 *   a copy
 * - Iteration order should not be used as a stable sorting mechanism
 * - For immutable set operations, use Effect's immutable collection modules
 *   instead
 *
 * **Performance**
 *
 * - Add, membership checks, and removal are O(1) on average and O(n) in the
 *   presence of hash collisions
 * - Clearing and reading the size are O(1)
 * - Iteration is O(n)
 *
 * **Quickstart**
 *
 * **Example** (Tracking unique values)
 *
 * ```ts
 * import { MutableHashSet } from "effect"
 *
 * const set = MutableHashSet.make("apple", "banana", "apple")
 *
 * MutableHashSet.add(set, "cherry")
 * MutableHashSet.remove(set, "banana")
 *
 * console.log(MutableHashSet.has(set, "apple"))
 * // Output: true
 *
 * console.log(MutableHashSet.size(set))
 * // Output: 2
 *
 * console.log(Array.from(set))
 * // Output: ["apple", "cherry"]
 * ```
 *
 * @since 2.0.0
 */
export * as MutableHashSet from "./MutableHashSet.ts"

/**
 * The `MutableList` module provides a mutable linked list for accumulating,
 * ordering, inspecting, and draining values with efficient operations at both
 * ends of the list.
 *
 * A `MutableList<A>` stores values in linked buckets of arrays. Appending adds
 * values to the tail, prepending adds values to the head, and taking removes
 * values from the head. Unlike persistent collections, every mutation updates
 * the list object in place: operations such as {@link append}, {@link prepend},
 * {@link take}, {@link takeN}, {@link clear}, {@link filter}, and {@link remove}
 * change the same `MutableList` instance and update its `length`.
 *
 * **Mental model**
 *
 * - `MutableList<A>` is a stateful container with `head`, `tail`, and `length`
 * - Values are consumed from the head with {@link take}, {@link takeN}, or
 *   {@link takeAll}
 * - {@link append} and {@link appendAll} preserve FIFO queue order for normal
 *   producer-consumer use cases
 * - {@link prepend} and {@link prependAll} place values before the current
 *   contents, which is useful for priority work or restoring items to the front
 * - {@link toArray} and {@link toArrayN} copy values without modifying the list
 * - The `head` and `tail` bucket fields are exposed for advanced use, but most
 *   code should treat them as implementation details
 *
 * **Common tasks**
 *
 * - Create an empty list: {@link make}
 * - Add one value: {@link append}, {@link prepend}
 * - Add many values: {@link appendAll}, {@link prependAll}
 * - Drain one value: {@link take}
 * - Drain many values: {@link takeN}, {@link takeAll}
 * - Inspect without draining: {@link toArrayN}, {@link toArray}
 * - Reset the list: {@link clear}
 * - Mutate contents in place: {@link filter}, {@link remove}
 *
 * **Gotchas**
 *
 * - `MutableList` is intentionally mutable; sharing a list means sharing its
 *   changing state
 * - {@link take} returns the {@link Empty} symbol when the list has no value, so
 *   compare with `MutableList.Empty` instead of relying on falsy checks
 * - {@link appendAllUnsafe} and {@link prependAllUnsafe} may reuse the provided
 *   array when `mutable` is `true`; only enable that optimization when callers
 *   will not keep using the array independently
 * - {@link remove} uses JavaScript strict equality semantics, not structural
 *   equality
 *
 * @since 4.0.0
 */
export * as MutableList from "./MutableList.ts"

/**
 * The `MutableRef` module provides a small synchronous container for mutable
 * state. A `MutableRef<A>` stores one current value of type `A`, exposes that
 * value through `.current`, and offers pipeable helpers for reading, replacing,
 * and transforming the value in place.
 *
 * **Mental model**
 *
 * - `MutableRef<A>` is a stable reference whose `.current` field may change over time
 * - Reads and writes are synchronous and return immediately
 * - `set`, `update`, `increment`, `decrement`, and `toggle` mutate the same reference in place
 * - `getAnd*` helpers return the previous value, while `*AndGet` helpers return the new value
 * - `compareAndSet` updates only when the current value is equal to the expected value using `Equal.equals`
 * - A `MutableRef` is useful for local mutable state, but it does not make updates transactional or effectful
 *
 * **Common tasks**
 *
 * - Create a reference: {@link make}
 * - Read the current value: {@link get} or `.current`
 * - Replace the current value: {@link set}, {@link setAndGet}, {@link getAndSet}
 * - Transform the current value: {@link update}, {@link updateAndGet}, {@link getAndUpdate}
 * - Coordinate conditional replacement: {@link compareAndSet}
 * - Work with counters: {@link increment}, {@link decrement}, {@link incrementAndGet}, {@link decrementAndGet}
 * - Work with boolean flags: {@link toggle}
 *
 * **Gotchas**
 *
 * - All updates are imperative mutations; aliases to the same `MutableRef` observe the same changing value
 * - Updating object or array values does not clone them unless the update function creates a new value
 * - `compareAndSet` compares with Effect equality semantics, not only JavaScript reference equality
 * - For state that must participate in `Effect` workflows, interruption, or fiber coordination, prefer higher-level Effect data types
 *
 * @since 2.0.0
 */
export * as MutableRef from "./MutableRef.ts"

/**
 * Lightweight wrapper types that prevent accidental mixing of structurally
 * identical values (e.g. `UserId` vs `OrderId`, both `string` at runtime).
 *
 * **Mental model**
 *
 * - **Newtype** — a compile-time wrapper around a **carrier** type (the
 *   underlying primitive or object). At runtime the value is unchanged; the
 *   tag exists only in the type system.
 * - **Key** — a unique string literal that distinguishes one newtype from
 *   another (e.g. `"Label"`, `"UserId"`).
 * - **Carrier** — the underlying type the newtype wraps (e.g. `string`,
 *   `number`).
 * - **Iso** — a lossless two-way conversion between a newtype and its carrier,
 *   created with {@link makeIso}. Use `iso.set(carrier)` to wrap and
 *   `iso.get(newtype)` to unwrap.
 *
 * **Common tasks**
 *
 * - Define a newtype → declare an `interface` extending
 *   `Newtype.Newtype<Key, Carrier>`
 * - Wrap / unwrap values → {@link makeIso} (returns an `Optic.Iso`)
 * - Unwrap only → {@link value}
 * - Lift an `Equivalence` → {@link makeEquivalence}
 * - Lift an `Order` → {@link makeOrder}
 * - Lift a `Combiner` → {@link makeCombiner}
 * - Lift a `Reducer` → {@link makeReducer}
 *
 * **Gotchas**
 *
 * - Newtypes are **purely compile-time**. There is zero runtime overhead;
 *   `value` and `makeIso` use identity casts.
 * - Two newtypes sharing the same key string will be assignable to each other.
 *   Choose unique key strings.
 * - A newtype value is **not** assignable to its carrier type without
 *   explicitly unwrapping via {@link value} or an iso.
 *
 * **Quickstart**
 *
 * **Example** (defining and using a newtype)
 *
 * ```ts
 * import { Newtype } from "effect"
 *
 * // 1. Define a newtype
 * interface Label extends Newtype.Newtype<"Label", string> {}
 *
 * // 2. Create an iso for wrapping/unwrapping
 * const labelIso = Newtype.makeIso<Label>()
 *
 * // 3. Wrap a raw string
 * const myLabel: Label = labelIso.set("hello")
 *
 * // 4. Unwrap back to string
 * const raw: string = labelIso.get(myLabel) // "hello"
 * ```
 *
 * **See also**
 *
 * - {@link Newtype} (the tagged interface)
 * - {@link makeIso} (wrap and unwrap)
 * - {@link value} (unwrap only)
 *
 * @since 4.0.0
 */
export * as Newtype from "./Newtype.ts"

/**
 * The `NonEmptyIterable` module provides a type-level representation of any
 * JavaScript `Iterable` that is known to contain at least one element. A
 * `NonEmptyIterable<A>` can be consumed anywhere an `Iterable<A>` is expected,
 * while also carrying the guarantee that reading the first element is safe.
 *
 * **Mental model**
 *
 * - `NonEmptyIterable<A>` is an `Iterable<A>` branded with a non-empty guarantee
 * - The guarantee is static: values should only be typed this way when construction or validation proves at least one element exists
 * - The iterable can be an array, string, set, map, generator, or any custom iterable
 * - `unprepend` safely separates the first element from an iterator for the remaining elements
 * - Operations that may remove elements, such as filtering, usually return ordinary collections because they can become empty
 *
 * **Common tasks**
 *
 * - Accept inputs that must contain at least one value
 * - Extract a head element and process the remaining iterator with {@link unprepend}
 * - Model APIs such as reductions, comparisons, or aggregation that are undefined for empty inputs
 * - Preserve compatibility with the JavaScript iteration protocol while documenting the stronger invariant
 *
 * **Gotchas**
 *
 * - A type assertion does not make an empty iterable non-empty; only assert after a trusted check or constructor
 * - Iterators are stateful, so calling {@link unprepend} consumes the first yielded value from that iterator
 * - The order of the first element follows the source iterable's iteration order, for example insertion order for `Map` and `Set`
 * - Some transformations preserve non-emptiness, but transformations that can discard elements must account for the empty case
 *
 * **Quickstart**
 *
 * **Example** (Requiring a non-empty iterable)
 *
 * ```ts
 * import { NonEmptyIterable } from "effect"
 *
 * // NonEmptyIterable is a type that represents any iterable with at least one element
 * function processNonEmpty<A>(data: NonEmptyIterable.NonEmptyIterable<A>): A {
 *   // Safe to get the first element - guaranteed to exist
 *   const [first] = NonEmptyIterable.unprepend(data)
 *   return first
 * }
 *
 * // Using Array.make to create non-empty arrays
 * const numbers = Array.make(
 *   1,
 *   2,
 *   3,
 *   4,
 *   5
 * ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const firstNumber = processNonEmpty(numbers) // number
 *
 * // Regular arrays can be asserted as NonEmptyIterable when known to be non-empty
 * const values = [1, 2, 3] as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const firstValue = processNonEmpty(values) // number
 *
 * // Custom iterables that are guaranteed non-empty
 * function* generateNumbers(): NonEmptyIterable.NonEmptyIterable<number> {
 *   yield 1
 *   yield 2
 *   yield 3
 * }
 *
 * const firstGenerated = processNonEmpty(generateNumbers()) // number
 * ```
 *
 * ## Working with Different Iterable Types
 *
 * **Example** (Adapting iterable inputs)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * // Creating non-empty arrays
 * const nonEmptyArray = Array.make(
 *   1,
 *   2,
 *   3
 * ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 *
 * // Working with strings (assert as NonEmptyIterable when known to be non-empty)
 * const nonEmptyString = "hello" as unknown as NonEmptyIterable.NonEmptyIterable<
 *   string
 * >
 * const [firstChar] = NonEmptyIterable.unprepend(nonEmptyString)
 * console.log(firstChar) // "h"
 *
 * // Working with Maps (assert when known to be non-empty)
 * const nonEmptyMap = new Map([
 *   ["key1", "value1"],
 *   ["key2", "value2"]
 * ]) as unknown as NonEmptyIterable.NonEmptyIterable<[string, string]>
 * const [firstEntry] = NonEmptyIterable.unprepend(nonEmptyMap)
 * console.log(firstEntry) // ["key1", "value1"]
 *
 * // Custom generator functions
 * function* fibonacci(): NonEmptyIterable.NonEmptyIterable<number> {
 *   let a = 1, b = 1
 *   yield a
 *   while (true) {
 *     yield b
 *     const next = a + b
 *     a = b
 *     b = next
 *   }
 * }
 *
 * const [firstFib, restFib] = NonEmptyIterable.unprepend(
 *   fibonacci() as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * )
 * console.log(firstFib) // 1
 * ```
 *
 * ## Integration with Effect Arrays
 *
 * **Example** (Processing non-empty iterables with Array)
 *
 * ```ts
 * import { Array, pipe } from "effect"
 * import type { NonEmptyIterable } from "effect"
 *
 * // Many Array functions work with NonEmptyIterable
 * declare const nonEmptyData: NonEmptyIterable.NonEmptyIterable<number>
 *
 * const processData = pipe(
 *   nonEmptyData,
 *   Array.fromIterable,
 *   Array.map((x) => x * 2),
 *   Array.filter((x) => x > 5)
 *   // Result is a regular array since filtering might make it empty
 * )
 *
 * // Safe operations that preserve non-emptiness
 * const doubledData = pipe(
 *   nonEmptyData,
 *   Array.fromIterable,
 *   Array.map((x) => x * 2)
 *   // This would still be non-empty if the source was non-empty
 * )
 * ```
 *
 * @since 2.0.0
 */
export * as NonEmptyIterable from "./NonEmptyIterable.ts"

/**
 * This module provides utility functions and type class instances for working with the `number` type in TypeScript.
 * It includes functions for basic arithmetic operations.
 *
 * @since 2.0.0
 */
export * as Number from "./Number.ts"

/**
 * Composable, immutable accessors for reading and updating nested data
 * structures without mutation.
 *
 * **Mental model**
 *
 * - **Optic** — a first-class reference to a piece inside a larger structure.
 *   Compose optics to reach deeply nested values.
 * - **Iso** — lossless two-way conversion (`get`/`set`) between `S` and `A`.
 *   Extends both {@link Lens} and {@link Prism}.
 * - **Lens** — focuses on exactly one part of `S`. `get` always succeeds;
 *   `replace` needs the original `S` to produce the updated whole.
 * - **Prism** — focuses on a part that may not be present (e.g. a union
 *   variant). `getResult` can fail; `set` builds a new `S` from `A` alone.
 * - **Optional** — the most general optic: both reading and writing can fail.
 * - **Traversal** — focuses on zero or more elements of an array-like
 *   structure. Technically `Optional<S, ReadonlyArray<A>>`.
 * - **Hierarchy** (strongest → weakest):
 *   `Iso > Lens | Prism > Optional`. Composing a weaker optic with any other
 *   produces the weaker kind.
 *
 * **Common tasks**
 *
 * - Start a chain → {@link id} (identity iso)
 * - Drill into a struct key → `.key("name")` / `.optionalKey("name")`
 * - Drill into a key that may not exist → `.at("name")`
 * - Narrow a tagged union → `.tag("MyVariant")`
 * - Narrow by type guard → `.refine(guard)`
 * - Add validation → `.check(Schema.isGreaterThan(0))`
 * - Filter out `undefined` → `.notUndefined()`
 * - Pick/omit struct keys → `.pick(["a","b"])` / `.omit(["c"])`
 * - Traverse array elements → `.forEach(el => el.key("field"))`
 * - Build an iso → {@link makeIso}
 * - Build a lens → {@link makeLens}
 * - Build a prism → {@link makePrism}, {@link fromChecks}
 * - Build an optional → {@link makeOptional}
 * - Focus into `Option.Some` → {@link some}
 * - Focus into `Result.Success`/`Failure` → {@link success}, {@link failure}
 * - Convert record ↔ entries → {@link entries}
 * - Extract all traversal elements → {@link getAll}
 *
 * **Gotchas**
 *
 * - Updates are structurally persistent: only nodes on the path are cloned.
 *   Unrelated branches keep referential identity. However, **no-op updates
 *   may still allocate** a new root — do not rely on reference identity to
 *   detect no-ops.
 * - `replace` silently returns the original `S` when the optic cannot focus
 *   (e.g. wrong tag). Use `replaceResult` for explicit failure.
 * - `modify` also returns the original `S` on focus failure — it never throws.
 * - `.key()` and `.optionalKey()` do not work on union types (compile error).
 * - Only plain objects (`Object.prototype` or `null` prototype) and arrays can
 *   be cloned. Class instances cause a runtime error on `replace`/`modify`.
 *
 * **Quickstart**
 *
 * **Example** (reading and updating nested state)
 *
 * ```ts
 * import { Optic } from "effect"
 *
 * type State = { user: { name: string; age: number } }
 *
 * const _age = Optic.id<State>().key("user").key("age")
 *
 * const s1: State = { user: { name: "Alice", age: 30 } }
 *
 * // Read
 * console.log(_age.get(s1))
 * // Output: 30
 *
 * // Update immutably
 * const s2 = _age.replace(31, s1)
 * console.log(s2)
 * // Output: { user: { name: "Alice", age: 31 } }
 *
 * // Modify with a function
 * const s3 = _age.modify((n) => n + 1)(s1)
 * console.log(s3)
 * // Output: { user: { name: "Alice", age: 31 } }
 *
 * // Referential identity is preserved for unrelated branches
 * console.log(s2.user !== s1.user)
 * // Output: true (on the path)
 * ```
 *
 * **See also**
 *
 * - {@link id} — entry point for optic chains
 * - {@link Lens} / {@link Prism} / {@link Optional} — core optic types
 * - {@link Traversal} / {@link getAll} — multi-focus optics
 * - {@link some} / {@link success} / {@link failure} — built-in prisms
 *
 * @since 4.0.0
 */
export * as Optic from "./Optic.ts"

/**
 * The `Option` module provides a type-safe way to represent values that may or
 * may not exist. An `Option<A>` is either `Some<A>` (containing a value) or
 * `None` (representing absence).
 *
 * **Mental model**
 *
 * - `Option<A>` is a discriminated union: `None | Some<A>`
 * - `None` represents the absence of a value (like `null`/`undefined`, but type-safe)
 * - `Some<A>` wraps a present value of type `A`, accessed via `.value`
 * - `Option` is a monad: chain operations with {@link flatMap}, compose pipelines with `pipe`
 * - All operations are pure and return new `Option` values; the input is never mutated
 * - `Option` is yieldable in `Effect.gen`, producing the inner value or short-circuiting with `NoSuchElementError`
 *
 * **Common tasks**
 *
 * - Create from a value: {@link some}, {@link none}
 * - Create from nullable: {@link fromNullishOr}, {@link fromNullOr}, {@link fromUndefinedOr}
 * - Create from iterable: {@link fromIterable}
 * - Create from Result: {@link getSuccess}, {@link getFailure}
 * - Transform: {@link map}, {@link flatMap}, {@link andThen}
 * - Unwrap: {@link getOrElse}, {@link getOrNull}, {@link getOrUndefined}, {@link getOrThrow}
 * - Pattern match: {@link match}
 * - Fallbacks: {@link orElse}, {@link orElseSome}, {@link firstSomeOf}
 * - Filter: {@link filter}, {@link filterMap}
 * - Combine multiple: {@link all}, {@link zipWith}, {@link product}
 * - Generator syntax: {@link gen}
 * - Do notation: {@link Do}, {@link bind}, {@link let_ let}
 * - Check contents: {@link isSome}, {@link isNone}, {@link contains}, {@link exists}
 *
 * **Gotchas**
 *
 * - `Option.some(null)` is a valid `Some`; use {@link fromNullishOr} to treat `null`/`undefined` as `None`
 * - {@link filterMap} uses a `Filter` callback that returns `Result`
 * - {@link getOrThrow} throws a generic `Error`; prefer {@link getOrThrowWith} for custom errors
 * - `None` is a singleton; compare with {@link isNone}, not `===`
 * - When yielded in `Effect.gen`, a `None` becomes a `NoSuchElementError` defect
 *
 * **Quickstart**
 *
 * **Example** (Working with optional values)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const name = Option.some("Alice")
 * const age = Option.none<number>()
 *
 * // Transform
 * const upper = Option.map(name, (s) => s.toUpperCase())
 *
 * // Unwrap with fallback
 * console.log(Option.getOrElse(upper, () => "unknown"))
 * // Output: "ALICE"
 *
 * console.log(Option.getOrElse(age, () => 0))
 * // Output: 0
 *
 * // Combine multiple options
 * const both = Option.all({ name, age })
 * console.log(Option.isNone(both))
 * // Output: true
 * ```
 *
 * **See also**
 *
 * - {@link some} / {@link none} for creating values
 * - {@link map} / {@link flatMap} for transforming values
 * - {@link match} for pattern matching
 * - {@link gen} for generator-based syntax
 *
 * @since 2.0.0
 */
export * as Option from "./Option.ts"

/**
 * This module provides the `Order` type class for defining total orderings on types.
 * An `Order` is a comparison function that returns `-1` (less than), `0` (equal), or `1` (greater than).
 *
 * Mental model:
 * - An `Order<A>` is a pure function `(a: A, b: A) => Ordering` that compares two values
 * - The result `-1` means the first value is less than the second
 * - The result `0` means the values are equal according to this ordering
 * - The result `1` means the first value is greater than the second
 * - Orders must satisfy total ordering laws: totality (either `x <= y` or `y <= x`), antisymmetry (if `x <= y` and `y <= x` then `x == y`), and transitivity (if `x <= y` and `y <= z` then `x <= z`)
 * - Orders can be composed using {@link combine} and {@link combineAll} to create multi-criteria comparisons
 * - Orders can be transformed using {@link mapInput} to compare values by extracting a comparable property
 * - Built-in orders exist for common types: {@link Number}, {@link String}, {@link Boolean}, {@link BigInt}, {@link Date}
 *
 * Common tasks:
 * - Creating custom orders → {@link make}
 * - Using built-in orders → {@link Number}, {@link String}, {@link Boolean}, {@link BigInt}, {@link Date}
 * - Combining multiple orders → {@link combine}, {@link combineAll}
 * - Transforming orders → {@link mapInput}
 * - Comparing values → {@link isLessThan}, {@link isGreaterThan}, {@link isLessThanOrEqualTo}, {@link isGreaterThanOrEqualTo}
 * - Finding min/max → {@link min}, {@link max}
 * - Clamping values → {@link clamp}, {@link isBetween}
 * - Ordering collections → {@link Array}, {@link Tuple}, {@link Struct}
 *
 * Gotchas:
 * - `Order.Number` treats all `NaN` values as equal and less than any other number
 * - `Order.make` uses reference equality (`===`) as a shortcut: if `self === that`, it returns `0` without calling the comparison function
 * - `Order.Array` compares arrays element-by-element, then by length if all elements are equal; `Order.all` only compares elements up to the shorter array's length
 * - `Order.Tuple` requires a fixed-length tuple with matching order types; `Order.Array` works with variable-length arrays
 * - `Order.min` and `Order.max` return the first argument when values are equal
 *
 * Quickstart:
 *
 * **Example** (Basic Usage)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const result = Order.Number(5, 10)
 * console.log(result) // -1 (5 is less than 10)
 *
 * const isLessThan = Order.isLessThan(Order.Number)(5, 10)
 * console.log(isLessThan) // true
 * ```
 *
 * See also:
 * - {@link Ordering} - The result type of comparisons
 * - {@link Reducer} - For combining orders in collections
 *
 * @since 2.0.0
 */
export * as Order from "./Order.ts"

/**
 * The `Ordering` module provides the standard representation for the result of
 * comparing two values. An `Ordering` is one of three numeric literals: `-1`
 * when the first value is less than the second, `0` when both values compare as
 * equal, and `1` when the first value is greater than the second.
 *
 * **Mental model**
 *
 * - `Ordering` describes the relationship between two compared values, not the
 *   values themselves
 * - Negative means "less than", zero means "equal", and positive means "greater
 *   than"
 * - Unlike JavaScript comparators, this type is normalized to exactly `-1`, `0`,
 *   or `1`
 * - `0` is neutral when combining comparisons; the first non-zero ordering
 *   determines the result
 *
 * **Common tasks**
 *
 * - Interpret a comparison result with {@link match}
 * - Reverse ascending and descending order with {@link reverse}
 * - Combine multiple comparison criteria with {@link Reducer}
 * - Build custom comparison functions for sorting, ordered collections, and
 *   domain-specific ordering rules
 *
 * **Gotchas**
 *
 * - Do not cast arbitrary comparator results such as `a.localeCompare(b)`
 *   directly unless they have been normalized to `-1`, `0`, or `1`
 * - In comparator-style APIs, `-1` means the left value should come before the
 *   right value, while `1` means it should come after
 * - Reversing an `Ordering` swaps `-1` and `1`, but leaves `0` unchanged
 *
 * @since 2.0.0
 */
export * as Ordering from "./Ordering.ts"

/**
 * The `PartitionedSemaphore` module provides a semaphore for limiting
 * concurrency across a shared permit pool while keeping waiters grouped by
 * partition key. A `PartitionedSemaphore<K>` is useful when many independent
 * groups of work compete for the same bounded resource and each group should
 * make progress without one busy group monopolizing released permits.
 *
 * **Mental model**
 *
 * - The semaphore has a fixed shared capacity measured in permits
 * - Work acquires permits with a partition key of type `K`
 * - Waiting acquisitions are tracked per partition
 * - Released permits are assigned to waiting partitions in round-robin order
 * - `withPermit` and `withPermits` acquire permits around an effect and
 *   release them when the effect exits, fails, or is interrupted
 *
 * **Common tasks**
 *
 * - Create a semaphore: {@link make}, {@link makeUnsafe}
 * - Inspect capacity and availability: {@link capacity}, {@link available}
 * - Acquire and release manually: {@link take}, {@link release}
 * - Limit a single operation per partition: {@link withPermit}
 * - Limit weighted work per partition: {@link withPermits}
 * - Run only when permits are immediately available:
 *   {@link withPermitsIfAvailable}
 *
 * **Gotchas**
 *
 * - `withPermitsIfAvailable` does not use a partition key; it only succeeds
 *   when the shared pool has enough permits immediately
 * - Acquiring more permits than the semaphore capacity never completes
 * - Requests for zero or negative permits complete without acquiring anything
 * - Non-finite capacities create an unbounded semaphore whose acquire and
 *   release operations complete immediately
 *
 * @since 4.0.0
 */
export * as PartitionedSemaphore from "./PartitionedSemaphore.ts"

/**
 * The `Path` module provides a platform path service for manipulating file
 * system paths through Effect's environment. It models path operations as a
 * replaceable service so programs can depend on path behavior without directly
 * coupling to a particular runtime implementation.
 *
 * **Mental model**
 *
 * - `Path.Path` is a `Context.Service` tag used to access the current path implementation
 * - The service offers familiar path operations such as joining, resolving, parsing, and formatting
 * - Most operations are pure string transformations and follow POSIX-style path semantics
 * - File URL conversions return `Effect`s because invalid paths or URLs can fail with `BadArgument`
 * - Custom implementations can be provided with `Layer.succeed` for alternate platforms or tests
 *
 * **Common tasks**
 *
 * - Combine path segments with `join` or turn segments into an absolute path with `resolve`
 * - Normalize `.` and `..` segments with `normalize`
 * - Inspect paths with `basename`, `dirname`, `extname`, and `isAbsolute`
 * - Convert between structured path parts and strings with `parse` and `format`
 * - Compute relative paths with `relative`
 * - Convert between file paths and `file:` URLs with `toFileUrl` and `fromFileUrl`
 *
 * **Gotchas**
 *
 * - Path strings are not checked against the file system; these operations only manipulate syntax
 * - `resolve` may consult the host current working directory when no absolute segment is supplied
 * - `fromFileUrl` only accepts valid `file:` URLs and rejects encoded path separators
 * - Use the service from the environment when writing portable Effect code instead of importing
 *   host-specific path APIs directly
 *
 * @since 4.0.0
 */
export * as Path from "./Path.ts"

/**
 * The `Pipeable` module defines the shared interface and implementation helpers
 * for values that support Effect-style method chaining with `.pipe(...)`.
 *
 * A `Pipeable` value can pass itself through a sequence of unary functions from
 * left to right, so code can be written as `value.pipe(f, g, h)` instead of
 * deeply nesting calls. This is the method form used by many Effect data types
 * to compose transformations, validations, and effectful operations while
 * keeping the original value as the starting point of the pipeline.
 *
 * **Common tasks**
 *
 * - Type values that expose a `.pipe(...)` method with the {@link Pipeable} interface
 * - Implement a custom `.pipe(...)` method with {@link pipeArguments}
 * - Reuse the standard implementation through {@link Prototype}, {@link Class}, or {@link Mixin}
 *
 * **Gotchas**
 *
 * - Each function receives the result of the previous function, not the original value
 * - The overloads preserve precise types for long pipelines, but very long chains may be easier to read when split
 *
 * @since 2.0.0
 */
export * as Pipeable from "./Pipeable.ts"

/**
 * The `PlatformError` module defines the normalized error model used by
 * platform APIs when adapting host operations into Effect programs. It gives
 * callers a stable `PlatformError` wrapper whose `reason` is either a
 * `BadArgument`, for invalid inputs rejected before an operation runs, or a
 * `SystemError`, for failures reported by the host platform or operating
 * system.
 *
 * Use this module when implementing or consuming platform services such as
 * file systems, terminal access, sockets, or other environment-specific APIs.
 * `SystemError` intentionally groups many low-level failures into a small set
 * of portable tags like `NotFound`, `PermissionDenied`, and `TimedOut`, while
 * still preserving operation details such as the module, method, syscall, path
 * or descriptor, description, and original cause when available.
 *
 * **Common tasks**
 *
 * - Create platform failures from system operations with {@link systemError}
 * - Report rejected caller input with {@link badArgument}
 * - Inspect the underlying reason via {@link PlatformError.reason}
 * - Match normalized system failures with {@link SystemErrorTag}
 *
 * **Gotchas**
 *
 * - `PlatformError` is a wrapper; inspect `reason` to distinguish
 *   `BadArgument` from `SystemError`
 * - `SystemErrorTag` values are normalized categories, not necessarily raw
 *   platform error codes
 * - The original cause is preserved when provided, but portable handling
 *   should rely on the normalized fields
 *
 * @since 4.0.0
 */
export * as PlatformError from "./PlatformError.ts"

/**
 * The `Pool` module provides scoped resource pools for sharing expensive or
 * limited resources across fibers. A `Pool<A, E>` manages values of type `A`
 * acquired by an effect that may fail with `E`, automatically releasing all
 * allocated resources when the surrounding `Scope` closes.
 *
 * **Mental model**
 *
 * - A pool owns a bounded set of acquired items and hands them out with {@link get}
 * - Each checkout is scoped; leaving the scope returns the item to the pool
 * - `concurrency` controls how many fibers may use the same item at once
 * - `targetUtilization` controls when the pool grows between its minimum and maximum sizes
 * - {@link invalidate} removes a specific item so it can be replaced lazily
 *
 * **Common tasks**
 *
 * - Create a fixed-size pool with {@link make}
 * - Create an elastic pool with time-to-live reclamation using {@link makeWithTTL}
 * - Implement custom resizing and reclamation behavior with {@link makeWithStrategy}
 * - Borrow resources safely in scoped effects with {@link get}
 *
 * **Gotchas**
 *
 * - Pool construction and item checkout require `Scope`; closing the scope shuts
 *   down the pool or returns the borrowed item
 * - Failed acquisitions are represented by the `get` effect failing with the
 *   acquisition error, and retrying `get` can retry acquisition
 * - Resource finalization order during shutdown is unspecified
 *
 * @since 2.0.0
 */
export * as Pool from "./Pool.ts"

/**
 * Predicate and Refinement helpers for runtime checks, filtering, and type narrowing.
 * This module provides small, pure functions you can combine to decide whether a
 * value matches a condition and, when using refinements, narrow TypeScript types.
 *
 * Mental model:
 * - A `Predicate<A>` is just `(a: A) => boolean`.
 * - A `Refinement<A, B>` is a predicate that narrows `A` to `B` when true.
 * - Guards like `isString` are predicates/refinements for common runtime types.
 * - Combinators like `and`/`or` build new predicates from existing ones.
 * - `Tuple` and `Struct` lift element/property predicates to compound values.
 *
 * Common tasks:
 * - Reuse an existing predicate on a different input shape -> {@link mapInput}
 * - Combine checks -> {@link and}, {@link or}, {@link not}, {@link xor}
 * - Build tuple/object checks -> {@link Tuple}, {@link Struct}
 * - Narrow `unknown` to a concrete type -> {@link Refinement}, {@link compose}
 * - Check runtime types -> {@link isString}, {@link isNumber}, {@link isObject}
 *
 * Gotchas:
 * - `isTruthy` uses JavaScript truthiness; `0`, "", and `false` are false.
 * - `isObject` excludes arrays; use {@link isObjectOrArray} for both.
 * - `isIterable` treats strings as iterable.
 * - `isPromise`/`isPromiseLike` are structural checks (then/catch), not `instanceof`.
 * - `isTupleOf` and `isTupleOfAtLeast` only check length, not element types.
 *
 * **Example** (Filter by a predicate)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isPositive = (n: number) => n > 0
 * const data = [2, -1, 3]
 *
 * console.log(data.filter(isPositive))
 * ```
 *
 * See also: {@link Predicate}, {@link Refinement}, {@link and}, {@link or}, {@link mapInput}
 *
 * @since 2.0.0
 */
export * as Predicate from "./Predicate.ts"

/**
 * This module provides functionality for working with primary keys.
 * A `PrimaryKey` is a simple interface that represents a unique identifier
 * that can be converted to a string representation.
 *
 * Primary keys are useful for creating unique identifiers for objects,
 * database records, cache keys, or any scenario where you need a
 * string-based unique identifier.
 *
 * @since 2.0.0
 */
export * as PrimaryKey from "./PrimaryKey.ts"

/**
 * This module provides utilities for working with publish-subscribe (PubSub) systems.
 *
 * A PubSub is an asynchronous message hub where publishers can publish messages and subscribers
 * can subscribe to receive those messages. PubSub supports various backpressure strategies,
 * message replay, and concurrent access from multiple producers and consumers.
 *
 * **Example** (Creating and using a PubSub)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Publisher
 *     yield* PubSub.publish(pubsub, "Hello")
 *     yield* PubSub.publish(pubsub, "World")
 *
 *     // Subscriber
 *     const message1 = yield* PubSub.take(subscription)
 *     const message2 = yield* PubSub.take(subscription)
 *     console.log(message1, message2) // "Hello", "World"
 *   }))
 * })
 * ```
 *
 * @since 2.0.0
 */
export * as PubSub from "./PubSub.ts"

/**
 * The `Pull` module provides the low-level pull-step abstraction used by
 * stream-like consumers. A `Pull<A, E, Done, R>` is an `Effect` that can
 * produce one value of type `A`, fail with an ordinary error `E`, or signal
 * end-of-input with a `Cause.Done<Done>` value.
 *
 * **Mental model**
 *
 * - `Pull` is an `Effect` with a distinguished completion signal in the error channel
 * - ordinary failures and completion are both represented by `Cause`, but can be separated with the helpers in this module
 * - the `Done` value can carry leftover state or a final value needed by a downstream consumer
 * - `Pull` is useful when repeatedly evaluating an effect until it either produces values, fails, or reports that no more input is available
 *
 * **Common tasks**
 *
 * - Extract type parameters from a pull: {@link Success}, {@link Error}, {@link Leftover}, {@link Services}
 * - Detect and filter completion: {@link isDoneCause}, {@link filterDone}, {@link filterNoDone}
 * - Recover from completion while preserving ordinary failures: {@link catchDone}
 * - Convert done causes to successful exits: {@link doneExitFromCause}
 * - Handle all outcomes explicitly: {@link matchEffect}
 *
 * **Gotchas**
 *
 * - `Cause.Done` is not an ordinary failure; use this module's helpers before treating a pull failure as an error
 * - `Done` lives in the error channel, so generic `Effect` error handling can catch it unless you filter it deliberately
 * - `Pull` is a low-level primitive; most user-facing stream workflows should prefer higher-level stream APIs when available
 *
 * @since 4.0.0
 */
export * as Pull from "./Pull.ts"

/**
 * The `Queue` module provides asynchronous queues for communicating between
 * fibers. A `Queue<A, E>` can receive values of type `A`, deliver them to
 * consumers in order, and eventually complete or fail with an error of type
 * `E`.
 *
 * **Mental model**
 *
 * - A queue is a fiber-aware channel with one write side ({@link Enqueue}) and
 *   one read side ({@link Dequeue})
 * - Producers add values with {@link offer} or {@link offerAll}; consumers
 *   remove values with {@link take}, {@link takeN}, {@link takeBetween}, or
 *   {@link takeAll}
 * - Bounded queues use an overflow strategy: {@link bounded} suspends
 *   producers, {@link dropping} rejects new values, and {@link sliding} drops
 *   old values
 * - Queues can be completed with {@link end}, failed with {@link fail} or
 *   {@link failCause}, interrupted with {@link interrupt}, and shut down with
 *   {@link shutdown}
 * - Operations are expressed as `Effect` values so waiting producers and
 *   consumers compose with interruption, scheduling, and structured
 *   concurrency
 *
 * **Common tasks**
 *
 * - Create queues: {@link make}, {@link bounded}, {@link dropping},
 *   {@link sliding}, {@link unbounded}
 * - Restrict capabilities: {@link asEnqueue}, {@link asDequeue}
 * - Produce values: {@link offer}, {@link offerAll}
 * - Consume values: {@link take}, {@link takeN}, {@link takeBetween},
 *   {@link takeAll}, {@link poll}, {@link peek}
 * - Drain or reset buffered values: {@link collect}, {@link clear}
 * - Signal lifecycle: {@link end}, {@link fail}, {@link failCause},
 *   {@link interrupt}, {@link shutdown}
 * - Inspect state: {@link size}, {@link isFull}
 *
 * **Gotchas**
 *
 * - `take` waits when the queue is empty; use {@link poll} when absence should
 *   be represented as `Option.None`
 * - `dropping` and `sliding` queues can lose values by design; use
 *   {@link bounded} when every offered value must be preserved
 * - Completion and failure are observed by consumers through the queue's error
 *   channel, so include `Cause.Done` in the error type when using {@link end}
 * - The `Unsafe` variants are synchronous, low-level operations; prefer the
 *   effectful APIs in application code
 *
 * **See also**
 *
 * - {@link Enqueue} for write-only queue handles
 * - {@link Dequeue} for read-only queue handles
 * - {@link Pull} for stream-style completion errors
 *
 * @since 3.8.0
 */
export * as Queue from "./Queue.ts"

/**
 * The `Random` module provides a service for generating pseudo-random numbers
 * in Effect programs. It offers a testable and composable way to work with
 * randomness, supporting integers, floating-point numbers, and range-based
 * generation.
 *
 * The default `Random` service is not cryptographically secure. Do not use it
 * for secrets, tokens, UUIDs, session identifiers, or other security-sensitive
 * values. For cryptographically secure random generation, replace the service
 * with a cryptographically secure implementation such as the platform `Crypto`
 * service. `Random.withSeed` also replaces the service, but predictable seeds
 * remain deterministic and must not be treated as cryptographically secure.
 *
 * **Example** (Generating random values)
 *
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const randomFloat = yield* Random.next
 *   console.log("Random float:", randomFloat)
 *
 *   const randomInt = yield* Random.nextInt
 *   console.log("Random integer:", randomInt)
 *
 *   const diceRoll = yield* Random.nextIntBetween(1, 6)
 *   console.log("Dice roll:", diceRoll)
 * })
 * ```
 *
 * @since 4.0.0
 */
export * as Random from "./Random.ts"

/**
 * The `RcMap` module provides a scoped, reference-counted map for sharing
 * resources by key. It is useful when many fibers may request the same
 * resource, such as a connection, client, session, or cached handle, and the
 * resource should be acquired once, reused while it has active references, and
 * released automatically when it is no longer needed.
 *
 * Each key is resolved with a user-provided lookup effect on first access via
 * {@link get}. Further accesses to the same key share the in-flight or acquired
 * resource and increment its reference count for the caller's current
 * `Scope`. When those scopes close, references are released; resources can be
 * closed immediately, kept alive for an idle time-to-live, invalidated
 * explicitly, or bounded by a maximum capacity.
 *
 * `RcMap` is designed for Effect resource lifecycles rather than general
 * mutable caching. The map itself is scoped, lookups require a `Scope`, and
 * complex keys should provide `Equal` / `Hash` behavior when they need
 * value-based lookup semantics.
 *
 * @since 3.5.0
 */
export * as RcMap from "./RcMap.ts"

/**
 * The `RcRef` module provides reference-counted access to a shared resource
 * whose lifecycle is managed by `Scope`. An `RcRef<A, E>` lazily acquires its
 * resource the first time it is requested, shares that resource across active
 * users, and releases it when the final scope holding a reference closes.
 *
 * Use `RcRef` when several scoped operations should reuse the same expensive
 * or stateful resource, such as a connection, client, cache, or worker, without
 * making each operation acquire and release its own copy. `make` defines how
 * the resource is acquired, `get` borrows the current resource for the active
 * scope, and `invalidate` forces a future `get` to acquire a fresh resource.
 *
 * The resource is tied to scopes rather than ordinary object reachability:
 * every `get` must run with a `Scope`, and the reference count is decremented
 * when that scope closes. If `idleTimeToLive` is configured, a resource whose
 * reference count reaches zero can remain cached briefly before release.
 *
 * @since 3.5.0
 */
export * as RcRef from "./RcRef.ts"

/**
 * This module provides utility functions for working with records in TypeScript.
 *
 * @since 2.0.0
 */
export * as Record from "./Record.ts"

/**
 * Context-aware redaction for sensitive values.
 *
 * The `Redactable` module provides a protocol for objects that need to present
 * alternative representations of themselves depending on the runtime context.
 * Typical use cases include masking secrets, tokens, or personal data in logs, traces,
 * and serialized output.
 *
 * ## Mental model
 *
 * - **Redactable** - an object that implements `[symbolRedactable]`, a method
 *   that receives the current `Context` and returns a replacement value.
 * - **symbolRedactable** - the well-known `Symbol` key that marks an object as
 *   redactable.
 * - **redact** - the primary entry point: pass any value and get back either its
 *   redacted form (if it is `Redactable`) or the original value unchanged.
 * - **getRedacted** - lower-level helper that calls `[symbolRedactable]` directly
 *   on a value already known to be `Redactable`.
 * - The `Context` passed to `[symbolRedactable]` comes from the current fiber.
 *   If no fiber is active, an empty `Context` is used.
 *
 * ## Common tasks
 *
 * - **Make a value redactable**: implement the {@link Redactable} interface by
 *   adding a `[symbolRedactable]` method.
 * - **Redact an unknown value**: call {@link redact} - it returns the original
 *   value when it is not redactable.
 * - **Check if a value is redactable**: use {@link isRedactable}.
 * - **Get the redacted form of a known `Redactable`**: use {@link getRedacted}.
 *
 * ## Gotchas
 *
 * - `[symbolRedactable]` receives the fiber's `Context` as its argument.
 * - Outside of an Effect runtime (no current fiber), `getRedacted` still works
 *   but passes an empty `Context`, so service lookups will not find anything.
 * - `redact` is not recursive: if a redactable object contains nested
 *   redactable values, only the outermost redaction is applied.
 *
 * ## Quickstart
 *
 * **Example** (Masking an API key)
 *
 * ```ts
 * import { Context, Redactable } from "effect"
 *
 * class ApiKey {
 *   constructor(readonly raw: string) {}
 *
 *   [Redactable.symbolRedactable](_ctx: Context.Context<never>) {
 *     return this.raw.slice(0, 4) + "..."
 *   }
 * }
 *
 * const key = new ApiKey("sk-1234567890abcdef")
 *
 * console.log(Redactable.isRedactable(key))  // true
 * console.log(Redactable.redact(key))         // "sk-1..."
 * console.log(Redactable.redact("plain"))     // "plain"
 * ```
 *
 * ## See also
 *
 * - {@link Redactable} - the interface to implement
 * - {@link symbolRedactable} - the symbol key
 * - {@link redact} - the main redaction entry point
 *
 * @since 4.0.0
 */
export * as Redactable from "./Redactable.ts"

/**
 * The Redacted module provides functionality for handling sensitive information
 * securely within your application. By using the `Redacted` data type, you can
 * ensure that sensitive values are not accidentally exposed in logs or error
 * messages.
 *
 * @since 3.3.0
 */
export * as Redacted from "./Redacted.ts"

/**
 * A module for reducing collections of values into a single result.
 *
 * A `Reducer<A>` extends {@link Combiner.Combiner} by adding an
 * `initialValue` (identity element) and a `combineAll` method that folds an
 * entire collection. Think `Array.prototype.reduce`, but packaged as a
 * reusable, composable value.
 *
 * ## Mental model
 *
 * - **Reducer** – a {@link Combiner.Combiner} plus an `initialValue` and a
 *   `combineAll` method.
 * - **initialValue** – the neutral/identity element. Combining any value with
 *   `initialValue` should return the original value unchanged (e.g. `0` for
 *   addition, `""` for string concatenation).
 * - **combineAll** – folds an `Iterable<A>` starting from `initialValue`.
 *   When omitted from {@link make}, a default left-to-right fold is used.
 * - **Purity** – all reducers produced by this module are pure; they never
 *   mutate their arguments.
 * - **Composability** – reducers can be lifted into `Option`, `Struct`,
 *   `Tuple`, `Record`, and other container types via helpers in those modules.
 * - **Subtype of Combiner** – every `Reducer` is also a valid
 *   `Combiner`, so you can pass a `Reducer` anywhere a `Combiner` is
 *   expected.
 *
 * ## Common tasks
 *
 * - Create a reducer from a combine function and initial value → {@link make}
 * - Swap argument order → {@link flip}
 * - Combine two values without an initial value → use {@link Combiner.Combiner}
 *   instead
 *
 * ## Gotchas
 *
 * - `combineAll` on an empty iterable returns `initialValue`, not an error.
 * - The default `combineAll` folds left-to-right. If your `combine` is not
 *   associative, order matters. Pass a custom `combineAll` to {@link make} if
 *   you need different traversal or short-circuiting.
 * - A `Reducer` is also a valid `Combiner` — but a `Combiner` is *not* a
 *   `Reducer` (it lacks `initialValue`).
 *
 * ## Quickstart
 *
 * **Example** (summing a list of numbers)
 *
 * ```ts
 * import { Reducer } from "effect"
 *
 * const Sum = Reducer.make<number>((a, b) => a + b, 0)
 *
 * console.log(Sum.combine(3, 4))
 * // Output: 7
 *
 * console.log(Sum.combineAll([1, 2, 3, 4]))
 * // Output: 10
 *
 * console.log(Sum.combineAll([]))
 * // Output: 0
 * ```
 *
 * ## See also
 *
 * - {@link make} – the primary constructor
 * - {@link Reducer} – the core interface
 * - {@link Combiner.Combiner} – the parent interface (no `initialValue`)
 *
 * @since 4.0.0
 */
export * as Reducer from "./Reducer.ts"

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
export * as Ref from "./Ref.ts"

/**
 * This module provides a collection of reference implementations for commonly used
 * Effect runtime configuration values. These references allow you to access and
 * modify runtime behavior such as concurrency limits, scheduling policies,
 * tracing configuration, and logging settings.
 *
 * References are special service instances that can be dynamically updated
 * during runtime, making them ideal for configuration that may need to change
 * based on application state or external conditions.
 *
 * @since 4.0.0
 */
export * as References from "./References.ts"

/**
 * This module provides utility functions for working with RegExp in TypeScript.
 *
 * @since 2.0.0
 */
export * as RegExp from "./RegExp.ts"

/**
 * The `Request` module provides a way to model requests to external data sources
 * in a functional and composable manner. Requests represent descriptions of
 * operations that can be batched, cached, and executed efficiently.
 *
 * A `Request<A, E, R>` represents a request that:
 * - Yields a value of type `A` on success
 * - Can fail with an error of type `E`
 * - Requires services of type `R`
 *
 * Requests are primarily used with RequestResolver to implement efficient
 * data fetching patterns, including automatic batching and caching.
 *
 * @since 2.0.0
 */
export * as Request from "./Request.ts"

/**
 * The `RequestResolver` module provides the data-loading side of
 * `Effect.request`. A `Request` describes what a fiber needs, while a
 * `RequestResolver` describes how to collect, batch, execute, cache, trace,
 * and complete those requests.
 *
 * **Mental model**
 *
 * - A resolver receives one or more `Request.Entry` values and must complete
 *   each entry with either a success or failure
 * - Concurrent requests made with the same resolver can be gathered into a
 *   batch before the resolver is run
 * - Batch keys split pending requests into independent groups, which is useful
 *   when different backends, tenants, or query shapes must be resolved
 *   separately
 * - Delays and `batchN` tune how long requests are collected and how large
 *   each batch may become
 * - Resolvers can be wrapped with tracing, in-memory caching, cache services,
 *   and persistence without changing the request type
 *
 * **Common tasks**
 *
 * - Create a resolver from batch logic: {@link make}
 * - Create grouped batch logic: {@link makeGrouped} or {@link grouped}
 * - Create a resolver from pure logic: {@link fromFunction} or
 *   {@link fromFunctionBatched}
 * - Create a resolver from effectful logic: {@link fromEffect} or
 *   {@link fromEffectTagged}
 * - Control batching: {@link setDelay}, {@link setDelayEffect},
 *   {@link batchN}
 * - Add operational behavior: {@link around}, {@link race}, {@link withSpan}
 * - Reuse results: {@link withCache}, {@link asCache}, {@link persisted}
 *
 * **Gotchas**
 *
 * - Every entry passed to a resolver must be completed; leaving an entry
 *   incomplete causes the waiting request to fail
 * - Batched result collections must line up with the input entries in order
 *   and length when using the batched helper constructors
 * - Grouping controls which requests share a resolver run; choose stable keys
 *   for requests that can safely be handled together
 * - Caching and persistence depend on request identity and the request's
 *   equality semantics, so model request values deliberately when cached
 *
 * @since 2.0.0
 */
export * as RequestResolver from "./RequestResolver.ts"

/**
 * The `Resource` module provides refreshable, scoped values. A
 * `Resource<A, E>` stores the latest successful or failed acquisition result and
 * can be read with {@link get}, refreshed manually with {@link refresh}, or
 * refreshed automatically with {@link auto}.
 *
 * **Mental model**
 *
 * - A `Resource` wraps an acquisition `Effect` whose result is kept in a
 *   `ScopedRef`
 * - Each refresh re-runs acquisition and replaces the stored `Exit`
 * - Replacing the stored value releases resources associated with the previous
 *   scoped value
 * - Reading a resource returns the current acquired value or fails with the
 *   current acquisition error
 *
 * **Common tasks**
 *
 * - Create a manually refreshed resource with {@link manual}
 * - Create a schedule-driven resource with {@link auto}
 * - Read the current value with {@link get}
 * - Force a reload with {@link refresh}
 * - Check whether an unknown value is a resource with {@link isResource}
 *
 * **Gotchas**
 *
 * - Creating a resource requires a `Scope`; when the scope closes, scoped
 *   values held by the resource are released
 * - Failed acquisitions are stored too, so subsequent {@link get} calls fail
 *   until a refresh succeeds
 * - Automatic refreshes run in the resource scope and stop when that scope is
 *   closed
 *
 * @since 2.0.0
 */
export * as Resource from "./Resource.ts"

/**
 * A synchronous, pure type for representing computations that can succeed
 * (`Success<A>`) or fail (`Failure<E>`). Unlike `Effect`, `Result` is
 * evaluated eagerly and carries no side effects.
 *
 * **Mental model**
 *
 * - `Result<A, E>` is a discriminated union: `Success<A, E> | Failure<A, E>`
 * - `Success` wraps a value of type `A`, accessed via `.success`
 * - `Failure` wraps an error of type `E`, accessed via `.failure`
 * - `Result` is a monad: chain operations with {@link flatMap}, compose pipelines with `pipe`
 * - All operations are pure and return new `Result` values; the input is never mutated
 * - `Result` is yieldable in `Effect.gen`, producing the inner value or short-circuiting on failure
 *
 * **Common tasks**
 *
 * - Create from a value: {@link succeed}, {@link fail}
 * - Create from nullable: {@link fromNullishOr}
 * - Create from Option: {@link fromOption}
 * - Create from throwing code: {@link try_ try}
 * - Create from predicate: {@link liftPredicate}
 * - Transform: {@link map}, {@link mapError}, {@link mapBoth}
 * - Unwrap: {@link getOrElse}, {@link getOrNull}, {@link getOrUndefined}, {@link getOrThrow}
 * - Pattern match: {@link match}
 * - Sequence: {@link flatMap}, {@link andThen}, {@link all}
 * - Recover: {@link orElse}
 * - Filter: {@link filterOrFail}
 * - Convert to Option: {@link getSuccess}, {@link getFailure}
 * - Generator syntax: {@link gen}
 * - Do notation: {@link Do}, {@link bind}, {@link let_ let}
 * - Check variant: {@link isResult}, {@link isSuccess}, {@link isFailure}
 *
 * **Gotchas**
 *
 * - `E` defaults to `never`, so `Result<number>` means a result that cannot fail
 * - {@link andThen} accepts a `Result`, a function returning a `Result`, a plain value, or a function returning a plain value; {@link flatMap} only accepts a function returning a `Result`
 * - {@link all} short-circuits on the first `Failure` and returns it; later elements are not inspected
 * - {@link getOrThrow} throws the raw failure value `E`; use {@link getOrThrowWith} for custom error objects
 * - {@link tap} runs a side-effect but does not change the result; its return value is ignored
 *
 * **Quickstart**
 *
 * **Example** (Parsing and validating with Result)
 *
 * ```ts
 * import { Result } from "effect"
 *
 * const parse = (input: string): Result.Result<number, string> =>
 *   isNaN(Number(input))
 *     ? Result.fail("not a number")
 *     : Result.succeed(Number(input))
 *
 * const ensurePositive = (n: number): Result.Result<number, string> =>
 *   n > 0 ? Result.succeed(n) : Result.fail("not positive")
 *
 * const result = Result.flatMap(parse("42"), ensurePositive)
 *
 * console.log(Result.getOrElse(result, (err) => `Error: ${err}`))
 * // Output: 42
 * ```
 *
 * **See also**
 *
 * - {@link succeed} / {@link fail} to create values
 * - {@link match} to fold both branches
 * - {@link gen} for generator-based composition
 *
 * @since 4.0.0
 */
export * as Result from "./Result.ts"

/**
 * This module provides utilities for running Effect programs and managing their execution lifecycle.
 *
 * The Runtime module contains functions for creating main program runners that handle process
 * teardown, error reporting, and exit code management. These utilities are particularly useful
 * for creating CLI applications and server processes that need to manage their lifecycle properly.
 *
 * **Example** (Creating a main runner)
 *
 * ```ts
 * import { Effect, Fiber, Runtime } from "effect"
 *
 * // Create a main runner for Node.js
 * const runMain = Runtime.makeRunMain((options) => {
 *   process.on("SIGINT", () => Effect.runFork(Fiber.interrupt(options.fiber)))
 *   process.on("SIGTERM", () => Effect.runFork(Fiber.interrupt(options.fiber)))
 *
 *   options.fiber.addObserver((exit) => {
 *     options.teardown(exit, (code) => process.exit(code))
 *   })
 * })
 *
 * // Use the runner
 * const program = Effect.log("Hello, World!")
 * runMain(program)
 * ```
 *
 * @since 4.0.0
 */
export * as Runtime from "./Runtime.ts"

/**
 * This module provides utilities for creating and composing schedules for retrying operations,
 * repeating effects, and implementing various timing strategies.
 *
 * A Schedule is a function that takes an input and returns a decision whether to continue or halt,
 * along with a delay duration. Schedules can be combined, transformed, and used to implement
 * sophisticated retry and repetition logic.
 *
 * **Example** (Retrying and repeating effects)
 *
 * ```ts
 * import { Effect, Schedule } from "effect"
 *
 * // Retry with exponential backoff
 * const retryPolicy = Schedule.exponential("100 millis", 2.0)
 *   .pipe(Schedule.both(Schedule.recurs(3)))
 *
 * const program = Effect.gen(function*() {
 *   // This will retry up to 3 times with exponential backoff
 *   const result = yield* Effect.retry(
 *     Effect.fail("Network error"),
 *     retryPolicy
 *   )
 * })
 *
 * // Repeat on a fixed schedule
 * const heartbeat = Effect.log("heartbeat")
 *   .pipe(Effect.repeat(Schedule.spaced("30 seconds")))
 * ```
 *
 * @since 2.0.0
 */
export * as Schedule from "./Schedule.ts"

/**
 * The `Scheduler` module defines the runtime scheduling services used by
 * Effect fibers. A scheduler decides how runnable tasks are enqueued, when they
 * are dispatched, and whether a fiber should yield after consuming its
 * operation budget.
 *
 * **Common tasks**
 *
 * - Use {@link Scheduler} to provide a custom runtime scheduler
 * - Use {@link MixedScheduler} for the default priority-aware scheduler
 * - Use {@link MaxOpsBeforeYield} to tune fairness for CPU-bound fibers
 * - Use {@link PreventSchedulerYield} only when a runtime should bypass yield checks
 *
 * **Gotchas**
 *
 * - Scheduler priorities affect the order of queued runtime tasks, not the
 *   semantic result of an `Effect`
 * - Disabling scheduler yields can improve throughput for controlled workloads,
 *   but it can also let long-running fibers monopolize the JavaScript thread
 *
 * @since 2.0.0
 */
export * as Scheduler from "./Scheduler.ts"

/**
 * Define data shapes, validate unknown input, and transform values between formats.
 *
 * ## Mental model
 *
 * - **Schema** — a description of a data shape. Every schema carries a decoded
 *   *Type* (the value you work with) and an *Encoded* representation (the
 *   serialized form, e.g. JSON).
 * - **Decoding** — turning unknown external data (API responses, form
 *   submissions, config files) into typed, validated values.
 * - **Encoding** — turning typed values back into a serializable format.
 * - **Codec** — a schema that tracks both Type and Encoded, so it can decode
 *   *and* encode. Most concrete schemas are Codecs.
 * - **Check / Filter** — a constraint attached to a schema (e.g. `isMinLength`,
 *   `isGreaterThan`). Attach them with `.check(...)`.
 * - **Transformation** — a pair of functions (decode + encode) that convert
 *   values between two schemas. Created with {@link decodeTo} / {@link encodeTo}.
 * - **Annotation** — metadata attached to a schema (title, description, custom
 *   keys). Attach with `.annotate(...)`.
 *
 * ## Common tasks
 *
 * - Define a struct: {@link Struct}
 * - Define a union: {@link Union}, {@link TaggedUnion}, {@link Literals}
 * - Define an array: {@link ArraySchema}, {@link NonEmptyArray}
 * - Define a record: {@link Record}
 * - Define a tuple: {@link Tuple}, {@link TupleWithRest}
 * - Validate unknown data synchronously: {@link decodeUnknownSync}
 * - Validate unknown data (Effect): {@link decodeUnknownEffect}
 * - Encode a value: {@link encodeUnknownSync}, {@link encodeUnknownEffect}
 * - Type guard: {@link is}
 * - Assertion: {@link asserts}
 * - Add constraints: `.check(...)` with filters like {@link isMinLength},
 *   {@link isGreaterThan}, {@link isPattern}, {@link isUUID}
 * - Transform between schemas: {@link decodeTo}, {@link encodeTo}
 * - Add a default for missing keys: {@link withDecodingDefault}, {@link withDecodingDefaultKey}
 * - Create branded types: {@link brand}
 * - Define classes with validation: {@link Class}, {@link TaggedClass}
 * - Define error classes: {@link ErrorClass}, {@link TaggedErrorClass}
 * - Generate JSON Schema: {@link toJsonSchemaDocument}
 * - Generate test data: {@link toArbitrary}
 * - Derive equivalence: {@link toEquivalence}
 *
 * ## Gotchas
 *
 * - `Schema.optional` creates `T | undefined` (key can be missing *or*
 *   `undefined`). Use `Schema.optionalKey` for exact optional properties.
 * - `decodeTo` is curried: use `from.pipe(Schema.decodeTo(to, ...))`.
 * - `decodeUnknownSync` throws on failure. Use `decodeUnknownExit` or
 *   `decodeUnknownOption` for non-throwing alternatives.
 * - Filters do not change the TypeScript type. Use {@link refine} or
 *   {@link brand} to narrow the type.
 * - Recursive schemas require {@link suspend} to avoid infinite loops.
 *
 * ## Quickstart
 *
 * **Example** (Validate a user object)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const User = Schema.Struct({
 *   name: Schema.String.check(Schema.isMinLength(1)),
 *   age: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
 *   email: Schema.optionalKey(Schema.String)
 * })
 *
 * // Decode unknown input — throws on failure
 * const user = Schema.decodeUnknownSync(User)({
 *   name: "Alice",
 *   age: 30
 * })
 *
 * console.log(user)
 * // { name: "Alice", age: 30 }
 * ```
 *
 * @see {@link Schema} — type-level view tracking only the decoded Type
 * @see {@link Codec} — type-level view tracking both Type and Encoded
 * @see {@link Struct} — define object shapes
 * @see {@link decodeUnknownSync} — synchronous validation
 * @see {@link decodeTo} — schema transformations
 *
 * @since 4.0.0
 */
export * as Schema from "./Schema.ts"

/**
 * Abstract Syntax Tree (AST) representation for Effect schemas.
 *
 * This module defines the runtime data structures that represent schemas.
 * Most users work with the `Schema` module directly; use `SchemaAST` when you
 * need to inspect, traverse, or programmatically transform schema definitions.
 *
 * ## Mental model
 *
 * - **{@link AST}** — discriminated union (`_tag`) of all schema node types
 *   (e.g. `String`, `Objects`, `Union`, `Suspend`)
 * - **{@link Base}** — abstract base class shared by every node; carries
 *   annotations, checks, encoding chain, and context
 * - **{@link Encoding}** — a non-empty chain of {@link Link} values describing
 *   how to transform between the decoded (type) and encoded (wire) form
 * - **{@link Check}** — a validation filter ({@link Filter} or
 *   {@link FilterGroup}) attached to an AST node
 * - **{@link Context}** — per-property metadata: optionality, mutability,
 *   default values, key annotations
 * - **Guards** — type-narrowing predicates for each AST variant (e.g.
 *   {@link isString}, {@link isObjects})
 *
 * ## Common tasks
 *
 * - Inspect what kind of schema you have → guard functions ({@link isString},
 *   {@link isObjects}, {@link isUnion}, etc.)
 * - Get the decoded (type-level) AST → {@link toType}
 * - Get the encoded (wire-format) AST → {@link toEncoded}
 * - Swap decode/encode directions → {@link flip}
 * - Read annotations → {@link resolve}, {@link resolveAt},
 *   {@link resolveIdentifier}
 * - Build a transformation between schemas → {@link decodeTo}
 * - Add regex validation → {@link isPattern}
 *
 * ## Gotchas
 *
 * - AST nodes are structurally immutable; modification helpers return new
 *   objects via `Object.create`.
 * - {@link Arrays} represents both tuples and arrays; {@link Objects}
 *   represents both structs and records.
 * - {@link toType} and {@link toEncoded} are memoized — same input yields
 *   same output reference.
 * - {@link Suspend} lazily resolves its inner AST via a thunk; the thunk is
 *   memoized on first call.
 *
 * ## Quickstart
 *
 * **Example** (Inspecting a schema's AST)
 *
 * ```ts
 * import { Schema, SchemaAST } from "effect"
 *
 * const schema = Schema.Struct({ name: Schema.String, age: Schema.Number })
 * const ast = schema.ast
 *
 * if (SchemaAST.isObjects(ast)) {
 *   console.log(ast.propertySignatures.map(ps => ps.name))
 *   // ["name", "age"]
 * }
 *
 * const encoded = SchemaAST.toEncoded(ast)
 * console.log(SchemaAST.isObjects(encoded)) // true
 * ```
 *
 * ## See also
 *
 * - {@link AST}
 * - {@link toType}
 * - {@link toEncoded}
 * - {@link flip}
 * - {@link resolve}
 *
 * @since 4.0.0
 */
export * as SchemaAST from "./SchemaAST.ts"

/**
 * Composable transformation primitives for the Effect Schema system.
 *
 * A `Getter<T, E, R>` represents a single-direction transformation from an
 * encoded type `E` to a decoded type `T`. Getters are the building blocks
 * that `Schema.decodeTo` and `Schema.decode` use to define how values are
 * transformed during encoding and decoding. They handle optionality
 * (`Option<E>` in, `Option<T>` out), can fail with `Issue`, and can require
 * Effect services via `R`.
 *
 * ## Mental model
 *
 * - **Getter**: A function `Option<E> -> Effect<Option<T>, Issue, R>`. It
 *   transforms an optional encoded value into an optional decoded value,
 *   possibly failing or requiring services.
 * - **Passthrough**: The identity getter — returns the input unchanged. Used
 *   when no transformation is needed. Optimized away during composition.
 * - **Option-awareness**: Getters receive and return `Option` to handle
 *   missing keys in structs. `Option.None` means the key is absent.
 * - **Composition**: Getters compose left-to-right via `.compose()`. A
 *   passthrough on either side is a no-op (identity optimization).
 * - **Issue**: The error type for all getter failures (see `SchemaIssue`).
 *
 * ## Common tasks
 *
 * - Pass a value through unchanged → {@link passthrough}
 * - Transform a value purely → {@link transform}
 * - Transform a value with possible failure → {@link transformOrFail}
 * - Transform with full Option control → {@link transformOptional}
 * - Handle missing keys → {@link onNone}, {@link required}, {@link withDefault}
 * - Handle present values → {@link onSome}
 * - Validate a value with an effectful check → {@link checkEffect}
 * - Produce a constant value → {@link succeed}
 * - Always fail → {@link fail}, {@link forbidden}
 * - Omit a value from output → {@link omit}
 * - Coerce to a primitive type → {@link String}, {@link Number}, {@link Boolean}, {@link BigInt}, {@link Date}
 * - Transform strings → {@link trim}, {@link capitalize}, {@link toLowerCase}, {@link toUpperCase}, {@link split}, {@link splitKeyValue}, {@link joinKeyValue}
 * - Parse/stringify JSON → {@link parseJson}, {@link stringifyJson}
 * - Encode/decode Base64 → {@link encodeBase64}, {@link decodeBase64}, {@link decodeBase64String}
 * - Encode/decode Hex → {@link encodeHex}, {@link decodeHex}, {@link decodeHexString}
 * - Encode/decode URI components → {@link encodeUriComponent}, {@link decodeUriComponent}
 * - Parse DateTime → {@link dateTimeUtcFromInput}
 * - Decode/encode FormData → {@link decodeFormData}, {@link encodeFormData}
 * - Decode/encode URLSearchParams → {@link decodeURLSearchParams}, {@link encodeURLSearchParams}
 * - Build nested tree from bracket paths → {@link makeTreeRecord}
 * - Flatten nested tree to bracket paths → {@link collectBracketPathEntries}
 *
 * ## Gotchas
 *
 * - Getters are not bidirectional. To define a full encode/decode pair, supply
 *   both a `decode` and an `encode` getter to `Schema.decodeTo`.
 * - `passthrough` requires `T === E` by default. Use `{ strict: false }` to
 *   bypass the type constraint, or use {@link passthroughSupertype} / {@link passthroughSubtype}.
 * - `transform` skips `None` inputs (missing keys) — the function is only
 *   called when a value is present. Use `transformOptional` if you need to
 *   handle missing values.
 * - `parseJson` without a `reviver` returns `Schema.MutableJson`. With a
 *   reviver, the return type widens to `unknown`.
 * - `split` treats an empty string as an empty array, not `[""]`.
 *
 * ## Quickstart
 *
 * **Example** (Using SchemaGetter with Schema.decodeTo)
 *
 * ```ts
 * import { Schema, SchemaGetter } from "effect"
 *
 * const NumberFromString = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Number, {
 *     decode: SchemaGetter.transform((s) => Number(s)),
 *     encode: SchemaGetter.transform((n) => String(n))
 *   })
 * )
 *
 * const result = Schema.decodeUnknownSync(NumberFromString)("42")
 * // result: 42
 * ```
 *
 * ## See also
 *
 * - {@link Getter} — the core class
 * - {@link transform} — most common constructor
 * - {@link passthrough} — identity getter
 * - {@link transformOrFail} — fallible transformation
 *
 * @since 4.0.0
 */
export * as SchemaGetter from "./SchemaGetter.ts"

/**
 * Structured validation errors produced by the Effect Schema system.
 *
 * When `Schema.decode`, `Schema.encode`, or a filter rejects a value, the
 * result is an {@link Issue} — a recursive tree that describes *what* went
 * wrong and *where*. This module defines every node type in that tree and
 * provides formatters that turn an `Issue` into a human-readable string or a
 * Standard Schema V1 failure result.
 *
 * ## Mental model
 *
 * - **Issue**: A discriminated union (`_tag`) of all possible validation error
 *   nodes. It is recursive — composite nodes wrap inner `Issue` children.
 * - **Leaf**: A terminal issue with no inner children ({@link InvalidType},
 *   {@link InvalidValue}, {@link MissingKey}, {@link UnexpectedKey},
 *   {@link Forbidden}, {@link OneOf}).
 * - **Composite nodes**: Wrap one or more inner issues to add context —
 *   {@link Filter}, {@link Encoding}, {@link Pointer}, {@link Composite},
 *   {@link AnyOf}.
 * - **Pointer**: Adds a property-key path to an inner issue, indicating
 *   *where* in the input the error occurred.
 * - **Formatter**: A function `Issue → Format` that serialises the error tree.
 *   Two built-in factories are provided: {@link makeFormatterDefault} (plain
 *   string) and {@link makeFormatterStandardSchemaV1} (Standard Schema V1).
 *
 * ## Common tasks
 *
 * - Check if a value is an Issue → {@link isIssue}
 * - Extract the actual input from any issue → {@link getActual}
 * - Format an issue as a string → {@link makeFormatterDefault}
 * - Format an issue for Standard Schema V1 → {@link makeFormatterStandardSchemaV1}
 * - Customise leaf formatting → {@link defaultLeafHook}
 * - Customise filter formatting → {@link defaultCheckHook}
 *
 * ## Gotchas
 *
 * - `Pointer` and `MissingKey` carry no actual value — {@link getActual}
 *   returns `Option.none()` for them.
 * - `AnyOf`, `UnexpectedKey`, `OneOf`, and `Filter` store `actual` as a plain
 *   `unknown` (not `Option`), so {@link getActual} wraps them with
 *   `Option.some`.
 * - Calling `toString()` on any `Issue` uses the default formatter. To
 *   customise output, create your own formatter with
 *   {@link makeFormatterDefault} or {@link makeFormatterStandardSchemaV1}.
 * - The `Issue` tree can be deeply nested for complex schemas. Formatters
 *   flatten composite nodes for display.
 *
 * ## Quickstart
 *
 * **Example** (Inspecting a validation error)
 *
 * ```ts
 * import { Schema, SchemaIssue } from "effect"
 *
 * const Person = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.Number
 * })
 *
 * try {
 *   Schema.decodeUnknownSync(Person)({ name: 42 })
 * } catch (e) {
 *   if (Schema.isSchemaError(e)) {
 *     console.log(SchemaIssue.isIssue(e.issue))
 *     // true
 *     console.log(String(e.issue))
 *     // formatted error message
 *   }
 * }
 * ```
 *
 * ## See also
 *
 * - {@link Issue} — the root union type
 * - {@link Leaf} — terminal issue types
 * - {@link Formatter} — the formatter interface
 * - {@link makeFormatterDefault} — default string formatter
 *
 * @since 4.0.0
 */
export * as SchemaIssue from "./SchemaIssue.ts"

/**
 * The `SchemaParser` module turns schemas into reusable runtime operations for
 * constructing, validating, decoding, and encoding values. It is the execution
 * layer behind a schema's AST: parsers walk the schema structure, apply
 * transformations, honor parse options, run checks, and report failures as
 * `SchemaIssue.Issue` values.
 *
 * Use this module when you need a parser with a specific result shape:
 * `Effect` for effectful parsing and service requirements, `Promise` for
 * JavaScript interop, `Exit` or `Result` when failures should stay in data,
 * `Option` for yes/no validation, and synchronous helpers when throwing is the
 * desired boundary.
 *
 * Decoding reads from the encoded/input side of a schema into its decoded
 * `Type`, while encoding runs the schema in the opposite direction. The
 * `make*` helpers construct decoded values and apply constructor defaults before
 * validation. Parse options supplied when a parser is created are merged with
 * options supplied at call time, and schema-level parse annotations can further
 * refine behavior.
 *
 * @since 4.0.0
 */
export * as SchemaParser from "./SchemaParser.ts"

/**
 * Serializable intermediate representation (IR) of Effect Schema types.
 *
 * `SchemaRepresentation` sits between the internal `SchemaAST` and external
 * formats (JSON Schema, generated TypeScript code, serialized JSON). A
 * {@link Representation} is a discriminated union describing the *shape* of a
 * schema — its types, checks, annotations, and references — in a form that
 * can be round-tripped through JSON and used for code generation.
 *
 * ## Mental model
 *
 * - **Representation**: A tagged union (`_tag`) of all supported schema shapes:
 *   primitives, literals, objects, arrays, unions, declarations, references,
 *   and suspensions.
 * - **Document**: A single {@link Representation} paired with a map of named
 *   {@link References} (analogous to JSON Schema `$defs`).
 * - **MultiDocument**: Like `Document` but holds one or more representations
 *   sharing the same references.
 * - **Check / Filter / FilterGroup**: Validation constraints (min length,
 *   pattern, integer, etc.) attached to types that support them.
 * - **Meta types**: Typed metadata for checks on each category — e.g.
 *   {@link StringMeta}, {@link NumberMeta}, {@link ArraysMeta}.
 * - **Reviver**: A callback used by {@link toSchema} and {@link toCodeDocument}
 *   to handle `Declaration` nodes (custom types like `Option`, `Date`, etc.).
 * - **Code / CodeDocument**: Output of {@link toCodeDocument} — TypeScript
 *   source strings for runtime schemas and their type-level counterparts.
 *
 * ## Common tasks
 *
 * - Convert a Schema AST to a Document → {@link fromAST}
 * - Convert multiple ASTs to a MultiDocument → {@link fromASTs}
 * - Reconstruct a runtime Schema from a Document → {@link toSchema}
 * - Convert a Document to JSON Schema → {@link toJsonSchemaDocument}
 * - Convert a MultiDocument to JSON Schema → {@link toJsonSchemaMultiDocument}
 * - Parse a JSON Schema document into a Document → {@link fromJsonSchemaDocument}
 * - Parse a JSON Schema multi-document → {@link fromJsonSchemaMultiDocument}
 * - Generate TypeScript code from a MultiDocument → {@link toCodeDocument}
 * - Serialize/deserialize a Document as JSON → {@link DocumentFromJson}
 * - Serialize/deserialize a MultiDocument as JSON → {@link MultiDocumentFromJson}
 * - Wrap a Document as a MultiDocument → {@link toMultiDocument}
 *
 * ## Gotchas
 *
 * - `Declaration` nodes require a {@link Reviver} to reconstruct complex types
 *   (e.g. `Option`, `Date`). Without one, `toSchema` falls back to the
 *   declaration's `encodedSchema`. Use {@link toSchemaDefaultReviver} for
 *   built-in Effect types.
 * - `Reference` nodes are resolved against the `references` map in the
 *   `Document`. An unresolvable `$ref` throws at runtime.
 * - `Suspend` wraps a single `thunk` representation; it is used for recursive
 *   schemas. Circular references are handled by lazy resolution in
 *   {@link toSchema}.
 * - The `$`-prefixed exports (e.g. {@link $Representation}, {@link $Document})
 *   are Schema codecs for the representation types themselves — use them to
 *   validate or encode/decode representation data, not application data.
 *
 * ## Quickstart
 *
 * **Example** (Round-trip through JSON)
 *
 * ```ts
 * import { Schema, SchemaRepresentation } from "effect"
 *
 * const Person = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.Int
 * })
 *
 * // Schema AST → Document
 * const doc = SchemaRepresentation.fromAST(Person.ast)
 *
 * // Document → JSON Schema
 * const jsonSchema = SchemaRepresentation.toJsonSchemaDocument(doc)
 *
 * // Document → runtime Schema
 * const reconstructed = SchemaRepresentation.toSchema(doc)
 * ```
 *
 * ## See also
 *
 * - {@link Representation} — the core tagged union
 * - {@link Document} — single-schema container
 * - {@link fromAST} — entry point from Schema AST
 * - {@link toSchema} — reconstruct a runtime Schema
 * - {@link toCodeDocument} — generate TypeScript code
 *
 * @since 4.0.0
 */
export * as SchemaRepresentation from "./SchemaRepresentation.ts"

/**
 * Bidirectional transformations for the Effect Schema system.
 *
 * A `Transformation` pairs a decode `Getter` and an encode `Getter` into a
 * single bidirectional value, used by `Schema.decodeTo`, `Schema.encodeTo`,
 * `Schema.decode`, `Schema.encode`, and `Schema.link` to define how values
 * are converted between encoded and decoded representations. A `Middleware`
 * is the effect-level equivalent — it wraps the entire parsing `Effect`
 * pipeline rather than individual values.
 *
 * ## Mental model
 *
 * - **Transformation**: A pair of `Getter`s (decode + encode) that convert
 *   individual values bidirectionally. `T` is the decoded (Type) side, `E` is
 *   the encoded side. `RD`/`RE` are required Effect services.
 * - **Middleware**: Like `Transformation`, but each direction receives the full
 *   parsing `Effect` and can intercept, retry, or modify the pipeline.
 * - **Getter**: A single-direction transform `Option<E> → Effect<Option<T>, Issue, R>`
 *   (see `SchemaGetter`).
 * - **flip()**: Swaps decode and encode, turning a `Transformation<T, E>` into
 *   `Transformation<E, T>`.
 * - **compose()**: Chains two transformations left-to-right on the decode side
 *   and right-to-left on the encode side.
 * - **passthrough**: The identity transformation — no conversion in either
 *   direction.
 *
 * ## Common tasks
 *
 * - Convert values purely (sync, infallible) → {@link transform}
 * - Convert values with possible failure → {@link transformOrFail}
 * - Handle optional/missing keys → {@link transformOptional}
 * - Build from existing Getters → {@link make}
 * - No-op identity transformation → {@link passthrough}
 * - Subtype/supertype coercion → {@link passthroughSupertype}, {@link passthroughSubtype}
 * - Trim/case strings → {@link trim}, {@link toLowerCase}, {@link toUpperCase}, {@link capitalize}, {@link uncapitalize}, {@link snakeToCamel}
 * - Parse key-value strings → {@link splitKeyValue}
 * - Coerce string ↔ number/bigint → {@link numberFromString}, {@link bigintFromString}
 * - Coerce string ↔ Date/Duration → {@link dateFromString}, {@link durationFromString}
 * - Decode durations → {@link durationFromNanos}, {@link durationFromMillis}
 * - Wrap nullable/optional as Option → {@link optionFromNullOr}, {@link optionFromOptionalKey}, {@link optionFromOptional}
 * - Parse URLs → {@link urlFromString}
 * - Base64 ↔ Uint8Array → {@link uint8ArrayFromBase64String}
 * - Base64 ↔ string → {@link stringFromBase64String}
 * - URI component ↔ string → {@link stringFromUriComponent}
 * - JSON string ↔ unknown → {@link fromJsonString}
 * - FormData/URLSearchParams ↔ unknown → {@link fromFormData}, {@link fromURLSearchParams}
 * - Check if a value is a Transformation → {@link isTransformation}
 *
 * ## Gotchas
 *
 * - `Transformation` operates on individual values; `Middleware` wraps the
 *   entire parsing Effect. Choose accordingly.
 * - `passthrough` requires `T === E` by default. Use `{ strict: false }` to
 *   bypass, or use {@link passthroughSupertype} / {@link passthroughSubtype}.
 * - String transformations like `trim`, `toLowerCase`, and `toUpperCase` use
 *   `passthrough` on the encode side — they are lossy and do not round-trip.
 * - `durationFromNanos` encode can fail if the Duration cannot be represented
 *   as a `bigint`.
 *
 * ## Quickstart
 *
 * **Example** (Defining a custom transformation with Schema.decodeTo)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const CentsFromDollars = Schema.Number.pipe(
 *   Schema.decodeTo(
 *     Schema.Number,
 *     SchemaTransformation.transform({
 *       decode: (dollars) => dollars * 100,
 *       encode: (cents) => cents / 100
 *     })
 *   )
 * )
 * ```
 *
 * ## See also
 *
 * - {@link Transformation} — the core bidirectional transformation class
 * - {@link Middleware} — effect-pipeline-level transformation
 * - {@link transform} — most common constructor
 * - {@link passthrough} — identity transformation
 *
 * @since 4.0.0
 */
export * as SchemaTransformation from "./SchemaTransformation.ts"

/**
 * The `SchemaUtils` module contains focused helpers for schema patterns that
 * are useful but too specialized for the core `Schema` API surface.
 *
 * Use this module when you need to describe a native class with a schema while
 * keeping a plain struct as its encoded representation. This is especially
 * useful for classes such as `Data.Error` subclasses that should decode from
 * structured data, encode back to that data, and still preserve class identity
 * for instance checks and schema optics.
 *
 * **Gotchas**
 *
 * - The constructor is called with the decoded struct fields as a single
 *   argument, so the class constructor must accept that shape.
 * - Encoding uses the instance itself as the encoded shape, so the instance
 *   should expose properties compatible with the provided struct schema.
 *
 * @since 4.0.0
 */
export * as SchemaUtils from "./SchemaUtils.ts"

/**
 * The `Scope` module provides functionality for managing resource lifecycles
 * and cleanup operations in a functional and composable manner.
 *
 * A `Scope` represents a context where resources can be acquired and automatically
 * cleaned up when the scope is closed. This is essential for managing resources
 * like file handles, database connections, or any other resources that need
 * proper cleanup.
 *
 * Scopes support both sequential and parallel finalization strategies:
 * - Sequential: Finalizers run one after another in reverse order of registration
 * - Parallel: Finalizers run concurrently for better performance
 *
 * @since 2.0.0
 */
export * as Scope from "./Scope.ts"

/**
 * The `ScopedCache` module provides a cache for values that acquire scoped
 * resources during lookup. Each cached entry owns a `Scope`, so resources
 * created while computing a value stay alive for as long as that entry remains
 * cached and are released when the entry is removed.
 *
 * A `ScopedCache` is itself created inside a scope. Calls to {@link get} run the
 * lookup effect on cache misses, share the same in-flight lookup among
 * concurrent callers for the same key, and store the resulting exit according
 * to a time-to-live policy. Entries can be inserted manually with {@link set},
 * refreshed with {@link refresh}, inspected without triggering lookup with
 * {@link getOption}, and removed with {@link invalidate} or
 * {@link invalidateAll}. Capacity limits evict the oldest entries.
 *
 * **Lifecycle notes**
 *
 * - Entry scopes are closed when entries expire, are invalidated, are evicted,
 *   are replaced, or when the cache's owning scope closes
 * - Successful and failed lookup exits are both cached according to the
 *   configured TTL
 * - Expired entries may remain counted by {@link size} until a cache operation
 *   observes and removes them
 * - Once the owning scope closes, the cache is closed and lookup-style
 *   operations interrupt instead of acquiring new values
 *
 * @since 4.0.0
 */
export * as ScopedCache from "./ScopedCache.ts"

/**
 * The `ScopedRef` module provides a mutable reference for values that are tied
 * to scoped resources. Each value stored in a `ScopedRef` is acquired within its
 * own `Scope`, and replacing the value safely releases the resources associated
 * with the previous value.
 *
 * Use `ScopedRef` when an application needs to keep a current resource-backed
 * value, such as a live client, connection, subscription, or cached handle, and
 * later swap it for a newly acquired value without leaking the old resources.
 * Reads are simple, while updates are synchronized and resource-safe.
 *
 * **Gotchas**
 *
 * - A `ScopedRef` must itself be created and used within a `Scope`; when that
 *   scope closes, the currently stored value is finalized.
 * - Use {@link fromAcquire} or {@link set} for resourceful values so acquisition
 *   and finalization are tracked correctly.
 * - Use {@link make} only for values that do not acquire resources.
 * - Updating a `ScopedRef` waits for the replacement acquisition and old
 *   finalization to complete before returning.
 *
 * @since 2.0.0
 */
export * as ScopedRef from "./ScopedRef.ts"

/**
 * The `Semaphore` module provides a counting semaphore for coordinating
 * concurrent access to shared or limited resources. A semaphore tracks a fixed
 * number of permits: effects acquire permits before entering a critical section
 * and release them when they leave.
 *
 * Use semaphores to bound parallel work, protect rate-limited services, or
 * serialize access to resources that cannot safely handle unlimited
 * concurrency. Prefer {@link withPermit} and {@link withPermits} when possible,
 * because they release permits automatically when the protected effect exits.
 * Use {@link take} and {@link release} for lower-level protocols that need
 * manual control.
 *
 * **Gotchas**
 *
 * - Pending acquisitions wait until enough permits are available.
 * - {@link withPermitsIfAvailable} does not wait; it returns `Option.none` when
 *   the requested permits cannot be acquired immediately.
 * - Manual `take` / `release` usage must keep permit counts balanced.
 *
 * @since 4.0.0
 */
export * as Semaphore from "./Semaphore.ts"

/**
 * The `Sink` module provides composable consumers for `Stream` values. A
 * `Sink<A, In, L, E, R>` pulls input elements of type `In`, may require
 * services `R`, may fail with `E`, and eventually produces a result `A` plus
 * any leftover input `L` that was read but not consumed.
 *
 * **Mental model**
 *
 * - A sink is the terminal consumer used by `Stream.run`
 * - Sinks can consume zero, one, many, or all input elements before finishing
 * - Leftovers allow one sink to stop early without losing already-pulled input
 * - Sink composition preserves typed errors and service requirements
 * - Most sinks are built from `Channel` internally, but users compose them with
 *   the higher-level APIs in this module
 *
 * **Common tasks**
 *
 * - Create simple sinks: {@link succeed}, {@link fail}, {@link fromEffect}
 * - Fold input: {@link fold}
 * - Collect values: {@link collect}
 * - Count or drain input: {@link count}, {@link drain}
 * - Transform results: {@link map}, {@link mapEffect}, {@link as}
 * - Adapt input before consumption: {@link mapInput}, {@link mapInputEffect}
 *
 * **Gotchas**
 *
 * - A sink can finish before the stream is exhausted; check leftover-aware
 *   combinators when composing parsers or protocol decoders
 * - `In` is contravariant, so a sink that accepts broader input can be used
 *   where narrower input is expected
 * - Resource and service requirements are tracked in the `R` type parameter
 *
 * @since 2.0.0
 */
export * as Sink from "./Sink.ts"

/**
 * The `Stdio` module defines the service interface used by Effect programs to
 * interact with process standard I/O. It models command-line arguments,
 * standard output, standard error, and standard input as Effects, Sinks, and
 * Streams so programs can depend on console I/O through `Context` instead of
 * directly coupling to a specific runtime.
 *
 * Use this module when building command-line programs, tests, or platform
 * integrations that need to read bytes from stdin, write text or bytes to
 * stdout/stderr, or provide deterministic replacements for those capabilities.
 * The `layerTest` helper is useful for tests because it supplies inert defaults
 * and lets individual fields be overridden.
 *
 * Standard I/O operations are platform capabilities and may fail with
 * `PlatformError`; handle those failures in the Effect error channel rather than
 * assuming writes or reads are infallible.
 *
 * @since 4.0.0
 */
export * as Stdio from "./Stdio.ts"

/**
 * The `Stream` module provides a typed, composable way to describe effectful
 * sequences of values. A `Stream<A, E, R>` can emit zero or more `A` values,
 * fail with an `E`, and require services from `R` while preserving
 * backpressure and resource safety.
 *
 * **Mental model**
 *
 * - A stream is a lazy description; it runs only when consumed with a `run*` function
 * - Streams are pull-based and emit chunks internally for efficient throughput
 * - `A` is the element type, `E` is the failure type, and `R` is the required context
 * - Stream composition mirrors `Effect`: use `map`, `flatMap`, error handling, and `pipe`
 * - Resource scopes, interruption, and finalizers are tracked by the Effect runtime
 * - Interop functions connect streams to queues, pub/subs, web streams, async iterables, and channels
 *
 * **Common tasks**
 *
 * - Create streams: {@link make}, {@link fromIterable}, {@link fromEffect}, {@link fromQueue}
 * - Transform values: {@link map}, {@link mapEffect}, {@link flatMap}, {@link filter}
 * - Combine streams: {@link concat}, {@link merge}, {@link zip}, {@link race}
 * - Control demand and timing: {@link take}, {@link drop}, {@link debounce}, {@link throttle}
 * - Manage errors: {@link catchCause}, {@link catchIf}, {@link mapError}, {@link retry}
 * - Manage resources and services: {@link scoped}, {@link ensuring}, {@link provide}
 * - Consume streams: {@link runCollect}, {@link runForEach}, {@link runFold}, {@link runDrain}
 *
 * **Gotchas**
 *
 * - A stream is not a collection; constructors and operators build a description until it is run
 * - Re-running a stream re-executes its effects unless it is explicitly shared or backed by external state
 * - Operators such as {@link merge}, {@link race}, and {@link broadcast} introduce concurrency and interruption semantics
 * - Prefer bounded constructors and sinks for large or infinite streams instead of collecting everything into memory
 *
 * **See also**
 *
 * - {@link Effect.Effect} for single-result effectful programs
 * - {@link Sink.Sink} for consuming and folding streams
 * - {@link Channel.Channel} for the lower-level primitive underlying streams
 *
 * @since 2.0.0
 */
export * as Stream from "./Stream.ts"

/**
 * This module provides utility functions and type class instances for working with the `string` type in TypeScript.
 * It includes functions for basic string manipulation.
 *
 * @since 2.0.0
 */
export * as String from "./String.ts"

/**
 * Utilities for creating, transforming, and comparing plain TypeScript objects
 * (structs). Every function produces a new object — inputs are never mutated.
 *
 * ## Mental model
 *
 * - **Struct**: A plain JS object with a fixed set of known keys (e.g.,
 *   `{ name: string; age: number }`). Not a generic key-value record.
 * - **Dual API**: Most functions accept arguments in both data-first
 *   (`Struct.pick(obj, keys)`) and data-last (`pipe(obj, Struct.pick(keys))`)
 *   style.
 * - **Immutability**: All operations return a new object; the original is
 *   never modified.
 * - **Lambda**: A type-level function interface (`~lambda.in` / `~lambda.out`)
 *   used by {@link map}, {@link mapPick}, and {@link mapOmit} so the compiler
 *   can track how value types change.
 * - **Evolver pattern**: {@link evolve}, {@link evolveKeys}, and
 *   {@link evolveEntries} let you selectively transform values, keys, or both
 *   while leaving untouched properties unchanged.
 *
 * ## Common tasks
 *
 * - Access a property in a pipeline → {@link get}
 * - List string keys with proper types → {@link keys}
 * - Subset / remove properties → {@link pick}, {@link omit}
 * - Merge two structs (second wins) → {@link assign}
 * - Rename keys → {@link renameKeys}
 * - Transform selected values → {@link evolve}
 * - Transform selected keys → {@link evolveKeys}
 * - Transform both keys and values → {@link evolveEntries}
 * - Map all values with a typed lambda → {@link map}, {@link mapPick},
 *   {@link mapOmit}
 * - Compare structs → {@link makeEquivalence}, {@link makeOrder}
 * - Combine / reduce structs → {@link makeCombiner}, {@link makeReducer}
 * - Flatten intersection types → {@link Simplify}
 * - Strip `readonly` modifiers → {@link Mutable}
 *
 * ## Gotchas
 *
 * - {@link keys} only returns `string` keys; symbol keys are excluded.
 * - {@link pick} and {@link omit} iterate with `for...in`, which includes
 *   inherited enumerable properties but excludes non-enumerable ones.
 * - {@link assign} spreads with `...`; property order follows standard
 *   JS spread rules.
 * - {@link map}, {@link mapPick}, {@link mapOmit} require a {@link Lambda}
 *   value created with {@link lambda}; a plain function won't type-check.
 *
 * ## Quickstart
 *
 * **Example** (Picking, renaming, and evolving struct properties)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const user = { firstName: "Alice", lastName: "Smith", age: 30, admin: false }
 *
 * const result = pipe(
 *   user,
 *   Struct.pick(["firstName", "age"]),
 *   Struct.evolve({ age: (n) => n + 1 }),
 *   Struct.renameKeys({ firstName: "name" })
 * )
 *
 * console.log(result) // { name: "Alice", age: 31 }
 * ```
 *
 * ## See also
 *
 * - {@link Equivalence} – building equivalence relations for structs
 * - {@link Order} – ordering structs by their fields
 * - {@link Combiner} – combining two values of the same type
 * - {@link Reducer} – combining with an initial value
 *
 * @since 2.0.0
 */
export * as Struct from "./Struct.ts"

/**
 * The `SubscriptionRef` module provides a mutable reference that can be read
 * and updated like a `Ref`, while also exposing a stream of its current value
 * and every subsequent change. It is useful when one part of an application
 * owns evolving state and many fibers need to subscribe to consistent updates,
 * such as configuration, coordination state, cached snapshots, or UI models.
 *
 * Updates are serialized with an internal semaphore and each update is
 * published to subscribers. The {@link changes} stream replays the latest value
 * first, then emits future updates, so new subscribers can start from the
 * current state without performing a separate read. Prefer the effectful
 * getters and update operations for concurrent code; the unsafe helpers bypass
 * synchronization and should only be used when the caller already controls
 * access.
 *
 * @since 2.0.0
 */
export * as SubscriptionRef from "./SubscriptionRef.ts"

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
export * as Symbol from "./Symbol.ts"

/**
 * The `SynchronizedRef` module provides mutable references whose updates are
 * serialized, including updates that run effects before deciding the next
 * value. A `SynchronizedRef<A>` behaves like a `Ref<A>` for reading and basic
 * updates, but uses an internal semaphore so concurrent modifications observe a
 * consistent current value and apply one at a time.
 *
 * **When to use**
 *
 * - Coordinating shared state that may be updated by many fibers
 * - Running effectful state transitions that must not overlap
 * - Computing both a return value and a new stored value atomically
 * - Applying partial updates with `Option`, where `None` leaves the value
 *   unchanged
 *
 * **Gotchas**
 *
 * - Effectful update functions run while the semaphore is held, so long-running
 *   effects delay other updates to the same ref
 * - Failed effectful updates do not replace the stored value
 * - `getUnsafe` and `makeUnsafe` bypass the `Effect` API and should be reserved
 *   for low-level or carefully controlled code
 *
 * @since 2.0.0
 */
export * as SynchronizedRef from "./SynchronizedRef.ts"

/**
 * The `Take` module provides the representation used by stream-like producers
 * to describe a single pull result. A `Take<A, E, Done>` is either a
 * non-empty batch of emitted values, a failed `Exit`, or a successful `Exit`
 * carrying the stream's completion value.
 *
 * `Take` is useful at boundaries where pull results need to be stored,
 * transferred, or interpreted later while preserving the distinction between
 * emitted elements, failures, and normal completion. Use {@link toPull} to turn
 * a `Take` back into a `Pull`: value batches become successful pulls, failure
 * exits are propagated, and successful exits signal completion with `Done`.
 *
 * **Gotchas**
 *
 * - A value batch is always represented by a `NonEmptyReadonlyArray`; empty
 *   batches are not valid `Take` values.
 * - Successful `Exit` values do not emit elements. They represent pull
 *   completion and carry the `Done` value.
 *
 * @since 2.0.0
 */
export * as Take from "./Take.ts"

/**
 * The `Terminal` module defines the service interface used by platform
 * integrations to model command-line input and output. It gives programs a
 * uniform way to query terminal dimensions, read lines, stream low-level key
 * events, and write text without depending directly on Node, the browser, or a
 * test-specific console implementation.
 *
 * Use this module when building interactive command-line tools, prompts, or
 * platform abstractions that need terminal capabilities as an Effect service.
 * Implementations are supplied through context, so application code can depend
 * on `Terminal` while tests and runtimes provide the concrete behavior.
 *
 * `readLine` can fail with {@link QuitError} when the user requests to quit,
 * commonly via `Ctrl+C`. For lower-level interaction, `readInput` returns a
 * scoped stream of {@link UserInput} values containing parsed key metadata and
 * any raw character input.
 *
 * @since 4.0.0
 */
export * as Terminal from "./Terminal.ts"

/**
 * The `Tracer` module defines the low-level tracing model used by Effect to
 * describe and propagate spans. A span records the lifetime of an operation,
 * including its name, parent, attributes, links, annotations, sampling decision,
 * kind, and completion status.
 *
 * **Mental model**
 *
 * - `Tracer` is the backend interface responsible for creating spans
 * - `Span` values represent Effect-managed operations with mutable lifecycle
 *   hooks for ending spans and adding attributes, events, or links
 * - `ExternalSpan` represents trace context imported from another tracing
 *   system so Effect spans can be parented by or linked to external work
 * - `ParentSpan`, `Tracer`, and related context references control propagation,
 *   sampling, and trace-level filtering through the Effect context
 *
 * **Common tasks**
 *
 * - Implement a custom tracing backend with {@link make}
 * - Provide or inspect parent span context with {@link ParentSpan}
 * - Convert external trace identifiers into Effect span values with
 *   {@link externalSpan}
 * - Configure span metadata with {@link SpanOptions}, {@link SpanKind}, and
 *   {@link SpanLink}
 * - Disable propagation or adjust trace filtering with
 *   {@link DisablePropagation}, {@link CurrentTraceLevel}, and
 *   {@link MinimumTraceLevel}
 *
 * **Gotchas**
 *
 * - This module exposes the tracing data model and backend hooks; most
 *   application code should create spans through higher-level Effect APIs such
 *   as `Effect.withSpan`
 * - `ExternalSpan` only carries identity and metadata from another system; it
 *   does not have lifecycle methods like `Span`
 * - Propagation and sampling are context-dependent, so parent selection can be
 *   affected by disabled propagation, root span options, and trace-level
 *   thresholds
 *
 * @since 2.0.0
 */
export * as Tracer from "./Tracer.ts"

/**
 * A `Trie` is used for locating specific `string` keys from within a set.
 *
 * It works similar to `HashMap`, but with keys required to be `string`.
 * This constraint unlocks some performance optimizations and new methods to get string prefixes (e.g. `keysWithPrefix`, `longestPrefixOf`).
 *
 * Prefix search is also the main feature that makes a `Trie` more suited than `HashMap` for certain usecases.
 *
 * A `Trie` is often used to store a dictionary (list of words) that can be searched
 * in a manner that allows for efficient generation of completion lists
 * (e.g. predict the rest of a word a user is typing).
 *
 * A `Trie` has O(n) lookup time where `n` is the size of the key,
 * or even less than `n` on search misses.
 *
 * @since 2.0.0
 */
export * as Trie from "./Trie.ts"

/**
 * Utilities for creating, accessing, transforming, and comparing fixed-length
 * arrays (tuples). Every function produces a new tuple — inputs are never
 * mutated.
 *
 * ## Mental model
 *
 * - **Tuple**: A fixed-length readonly array where each position can have a
 *   different type (e.g., `readonly [string, number, boolean]`).
 * - **Index-based access**: Elements are accessed by numeric index, and the
 *   type system tracks the type at each position.
 * - **Dual API**: Most functions accept arguments in both data-first
 *   (`Tuple.get(t, 0)`) and data-last (`pipe(t, Tuple.get(0))`) style.
 * - **Immutability**: All operations return a new tuple; the original is
 *   never modified.
 * - **Lambda**: A type-level function interface (from {@link Struct}) used by
 *   {@link map}, {@link mapPick}, and {@link mapOmit} so the compiler can
 *   track how element types change.
 *
 * ## Common tasks
 *
 * - Create a tuple → {@link make}
 * - Access an element by index → {@link get}
 * - Select / remove elements by index → {@link pick}, {@link omit}
 * - Append elements → {@link appendElement}, {@link appendElements}
 * - Transform selected elements → {@link evolve}
 * - Swap element positions → {@link renameIndices}
 * - Map all elements with a typed lambda → {@link map}, {@link mapPick},
 *   {@link mapOmit}
 * - Compare tuples → {@link makeEquivalence}, {@link makeOrder}
 * - Combine / reduce tuples → {@link makeCombiner}, {@link makeReducer}
 * - Check tuple length at runtime → {@link isTupleOf},
 *   {@link isTupleOfAtLeast}
 *
 * ## Gotchas
 *
 * - {@link pick} and {@link omit} use numeric indices, not string keys.
 * - {@link renameIndices} takes an array of stringified source indices
 *   (e.g., `["2", "1", "0"]`), not arbitrary names.
 * - {@link map}, {@link mapPick}, {@link mapOmit} require a Lambda value
 *   created with `Struct.lambda`; a plain function won't type-check.
 * - {@link isTupleOf} and {@link isTupleOfAtLeast} only check length, not
 *   element types.
 *
 * ## Quickstart
 *
 * **Example** (Creating and transforming a tuple)
 *
 * ```ts
 * import { pipe, Tuple } from "effect"
 *
 * const point = Tuple.make(10, 20, "red")
 *
 * const result = pipe(
 *   point,
 *   Tuple.evolve([
 *     (x) => x * 2,
 *     (y) => y * 2
 *   ])
 * )
 *
 * console.log(result) // [20, 40, "red"]
 * ```
 *
 * ## See also
 *
 * - {@link Struct} – similar utilities for objects with named keys
 * - {@link Array} – operations on variable-length arrays
 *
 * @since 2.0.0
 */
export * as Tuple from "./Tuple.ts"

/**
 * TxChunk is a transactional chunk data structure that provides Software Transactional Memory (STM)
 * semantics for chunk operations. It uses a `TxRef<Chunk<A>>` internally to ensure all operations
 * are performed atomically within transactions.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and to track changes.
 * A transaction will retry whenever a conflict is detected or whenever the transaction explicitly
 * calls `Effect.txRetry` and any of the accessed TxChunk values change.
 *
 * @since 4.0.0
 */
export * as TxChunk from "./TxChunk.ts"

/**
 * A transactional deferred value — a write-once cell that can be read within transactions.
 * Readers retry until a value is set; once set, the value is immutable.
 *
 * @since 4.0.0
 */
export * as TxDeferred from "./TxDeferred.ts"

/**
 * The `TxHashMap` module provides a transactional hash map for storing and
 * updating key-value pairs inside Effect transactions. It is useful when
 * multiple fibers need to coordinate shared map state and each read-modify-write
 * sequence must be committed atomically.
 *
 * A `TxHashMap<K, V>` has the familiar shape of a `HashMap<K, V>`, but every
 * operation returns an `Effect` and participates in transaction semantics
 * through `TxRef`. Use it for concurrent registries, caches, counters, indexes,
 * and other mutable maps whose updates should compose safely with other
 * transactional references.
 *
 * **Common tasks**
 *
 * - Create maps with {@link empty}, {@link fromIterable}, or {@link make}
 * - Read entries with {@link get}, {@link has}, {@link keys}, {@link values}, and {@link entries}
 * - Update entries with {@link set}, {@link modify}, {@link modifyAt}, and {@link remove}
 * - Inspect aggregate state with {@link size}, {@link isEmpty}, and {@link reduce}
 *
 * **Gotchas**
 *
 * - Operations are effectful; run them in `Effect.gen` and wrap multi-step
 *   transactions with `Effect.tx` when the whole sequence must commit together.
 * - Reads that may be absent return `Option`, so handle both `Some` and `None`
 *   instead of assuming a key exists.
 *
 * @since 2.0.0
 */
export * as TxHashMap from "./TxHashMap.ts"

/**
 * The `TxHashSet` module provides a transactional hash set for storing unique
 * values inside Effect transactions. A `TxHashSet<A>` wraps a `HashSet<A>` in a
 * transactional reference, so reads and writes can be composed with other
 * transactional operations and committed atomically.
 *
 * **Common tasks**
 *
 * - Create transactional sets with {@link empty}, {@link make}, or {@link fromIterable}
 * - Mutate an existing set with {@link add}, {@link remove}, and {@link clear}
 * - Query membership and size with {@link has}, {@link size}, and {@link isEmpty}
 * - Derive new sets with {@link map}, {@link filter}, {@link union}, {@link intersection}, and {@link difference}
 * - Fold or collect values with {@link reduce} and {@link toHashSet}
 *
 * **Gotchas**
 *
 * - Mutation operations update the same transactional set; transform operations
 *   return a new `TxHashSet`
 * - Operations are `Effect` values and must be yielded, piped, or run to take effect
 * - Use `Effect.tx` when several operations must observe and commit one atomic transaction
 *
 * @since 2.0.0
 */
export * as TxHashSet from "./TxHashSet.ts"

/**
 * A transactional priority queue. Elements are dequeued in order determined by the
 * provided `Order` instance. All operations participate in the STM transaction system.
 *
 * @since 4.0.0
 */
export * as TxPriorityQueue from "./TxPriorityQueue.ts"

/**
 * TxPubSub is a transactional publish/subscribe hub that provides Software Transactional Memory
 * (STM) semantics for message broadcasting. Publishers broadcast messages to all current
 * subscribers, with each subscriber receiving its own copy of every published message.
 *
 * Supports multiple queue strategies: bounded, unbounded, dropping, and sliding.
 *
 * @since 4.0.0
 */
export * as TxPubSub from "./TxPubSub.ts"

/**
 * TxQueue is a transactional queue data structure that provides Software Transactional Memory (STM)
 * semantics for queue operations. It uses TxRef for transactional state management and supports
 * multiple queue strategies: bounded, unbounded, dropping, and sliding.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and to track changes.
 * A transaction will retry whenever a conflict is detected or whenever the transaction explicitly
 * calls `Effect.txRetry` and any of the accessed TxQueue values change.
 *
 * @since 4.0.0
 */
export * as TxQueue from "./TxQueue.ts"

/**
 * TxReentrantLock is a transactional read/write lock with reentrant semantics using Software
 * Transactional Memory (STM). Multiple readers can hold the lock concurrently, OR a single
 * writer can hold exclusive access. A fiber holding a write lock may acquire additional
 * read or write locks (reentrancy).
 *
 * @since 4.0.0
 */
export * as TxReentrantLock from "./TxReentrantLock.ts"

/**
 * TxRef is a transactional value, it can be read and modified within the body of a transaction.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and in order to
 * track changes, a transaction will retry whenever a conflict is detected or whenever the
 * transaction explicitely calls to `Effect.txRetry` and any of the accessed TxRef values
 * change.
 *
 * @since 4.0.0
 */
export * as TxRef from "./TxRef.ts"

/**
 * The `TxSemaphore` module provides a transactional semaphore for coordinating
 * access to limited resources from within Effect transactions. A semaphore
 * tracks a fixed number of permits, and transactional operations can acquire,
 * release, or inspect those permits atomically with other transactional state.
 *
 * Use `TxSemaphore` when permit accounting needs to compose with `TxRef` and
 * other transactional updates, such as guarding resource pools, rate-limited
 * sections, or workflows that must reserve capacity consistently before
 * committing related state changes.
 *
 * **Gotchas**
 *
 * - Permit operations are intended for transactional workflows and are wrapped
 *   with `Effect.tx`.
 * - The semaphore capacity is fixed at construction time; releasing more
 *   permits than the original capacity fails.
 * - Creating a semaphore with a negative number of permits defects.
 *
 * @since 4.0.0
 */
export * as TxSemaphore from "./TxSemaphore.ts"

/**
 * TxSubscriptionRef is a TxRef that allows subscribing to all committed changes. Subscribers
 * receive the current value followed by every subsequent update via a transactional queue.
 *
 * @since 4.0.0
 */
export * as TxSubscriptionRef from "./TxSubscriptionRef.ts"

/**
 * Type-level utility types for TypeScript.
 *
 * This module provides generic type aliases used throughout the Effect
 * ecosystem. Everything here is compile-time only — there are no runtime
 * values. Use these types to manipulate object shapes, tagged unions, tuples,
 * and variance markers at the type level.
 *
 * ## Mental model
 *
 * - **Tagged union**: a union of objects each having a discriminating
 *   `_tag: string` field. {@link Tags}, {@link ExtractTag}, and
 *   {@link ExcludeTag} operate on these.
 * - **Reason**: a nested error pattern where an error has a `reason` field
 *   containing a tagged union of sub-errors. {@link ReasonOf},
 *   {@link ReasonTags}, {@link ExtractReason}, and {@link ExcludeReason} work
 *   with this pattern.
 * - **Variance markers**: {@link Covariant}, {@link Contravariant}, and
 *   {@link Invariant} are function-type aliases encoding variance for phantom
 *   type parameters.
 * - **Simplify**: {@link Simplify} flattens intersection types (`A & B`) into
 *   a single object type for cleaner IDE tooltips.
 * - **Concurrency**: {@link Concurrency} is a union type
 *   (`number | "unbounded" | "inherit"`) used across Effect APIs that accept
 *   concurrency options.
 * - **Marker types**: {@link unassigned} and {@link unhandled} are branded
 *   interfaces used internally to represent missing or unhandled type
 *   parameters.
 *
 * ## Common tasks
 *
 * - Flatten an intersection for readability → {@link Simplify}
 * - Check type equality at compile time → {@link Equals} / {@link EqualsWith}
 * - Merge two object types → {@link MergeLeft} / {@link MergeRight}
 * - Work with tagged unions → {@link Tags} / {@link ExtractTag} / {@link ExcludeTag}
 * - Work with nested reason errors → {@link ReasonOf} / {@link ExtractReason}
 * - Create fixed-length tuples → {@link TupleOf} / {@link TupleOfAtLeast}
 * - Strip `readonly` modifiers → {@link Mutable} / {@link DeepMutable}
 * - Encode variance in phantom types → {@link Covariant} / {@link Contravariant} / {@link Invariant}
 * - Check if a type is a union → {@link IsUnion}
 *
 * ## Gotchas
 *
 * - {@link TupleOf} with a non-literal `number` (e.g. `TupleOf<number, string>`)
 *   degrades to `Array<string>`.
 * - {@link MergeRecord} is an alias for {@link MergeLeft}; prefer
 *   {@link MergeLeft} or {@link MergeRight} for clarity.
 * - {@link NoInfer} uses the `[A][A extends any ? 0 : never]` trick, not the
 *   built-in `NoInfer` from TypeScript 5.4+.
 * - {@link DeepMutable} recurses into `Map`, `Set`, arrays, and objects but
 *   stops at primitives and functions.
 *
 * @since 4.0.0
 */
export * as Types from "./Types.ts"

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
export * as UndefinedOr from "./UndefinedOr.ts"

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
export * as Unify from "./Unify.ts"

/**
 * Internal utilities for the Effect ecosystem's generator-based syntax and
 * higher-kinded type machinery.
 *
 * ## Mental model
 *
 * - **SingleShotGen** — an `IterableIterator` wrapper that yields its value
 *   exactly once. Used internally by `[Symbol.iterator]()` on Effect, Option,
 *   Result, and other yieldable types so they work inside generator functions.
 * - **Gen** — a type-level signature for generator-based monadic composition
 *   (`gen` functions). Parametric over any `TypeLambda` so each module
 *   (Effect, Option, Result, ...) can expose its own `gen` with correct types.
 * - **Variance** — a type-level marker that encodes the variance (covariant,
 *   contravariant, invariant) of a `TypeLambda`'s type parameters.
 *   Used by {@link Gen} for type inference.
 *
 * ## Common tasks
 *
 * - Make a type yieldable in generators -> implement `[Symbol.iterator]()` returning a {@link SingleShotGen}
 * - Define a generator-based API for a new TypeLambda -> type it as {@link Gen}`<MyTypeLambda>`
 * - Encode variance for a higher-kinded type -> use {@link Variance}
 *
 * ## Gotchas
 *
 * - {@link SingleShotGen} yields its value only on the first `.next()` call.
 *   Calling `.next()` again returns `{ done: true }`. Iterating the same
 *   instance twice will skip the value on the second pass; call
 *   `[Symbol.iterator]()` to get a fresh iterator.
 * - {@link Gen} and {@link Variance} are pure type-level constructs — they
 *   have no runtime representation.
 *
 * ## Quickstart
 *
 * **Example** (Using SingleShotGen to make a type yieldable)
 *
 * ```ts
 * import { Utils } from "effect"
 *
 * class MyWrapper<A> {
 *   constructor(readonly value: A) {}
 *   [Symbol.iterator]() {
 *     return new Utils.SingleShotGen<MyWrapper<A>, A>(this)
 *   }
 * }
 *
 * const w = new MyWrapper(42)
 * const iter = w[Symbol.iterator]()
 * console.log(iter.next(undefined as any))
 * // { value: MyWrapper { value: 42 }, done: false }
 * console.log(iter.next(42))
 * // { value: 42, done: true }
 * ```
 *
 * @see {@link SingleShotGen}
 * @see {@link Gen}
 * @see {@link Variance}
 *
 * @since 2.0.0
 */
export * as Utils from "./Utils.ts"
