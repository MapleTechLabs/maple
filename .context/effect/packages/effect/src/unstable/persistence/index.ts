/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Effectful key/value storage for persistence backends.
 *
 * This module defines the `KeyValueStore` service used by the persistence
 * package when a simple string or binary store is enough. It is useful for
 * lightweight durable state, browser storage, local file-backed data, SQL
 * tables, test stores, and as the storage primitive underneath higher-level
 * persistence APIs.
 *
 * Values are stored as strings or `Uint8Array`s, and `toSchemaStore` adds a
 * schema-aware JSON layer for typed values. Schema changes can make existing
 * JSON fail to decode, and `prefix` should be used to separate namespaces when
 * several logical stores share the same backend. This service does not provide
 * native TTL support; higher-level persistence layers encode expiration
 * metadata in stored values when they need TTLs.
 *
 * Backend behavior is intentionally small but not identical: Web Storage is
 * string-only, `makeStringOnly` stores binary values as base64, filesystem
 * keys become encoded file names, SQL stores value type metadata in a table,
 * and the memory layer is process-local. Choose keys, prefixes, table names,
 * and value formats with those backend constraints in mind.
 *
 * @since 4.0.0
 */
export * as KeyValueStore from "./KeyValueStore.ts"

/**
 * Defines the request-side contract used by the persistence layer.
 *
 * A `Persistable` request is a `PrimaryKey` value that carries the success and
 * error schemas needed to encode and decode the stored `Exit` for that request.
 * Persisted request resolvers and `PersistedCache` use this metadata to restore
 * previous lookup results from a backing store before running the lookup again.
 *
 * Use `Class` for cacheable or durable requests whose results can safely be
 * reused across fibers, processes, or restarts. The request primary key is the
 * entry id inside a persistence store, so it should be stable, collision-free,
 * and usually include a request-specific prefix. The `storeId` is configured on
 * `Persistence` or `PersistedCache`; it selects the backing store namespace and
 * is separate from the request primary key.
 *
 * Success and error schemas are encoded with the JSON codec, so persisted
 * values must be representable by those schemas and any required schema services
 * must be available where the store reads or writes entries. Changing a schema,
 * primary-key format, or store id can make existing persisted values fail to
 * decode or stop being found, so treat those changes as persistence migrations.
 *
 * @since 4.0.0
 */
export * as Persistable from "./Persistable.ts"

/**
 * Persistent caching for `Persistable` request keys.
 *
 * A `PersistedCache` combines a scoped in-memory `Cache` with a named
 * `Persistence` store. It is useful for expensive or idempotent lookups such as
 * remote API calls, database reads, and request results that should be reused
 * across fibers, process restarts, or multiple workers sharing the same backing
 * store.
 *
 * The persistent `timeToLive` is evaluated for the stored `Exit`, so successes
 * and failures can be cached with different lifetimes. The in-memory cache has
 * its own `inMemoryTTL` and capacity, and `invalidate` removes both the
 * persisted value and the in-memory entry. Persisted values are encoded with
 * the key's success and error schemas and stored under the key's primary key, so
 * schema changes, primary-key changes, or store-id collisions can make old
 * entries fail to decode until they are invalidated or written under a new
 * `storeId`.
 *
 * @since 4.0.0
 */
export * as PersistedCache from "./PersistedCache.ts"

/**
 * Schema-aware persisted queues for background work.
 *
 * A `PersistedQueue` stores JSON-encoded values in a named queue and lets
 * workers `take` one value at a time inside a scoped processing window. It is
 * useful for durable handoffs, background jobs, outbox-style integrations, and
 * workloads where failed work should be retried across fibers, process
 * restarts, or multiple workers sharing Redis or SQL.
 *
 * Delivery is at-least-once: a handler that fails, is interrupted, or loses its
 * backing-store lock may see the same element again until `maxAttempts` is
 * reached. Use stable custom ids when offering idempotent work, and choose ids
 * that are collision-free for the backing store because stores can enforce
 * uniqueness at the queue, prefix, or table level. Ordering is intentionally a
 * store-level concern; retries, lock expiration, polling, and multiple workers
 * can move entries behind newer work, so handlers should not rely on strict
 * FIFO processing.
 *
 * Values are encoded and decoded with the supplied schema using the JSON codec,
 * so schema services must be available when offering and taking values. Changing
 * a queue name, schema, Redis prefix, SQL table, or id format is a persistence
 * migration: old entries may decode differently, stop being visible, or collide
 * with new entries. The memory store is process-local and volatile, while Redis
 * and SQL stores use leases that should be tuned for the expected processing
 * time.
 *
 * @since 4.0.0
 */
export * as PersistedQueue from "./PersistedQueue.ts"

/**
 * Durable storage for encoded `Persistable` request results.
 *
 * The `Persistence` service creates scoped stores that read and write
 * schema-encoded `Exit` values keyed by each request's `PrimaryKey`. It is the
 * lower-level persistence layer used by `PersistedCache` and similar request
 * workflows to reuse expensive or idempotent lookup results across fibers,
 * process restarts, and workers that share a backing store.
 *
 * Each store is selected by a `storeId`, while each entry id comes from the
 * request's primary key. Keep both stable and collision-free: changing the
 * `storeId`, the primary-key format, or the success/error schemas is a
 * persistence migration, because old entries may stop being found or fail to
 * decode. Values are encoded with the request's success and error schemas using
 * the JSON codec, so any required schema services must be available at store
 * read and write time, and the backing value must stay JSON-compatible.
 *
 * TTLs are computed from the stored `Exit` and request key. Infinite TTLs are
 * stored without an expiration, finite TTLs become backing-store expirations,
 * and zero or negative TTLs skip the write entirely. Backing layers provide
 * process-local memory, `KeyValueStore`, Redis, and SQL implementations; store
 * ids are used as prefixes, table names, or SQL partitions and should be
 * chosen with the target backing store in mind.
 *
 * @since 4.0.0
 */
export * as Persistence from "./Persistence.ts"

/**
 * Persistent rate limiting for effects that need to coordinate token
 * consumption through a shared `RateLimiterStore`.
 *
 * The module exposes a `RateLimiter` service that can consume tokens for
 * string keys using either fixed-window counters or token-bucket state. It is
 * useful for protecting external APIs, enforcing per-user or per-tenant quotas,
 * throttling job workers, and coordinating limits across multiple fibers or
 * processes when they share the Redis-backed store. The helpers can fail fast
 * with `RateLimiterError`, return a delay to apply yourself, or wrap an effect
 * so it waits before continuing.
 *
 * Rate-limit keys and Redis prefixes are part of the persistence namespace, so
 * choose stable, collision-free values. The in-memory store is process-local
 * and is only coordinated inside one runtime, while the Redis store uses Lua
 * scripts for atomic updates under concurrent consumers. Time is measured with
 * the Effect `Clock`, windows are clamped to at least one millisecond, and
 * refill calculations use millisecond granularity.
 *
 * Fixed-window state is TTL-driven: rejected `fail` attempts do not extend the
 * current TTL, and Redis fixed-window keys expire automatically. Token-bucket
 * state keeps the remaining token count and last-refill time instead of using a
 * TTL, so high-cardinality dynamic keys may need an external cleanup or bounded
 * key strategy. With `onExceeded: "delay"`, overflow can be recorded so callers
 * should actually sleep for the returned delay, or use the provided accessors.
 *
 * @since 4.0.0
 */
export * as RateLimiter from "./RateLimiter.ts"

/**
 * Low-level Redis integration for the persistence modules.
 *
 * This module defines the `Redis` service used by Redis-backed persistence,
 * persisted queues, and rate limiter stores. It adapts an external Redis
 * connection to Effect through `send` for raw commands and `eval` for typed
 * Lua scripts that are loaded with `SCRIPT LOAD` and executed with `EVALSHA`.
 *
 * The service does not create or manage Redis connections; callers provide a
 * command sender from their Redis client or pool. Higher-level stores layer on
 * key prefixes and store ids, so choose stable prefixes to avoid collisions
 * and remember that schema or primary-key changes can make previously persisted
 * JSON values fail to decode. Finite TTLs in the persistence stores are applied
 * with millisecond Redis expirations, while non-finite TTLs are stored without
 * expiration. Script parameters are stringified before execution, and the
 * script descriptor's key count controls how Redis splits `KEYS` from `ARGV`.
 *
 * @since 4.0.0
 */
export * as Redis from "./Redis.ts"
