import { Layer } from "effect"
import { CacheBackend, type EdgeCacheBackend, makeMemoryBackend } from "@maple/query-engine/caching"

// ---------------------------------------------------------------------------
// Concrete `CacheBackend` implementation for the API runtime.
//
// The edge-cache logic (and the pure in-memory fallback) lives in
// `@maple/query-engine/caching`; only the Cloudflare Workers backend lives here,
// so the Workers runtime API (`globalThis.caches`) never enters the query-engine
// package (and thus never the web/cli bundles). Prod uses the Workers cache;
// tests/dev fall back to the package's in-memory backend.
// ---------------------------------------------------------------------------

const SYNTHETIC_HOST = "https://maple-api.internal"

const buildCacheUrl = (bucket: string, hash: string): string => `${SYNTHETIC_HOST}/cache/${bucket}/${hash}`

const detectWorkersCache = (): Cache | null => {
	try {
		const g = globalThis as { caches?: { default?: Cache } }
		return g.caches?.default ?? null
	} catch {
		return null
	}
}

const makeWorkersBackend = (cache: Cache): EdgeCacheBackend => ({
	get: async (bucket, hash) => {
		const response = await cache.match(buildCacheUrl(bucket, hash))
		if (!response) return undefined
		try {
			return (await response.json()) as unknown
		} catch {
			return undefined
		}
	},
	put: async (bucket, hash, value, ttlSeconds) => {
		const body = JSON.stringify(value)
		const response = new Response(body, {
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": `max-age=${ttlSeconds}`,
			},
		})
		await cache.put(buildCacheUrl(bucket, hash), response)
	},
})

export const CacheBackendLive = Layer.sync(CacheBackend, () => {
	const workers = detectWorkersCache()
	return CacheBackend.of(workers ? makeWorkersBackend(workers) : makeMemoryBackend())
})
