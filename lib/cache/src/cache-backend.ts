// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
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
	) => Effect.Effect<unknown | undefined, EdgeCacheBackendError>
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
 *
 * The tag string still names the old home. Tags are identity, not
 * documentation — `EdgeCacheIOError` next door is a `Schema.TaggedError`
 * whose tag is its serialized `_tag`, so renaming this family for tidiness
 * would be a wire-contract change for no behavioural gain.
 */
export class CacheBackend extends Context.Service<CacheBackend, EdgeCacheBackend>()(
	"@maple/cache/CacheBackend",
) {}

interface MemoryEntry {
	readonly value: unknown
	readonly expiresAt: number
}

/** A pure in-process `EdgeCacheBackend` — used for tests, dev, and non-Workers hosts. */
export const makeMemoryBackend = (): EdgeCacheBackend => {
	const store = new Map<string, MemoryEntry>()
	const composite = (bucket: string, hash: string) => `${bucket}:${hash}`

	return {
		name: "memory",
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
				store.set(composite(bucket, hash), {
					value,
					expiresAt: nowMs + ttlSeconds * 1000,
				})
			}),
		delete: (bucket, hash) =>
			Effect.sync(() => {
				store.delete(composite(bucket, hash))
			}),
	}
}

/** `CacheBackend` layer backed by a fresh in-memory store. */
export const MemoryCacheBackendLive = Layer.sync(CacheBackend, () => CacheBackend.of(makeMemoryBackend()))
