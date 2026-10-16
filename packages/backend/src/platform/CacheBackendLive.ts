// BOUNDARY: The Workers cache returns unparsed JSON; `EdgeCacheService` decodes it before domain use.
import { Effect, Layer, Metric } from "effect"
import { WorkersCache } from "@maple/infra/workers-cache"
import {
	CacheBackend,
	type EdgeCacheBackend,
	EdgeCacheBackendError,
	EdgeCacheService,
	makeMemoryBackend,
} from "@maple/cache"
import * as QueryEngineMetrics from "@maple/backend/observability/QueryEngineMetrics"

// Concrete `CacheBackend` implementation for the API runtime.
//
// The edge-cache logic (and the pure in-memory fallback) lives in
// `@maple/cache`; only the Cloudflare Workers backend lives here,
// so the Workers runtime API never enters the query-engine package (and thus
// never the web/cli bundles). The default cache is obtained via the
// `WorkersCache` Effect service from `@maple/infra/workers-cache` — prod gets the
// Workers cache; tests/dev get `null` and fall back to the in-memory backend.

const SYNTHETIC_HOST = "https://maple-api.internal"

const buildCacheUrl = (bucket: string, hash: string): string => `${SYNTHETIC_HOST}/cache/${bucket}/${hash}`

const backendError = (op: EdgeCacheBackendError["op"]) => (cause: unknown) =>
	new EdgeCacheBackendError({
		op,
		message: cause instanceof Error ? cause.message : String(cause),
		cause,
	})

const makeWorkersBackend = (cache: Cache): EdgeCacheBackend => ({
	name: "workers-cache",
	get: (bucket, hash) =>
		Effect.tryPromise({
			try: () => cache.match(buildCacheUrl(bucket, hash)),
			catch: backendError("get"),
		}).pipe(
			Effect.flatMap((response) =>
				response
					? // An unreadable body is an entry we cannot use: a miss, not a failure.
						Effect.tryPromise((): Promise<unknown> => response.json()).pipe(
							Effect.orElseSucceed(() => undefined),
						)
					: Effect.succeed(undefined),
			),
		),
	put: (bucket, hash, value, ttlSeconds) =>
		Effect.tryPromise({
			try: () =>
				cache.put(
					buildCacheUrl(bucket, hash),
					new Response(JSON.stringify(value), {
						headers: {
							"Content-Type": "application/json",
							"Cache-Control": `max-age=${ttlSeconds}`,
						},
					}),
				),
			catch: backendError("put"),
		}),
	delete: (bucket, hash) =>
		Effect.tryPromise({
			try: () => cache.delete(buildCacheUrl(bucket, hash)),
			catch: backendError("delete"),
		}).pipe(Effect.asVoid),
})

/**
 * Workers KV was trialled here as a second backend (#387, 2026-08-10) on the
 * theory that a KV `get` is a cancellable subrequest and so cheaper to abandon
 * than an uncancellable `cache.match()`. Prod measurement refuted it and it was
 * removed — see the note above `resolveCachedSettings` in
 * `OrgClickHouseSettingsService.ts` for the numbers. Don't reach for it again
 * without re-reading them.
 */
export const CacheBackendLive = Layer.effect(
	CacheBackend,
	Effect.gen(function* () {
		const cache = yield* WorkersCache
		if (!cache) {
			// The fallback is per-isolate, so nothing is shared across requests that
			// land elsewhere. Silent selection made this indistinguishable from a
			// working edge cache; log it once per isolate, count it so the condition
			// is visible in metrics rather than only in logs, and tag every span via
			// `cache.backend`.
			yield* Effect.logWarning(
				"Workers cache unavailable — edge cache falling back to per-isolate memory",
			)
			yield* Metric.update(QueryEngineMetrics.cacheBackendMemoryFallback, 1)
			return CacheBackend.of(makeMemoryBackend())
		}
		return CacheBackend.of(makeWorkersBackend(cache))
	}),
).pipe(Layer.provide(WorkersCache.layer))

/**
 * The edge cache over that backend, composed once: every graph in the Worker
 * shares this reference, so the read breaker behind it sees all the traffic
 * rather than a per-graph slice.
 */
export const EdgeCacheServiceLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))
