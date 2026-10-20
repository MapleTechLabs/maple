import { Clock, Effect, Option, Schema } from "effect"
import type { CacheValue, QueryKey } from "./cache-store"
import { LocalQueryCache } from "./query-cache"

// What a page's fetch Command does with the result cache: read before fetching, record after.

/** The client's default `staleTime`: a younger exact result is shown without a refetch. */
export const STALE_MS = 30_000

/** A cached result decoded for a slot; `isFresh` means no fetch follows. */
export const CachedOf = <S extends Schema.Top>(data: S) =>
	Schema.Struct({ data, updatedAtMs: Schema.Number, isStandIn: Schema.Boolean, isFresh: Schema.Boolean })
export type Cached<A> = Readonly<{ data: A; updatedAtMs: number; isStandIn: boolean; isFresh: boolean }>

/** The cached data as the slot's type, or none when it has another shape (an older build's). */
export const cachedAs =
	<S extends Schema.Top>(schema: S) =>
	(value: CacheValue): Option.Option<S["Type"]> =>
		Schema.is(Schema.toType(schema))(value) ? Option.some(value) : Option.none()

export const readCached = <A>(
	key: QueryKey,
	fromCached: (value: CacheValue) => Option.Option<A>,
	staleMs = STALE_MS,
): Effect.Effect<Option.Option<Cached<A>>, never, LocalQueryCache> =>
	Effect.gen(function* () {
		const hit = yield* (yield* LocalQueryCache).lookup(key)
		const nowMs = yield* Clock.currentTimeMillis
		return Option.flatMap(hit, (found) =>
			Option.map(fromCached(found.data), (data) => ({
				data,
				updatedAtMs: found.updatedAtMs,
				isStandIn: found.isStandIn,
				isFresh: !found.isStandIn && nowMs - found.updatedAtMs < staleMs,
			})),
		)
	})

/**
 * A fetch Command's body with the cache in front: with `readsCache`, a cached answer comes back
 * first (`found`); else the fetch runs and its result is recorded (`succeeded`).
 */
export const withCache = <A, B, Found, Succeeded, E, R>(
	options: Readonly<{
		key: QueryKey
		readsCache: boolean
		fromCached: (value: CacheValue) => Option.Option<A>
		staleMs?: number
		toCached: (data: A) => B
		fetch: Effect.Effect<A, E, R>
		found: (cached: Cached<A>) => Found
		succeeded: (data: A, fetchedAtMs: number) => Succeeded
	}>,
): Effect.Effect<Found | Succeeded, E, R | LocalQueryCache> =>
	Effect.gen(function* () {
		const maybeCached = options.readsCache ? yield* readCached(options.key, options.fromCached, options.staleMs) : Option.none()
		if (Option.isSome(maybeCached)) return options.found(maybeCached.value)
		const data = yield* options.fetch
		const fetchedAtMs = yield* Clock.currentTimeMillis
		yield* recordCached(options.key, options.toCached(data), fetchedAtMs)
		return options.succeeded(data, fetchedAtMs)
	})

export const recordCached =<A>(key: QueryKey, data: A, updatedAtMs: number): Effect.Effect<void, never, LocalQueryCache> =>
	Effect.gen(function* () {
		yield* (yield* LocalQueryCache).record(key, data, updatedAtMs)
	})
