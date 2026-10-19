/**
 * Keyed values that expire, held in a Ref. A store made once and provided to every event outlives
 * the event's layer, which is how a Worker keeps a cache for the isolate instead of the batch.
 */
import { Clock, Effect, HashMap, Option, Ref } from "effect"

interface Entry<A> {
	readonly value: A
	readonly expiresAtMs: number
}

export interface ExpiringStore<A> {
	/** The value under `key` while `expiresAtMs - skewMs` is still in the future; else it is evicted. */
	readonly get: (key: string, skewMs?: number) => Effect.Effect<Option.Option<A>>
	readonly set: (key: string, value: A, expiresAtMs: number) => Effect.Effect<void>
	readonly remove: (key: string) => Effect.Effect<void>
	/** Evicts every entry whose value matches, for a caller that holds the value but not its key. */
	readonly removeWhere: (predicate: (value: A) => boolean) => Effect.Effect<void>
	/** Entries held, expired ones not yet evicted included. */
	readonly size: Effect.Effect<number>
}

/** Enough for every installation or org one isolate serves; past it, expired entries go first. */
const DEFAULT_MAX_ENTRIES = 1_000

/** Drops expired entries, then the soonest to expire, until one more fits under `maxEntries`. */
const makeRoom = <A>(entries: HashMap.HashMap<string, Entry<A>>, now: number, maxEntries: number) => {
	if (HashMap.size(entries) < maxEntries) return entries
	const live = HashMap.filter(entries, (entry) => entry.expiresAtMs > now)
	if (HashMap.size(live) < maxEntries) return live
	const byExpiry = Array.from(live).sort(([, a], [, b]) => a.expiresAtMs - b.expiresAtMs)
	return HashMap.removeMany(
		live,
		byExpiry.slice(0, HashMap.size(live) - maxEntries + 1).map(([key]) => key),
	)
}

export const makeExpiringStore = <A>(maxEntries = DEFAULT_MAX_ENTRIES): Effect.Effect<ExpiringStore<A>> =>
	Effect.map(Ref.make(HashMap.empty<string, Entry<A>>()), (ref) => ({
		get: (key, skewMs = 0) =>
			Effect.flatMap(Clock.currentTimeMillis, (now) =>
				// One modify, so an entry refreshed concurrently is never the one evicted.
				Ref.modify(ref, (entries) => {
					const entry = HashMap.get(entries, key)
					if (Option.isNone(entry)) return [Option.none<A>(), entries]
					return entry.value.expiresAtMs - skewMs > now
						? [Option.some(entry.value.value), entries]
						: [Option.none<A>(), HashMap.remove(entries, key)]
				}),
			),
		set: (key, value, expiresAtMs) =>
			Effect.flatMap(Clock.currentTimeMillis, (now) =>
				Ref.update(ref, (entries) =>
					HashMap.set(
						HashMap.has(entries, key) ? entries : makeRoom(entries, now, maxEntries),
						key,
						{ value, expiresAtMs },
					),
				),
			),
		remove: (key) => Ref.update(ref, HashMap.remove(key)),
		removeWhere: (predicate) =>
			Ref.update(
				ref,
				HashMap.filter((entry) => !predicate(entry.value)),
			),
		size: Effect.map(Ref.get(ref), HashMap.size),
	}))
