import { Context, Layer } from "effect"

/**
 * Internal storage interface for the edge cache. The concrete implementation is
 * injected as a `CacheBackend` layer. The bundle-sensitive Cloudflare Workers
 * backend (which closes over `globalThis.caches`) lives in the host app; the
 * pure in-memory backend below ships here so tests/dev and non-Workers hosts
 * have a default without pulling a runtime binding into the package.
 */
export interface EdgeCacheBackend {
	readonly get: (bucket: string, hash: string, nowMs: number) => Promise<unknown | undefined>
	readonly put: (
		bucket: string,
		hash: string,
		value: unknown,
		ttlSeconds: number,
		nowMs: number,
	) => Promise<void>
	readonly delete: (bucket: string, hash: string) => Promise<void>
}

/** Injected edge-cache storage backend (Workers KV in prod, in-memory in tests/dev). */
export class CacheBackend extends Context.Service<CacheBackend, EdgeCacheBackend>()(
	"@maple/query-engine/caching/CacheBackend",
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
		get: async (bucket, hash, nowMs) => {
			const entry = store.get(composite(bucket, hash))
			if (!entry) return undefined
			if (entry.expiresAt <= nowMs) {
				store.delete(composite(bucket, hash))
				return undefined
			}
			return entry.value
		},
		put: async (bucket, hash, value, ttlSeconds, nowMs) => {
			store.set(composite(bucket, hash), {
				value,
				expiresAt: nowMs + ttlSeconds * 1000,
			})
		},
		delete: async (bucket, hash) => {
			store.delete(composite(bucket, hash))
		},
	}
}

/** `CacheBackend` layer backed by a fresh in-memory store. */
export const MemoryCacheBackendLive = Layer.sync(CacheBackend, () => CacheBackend.of(makeMemoryBackend()))
