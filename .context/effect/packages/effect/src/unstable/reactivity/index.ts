/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * The `AsyncResult` module models the state of an asynchronous value inside the
 * reactivity APIs. It represents whether a computation has not produced a
 * result yet, has succeeded, or has failed, while keeping `waiting` as a
 * separate flag for first loads, refreshes, retries, and other in-flight work.
 *
 * This is useful for atoms and UI integrations that need to render async
 * queries, background refreshes, optimistic transitions, stream pulls, or RPC
 * and HTTP calls without losing track of the current value. `Success` contains
 * the latest value and timestamp, and `Failure` contains a `Cause` plus an
 * optional `previousSuccess` so callers can keep showing stale data after a
 * refresh fails.
 *
 * Treat `waiting` as an overlay rather than a fourth state: an `Initial` result
 * can be waiting with no value, and a `Success` or `Failure` can also be waiting
 * while a newer computation is running. Accessors such as `value` and
 * `getOrElse` may return the previous success stored in a failure, so inspect
 * `cause` or `error` when the difference between a current success and stale
 * data matters. Matchers such as `matchWithWaiting` prioritize the waiting flag,
 * while `match` and `matchWithError` expose the underlying state.
 *
 * @since 4.0.0
 */
export * as AsyncResult from "./AsyncResult.ts"

/**
 * The `Atom` module defines reactive values and the helpers for constructing,
 * composing, running, and persisting them with an `AtomRegistry`. Atoms are
 * small read functions whose regular `get` reads form a dependency graph, so
 * derived values are cached by the registry and invalidated when their
 * dependencies, writable state, refresh hooks, or subscriptions change.
 *
 * Use atoms for application and UI state, derived data, `Effect` or `Stream`
 * queries exposed as `AsyncResult`, writable function atoms for commands,
 * subscription refs, pull-based streams, optimistic updates, URL search
 * parameters, `KeyValueStore` entries, and serializable or server-specific
 * hydration.
 *
 * The cache belongs to the registry, not the atom object: the same atom can have
 * different values in different registries, and serializable atoms are keyed by
 * their serialization key. Stable atom identity matters for dependency tracking
 * and cache reuse, so use `family` for parameterized atoms. Unobserved atoms are
 * disposed unless kept alive or retained by an idle TTL, which can cause derived
 * state, effects, streams, and finalizers to be rebuilt later. Runtime-backed
 * atoms run effects and streams with the registry scheduler, scope, and
 * `AtomRuntime` layer context; `runtime.withReactivity` only refreshes after
 * explicit `Reactivity` invalidations, while one-shot reads such as `once` do
 * not create dependency edges.
 *
 * @since 4.0.0
 */
export * as Atom from "./Atom.ts"

/**
 * The `AtomHttpApi` module adapts typed `HttpApi` clients to the unstable atom
 * reactivity runtime. Use it to define a `Context.Service` whose generated HTTP
 * API client is available directly and whose endpoints can also be invoked as
 * atoms: `query` creates an atom of `AsyncResult` for reads, while `mutation`
 * creates an `AtomResultFn` for writes.
 *
 * It is intended for applications that want server state to participate in atom
 * caching, invalidation, and hydration. Queries can be associated with
 * `reactivityKeys` so they refresh when those keys are invalidated, mutations can
 * invalidate the same keys after the request succeeds, and `timeToLive` controls
 * whether idle query atoms expire, stay alive for a duration, or are kept alive.
 *
 * Serialization is schema-based and intentionally limited to decoded values.
 * Mutation atoms are serializable only in `"decoded-only"` mode, while query
 * atoms are serializable only in `"decoded-only"` mode when a stable
 * `serializationKey` is supplied. Choose serialization keys that uniquely
 * identify the endpoint request, keep reactivity keys stable across client and
 * server registries during hydration, and avoid serializing response modes that
 * expose raw `HttpClientResponse` values.
 *
 * The service wraps `HttpApiClient.make`, so the same `HttpApi` definition,
 * schemas, base URL, middleware services, and HTTP client layer must be available
 * wherever the atom runtime is constructed. Use `transformClient` and
 * `transformResponse` for cross-cutting client behavior, and remember that
 * schema or low-level HTTP client failures are raised as defects while endpoint
 * and middleware failures remain typed errors.
 *
 * @since 4.0.0
 */
export * as AtomHttpApi from "./AtomHttpApi.ts"

/**
 * Mutable reactive references for local, in-memory state that should be read,
 * updated, and observed without going through an `AtomRegistry`.
 *
 * `AtomRef` is useful for small state models, form-like state, and collections
 * of item references where callers need direct mutation methods together with
 * subscriptions. A ref exposes its current `value`, notifies subscribers after
 * `set` or `update`, can derive read-only views with `map`, and can focus on
 * nested object or array properties with `prop`.
 *
 * Notifications are equality-aware: setting a value that is `Equal.equals` to
 * the current value is ignored, and mapped or property subscriptions only emit
 * when their derived value changes. Mutate state through `set`, `update`, or a
 * property ref so subscribers are notified; direct mutation of the stored value
 * does not notify listeners. Collection subscribers are notified when items are
 * inserted, removed, or when an item ref changes, while `toArray` returns the
 * current raw item values.
 *
 * @since 4.0.0
 */
export * as AtomRef from "./AtomRef.ts"

/**
 * The `AtomRegistry` module provides the runtime cache used by reactivity
 * atoms. A registry owns the node graph for a group of atoms, stores their
 * current values, records parent/child dependencies while atoms are read, and
 * coordinates writes, refreshes, stream conversions, and node disposal.
 *
 * Create a registry directly with {@link make} or provide it with {@link layer}
 * or {@link layerOptions} when a UI root, request, test, or other Effect scope
 * needs its own atom state. The same atom can have different cached values in
 * different registries, while serializable atoms are keyed by their
 * serialization key so preloaded values can hydrate a node before its first
 * read.
 *
 * Subscriptions and {@link mount} keep nodes alive and must be released when
 * the consumer is done; scoped helpers install finalizers for this. Unobserved
 * non-`keepAlive` atoms may be removed immediately or after their `idleTTL` (or
 * the registry `defaultIdleTTL`), which means later reads can rebuild derived
 * state. Disposing a registry clears its cache and makes future atom access an
 * error.
 *
 * @since 4.0.0
 */
export * as AtomRegistry from "./AtomRegistry.ts"

/**
 * The `AtomRpc` module connects typed RPC clients to the atom reactivity
 * runtime. It builds a `Context.Service` that exposes the flattened
 * `RpcClient`, an `AtomRuntime`, mutation helpers, and query helpers for every
 * RPC in an `RpcGroup`.
 *
 * Use it when remote read models should be represented as atoms, mutations
 * should refresh affected reads through `Reactivity` keys, or non-streaming
 * query results need serialization metadata for hydration. The RPC `protocol`
 * layer supplies the transport, and may be static or derived from the current
 * atom context, so request headers, transport dependencies, and client
 * middleware remain part of the normal Effect environment.
 *
 * Non-streaming queries produce atoms of `AsyncResult` values. Supplying a
 * `serializationKey` marks those query atoms as serializable using codecs
 * derived from the RPC success schema and the combined RPC, middleware, and
 * client error schemas; choose stable, unique keys when dehydrating. Streaming
 * RPCs produce writable pull atoms instead, so callers advance the stream by
 * writing to the atom and should not expect serialization metadata. Query family
 * caching includes the payload, normalized headers, reactivity keys, TTL, and
 * serialization key, so use stable values for those inputs when atom identity
 * matters.
 *
 * @since 4.0.0
 */
export * as AtomRpc from "./AtomRpc.ts"

/**
 * Utilities for moving serializable reactivity state between atom registries.
 *
 * `dehydrate` snapshots atoms marked with `Atom.serializable` from an
 * `AtomRegistry`, preserving their serialization keys, encoded values, and
 * dehydration time so another registry can preload the same state with `hydrate`.
 * This is useful for server rendering, browser bootstrapping, route transitions,
 * and other handoffs where a registry should start from values that were already
 * computed elsewhere.
 *
 * Only serializable atoms are included, and the receiving registry needs atoms
 * with matching stable keys and compatible schemas. Values crossing a
 * client/server boundary should be the encoded JSON-safe values produced by the
 * atom codecs. The optional `resultPromise` used for `AsyncResult.Initial`
 * handoffs is a live JavaScript promise, so it cannot be sent through JSON and
 * should be omitted or replaced by an application-level streaming protocol when
 * dehydrated state leaves the current runtime.
 *
 * @since 4.0.0
 */
export * as Hydration from "./Hydration.ts"

/**
 * The `Reactivity` module provides an in-memory service for connecting writes to
 * dependent reads through explicit invalidation keys. It is useful for keeping
 * query results, UI subscriptions, read models, or other derived views fresh
 * after mutations without coupling the writer to every consumer that should
 * rerun.
 *
 * Reads are modeled with {@link query} and {@link stream}: the effect runs once
 * immediately and then runs again whenever one of its keys is invalidated.
 * Writes can use {@link mutation} to invalidate keys only after the wrapped
 * effect succeeds, or call {@link invalidate} directly. Keys may be supplied as
 * a flat collection or as a record of namespaces with ids, which lets callers
 * invalidate both broad groups and individual records.
 *
 * The service tracks handlers by hashed keys and does not cache values by
 * itself; consumers receive fresh queue or stream emissions and decide how to
 * store them. Registrations are tied to the surrounding scope, failures from a
 * query fail the queue or stream, and invalidations that arrive while a query is
 * already running schedule a single follow-up run. Use stable key values, be
 * aware that the default layer is process-local, and use the {@link Reactivity}
 * service when many invalidations should be coalesced until the batch exits.
 *
 * @since 4.0.0
 */
export * as Reactivity from "./Reactivity.ts"
