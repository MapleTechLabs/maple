// BOUNDARY-FILE: This module owns unparsed external values and narrows them before domain use.
import { Context, Effect, Layer, Schema } from "effect"

/** A storage failure reported by an `EdgeCacheBackend` operation. */
export class EdgeCacheBackendError extends Schema.TaggedError<EdgeCacheBackendError>()(
	"@maple/cache/EdgeCacheBackendError",
	{
		op: Schema.Literals(["get", "put", "delete"]),
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/**
 * Internal storage interface for the edge cache. The concrete implementation is
 * injected as a `CacheBackend` layer. The bundle-sensitive Cloudflare Workers
 * backend (which closes over `globalThis.caches`) lives in the host app; the
 * pure in-memory backend below ships here so tests/dev and non-Workers hosts
 * have a default without pulling a runtime binding into the package.
 */
export interface EdgeCacheBackend {
	/**
	 * Which storage is actually behind this backend, surfaced on every
	 * `EdgeCacheService.getOrCompute` span as `cache.backend`. Without it there is
	 * no signal distinguishing the shared Workers cache from the per-isolate
	 * `memory` fallback — which is silently selected whenever `caches` is
	 * undefined, and makes every cross-request hit disappear.
	 */
	readonly name: "workers-cache" | "memory"
	readonly get: (
		bucket: string,
		hash: string,
		nowMs: number,
	) => Effect.Effect<unknown, EdgeCacheBackendError>
	readonly put: (
		bucket: string,
		hash: string,
		value: unknown,
		ttlSeconds: number,
		nowMs: number,
	) => Effect.Effect<void, EdgeCacheBackendError>
	readonly delete: (bucket: string, hash: string) => Effect.Effect<void, EdgeCacheBackendError>
}

/**
 * Injected edge-cache storage backend (`caches.default` in prod, in-memory in
 * tests/dev).
 */
export class CacheBackend extends Context.Service<CacheBackend, EdgeCacheBackend>()(
	"@maple/cache/CacheBackend",
) {}

interface MemoryEntry {
	readonly value: unknown
	readonly expiresAt: number
}

/** The in-memory backend, plus how many entries it currently holds. */
export interface MemoryCacheBackend extends EdgeCacheBackend {
	readonly size: () => number
}

const MEMORY_SWEEP_MIN_ENTRIES = 256

/** A pure in-process `EdgeCacheBackend`, used for tests, dev, and non-Workers hosts. */
export const makeMemoryBackend = (): MemoryCacheBackend => {
	const store = new Map<string, MemoryEntry>()
	const composite = (bucket: string, hash: string) => `${bucket}:${hash}`
	let sweepAt = MEMORY_SWEEP_MIN_ENTRIES

	// Keys with a rotating part (`orgId:hour`) are never read again, so reads alone
	// would never evict them. Sweeping only once the map has doubled keeps `put` amortized O(1).
	const sweepExpired = (nowMs: number) => {
		if (store.size < sweepAt) return
		store.forEach((entry, key) => {
			if (entry.expiresAt <= nowMs) store.delete(key)
		})
		sweepAt = Math.max(MEMORY_SWEEP_MIN_ENTRIES, store.size * 2)
	}

	return {
		name: "memory",
		size: () => store.size,
		get: (bucket, hash, nowMs) =>
			Effect.sync(() => {
				const entry = store.get(composite(bucket, hash))
				if (!entry) return undefined
				if (entry.expiresAt <= nowMs) {
					store.delete(composite(bucket, hash))
					return undefined
				}
				return entry.value
			}),
		put: (bucket, hash, value, ttlSeconds, nowMs) =>
			Effect.sync(() => {
				const expiresAt = nowMs + ttlSeconds * 1000
				// A non-finite expiry would never compare as expired, so it is not stored.
				if (!Number.isFinite(expiresAt)) {
					store.delete(composite(bucket, hash))
					return
				}
				store.set(composite(bucket, hash), { value, expiresAt })
				sweepExpired(nowMs)
			}),
		delete: (bucket, hash) =>
			Effect.sync(() => {
				store.delete(composite(bucket, hash))
			}),
	}
}

/** `CacheBackend` layer backed by a fresh in-memory store. */
export const MemoryCacheBackendLive = Layer.sync(CacheBackend, () => CacheBackend.of(makeMemoryBackend()))
