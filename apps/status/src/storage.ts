import type * as cf from "@cloudflare/workers-types"
import { Effect } from "effect"
import { type CachedValue, type StatusStorage, StatusStorageError } from "./ports"

/** How long the colo cache keeps a copy for the last-resort fallback; freshness is judged separately. */
const CACHE_RETAIN_SECONDS = 7 * 24 * 60 * 60
const STORED_AT_HEADER = "x-maple-stored-at"

export interface StatusBindings {
	readonly kv: cf.KVNamespace
	readonly bucket: cf.R2Bucket
	readonly limiter: cf.RateLimit
	// The global (DOM) Cache type: `caches.open` returns it and it accepts a global Response.
	readonly cache: Promise<Cache>
}

const call = <A>(store: StatusStorageError["store"], key: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new StatusStorageError({ message: `${store} call failed`, store, key, cause }),
	})

/** `StatusStorage` over the Worker's native bindings and the Cache API. */
export const nativeStorage = (bindings: StatusBindings): StatusStorage => {
	const cache = (key: string) => call("cache", key, () => bindings.cache)
	return {
		kvGet: (key) => call("kv", key, () => bindings.kv.get(key, "text")),
		kvPut: (key, value) => call("kv", key, () => bindings.kv.put(key, value)),
		r2Get: (key) =>
			call("r2", key, () => bindings.bucket.get(key)).pipe(
				Effect.flatMap((object) =>
					object === null ? Effect.succeed(null) : call("r2", key, () => object.text()),
				),
			),
		cacheGet: (key) =>
			cache(key).pipe(
				Effect.flatMap((store) => call("cache", key, () => store.match(key))),
				Effect.flatMap((response): Effect.Effect<CachedValue | null, StatusStorageError> => {
					if (response === undefined) return Effect.succeed(null)
					const storedAt = Number(response.headers.get(STORED_AT_HEADER) ?? "0")
					return call("cache", key, () => response.text()).pipe(
						Effect.map((value) => ({ value, storedAt })),
					)
				}),
			),
		cachePut: (key, entry) =>
			cache(key).pipe(
				Effect.flatMap((store) =>
					call("cache", key, () =>
						store.put(
							key,
							new Response(entry.value, {
								headers: {
									"cache-control": `public, max-age=${CACHE_RETAIN_SECONDS}`,
									[STORED_AT_HEADER]: String(entry.storedAt),
								},
							}),
						),
					),
				),
			),
		rateLimit: (key) =>
			call("rate-limit", key, () => bindings.limiter.limit({ key })).pipe(
				Effect.map((outcome) => outcome.success),
			),
	}
}
