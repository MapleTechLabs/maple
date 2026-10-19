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
	/** The value under `key` while `expiresAtMs - skewMs` is still in the future. */
	readonly get: (key: string, skewMs?: number) => Effect.Effect<Option.Option<A>>
	readonly set: (key: string, value: A, expiresAtMs: number) => Effect.Effect<void>
	readonly remove: (key: string) => Effect.Effect<void>
}

export const makeExpiringStore = <A>(): Effect.Effect<ExpiringStore<A>> =>
	Effect.map(Ref.make(HashMap.empty<string, Entry<A>>()), (ref) => ({
		get: (key, skewMs = 0) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const entries = yield* Ref.get(ref)
				return HashMap.get(entries, key).pipe(
					Option.filter((entry) => entry.expiresAtMs - skewMs > now),
					Option.map((entry) => entry.value),
				)
			}),
		set: (key, value, expiresAtMs) => Ref.update(ref, HashMap.set(key, { value, expiresAtMs })),
		remove: (key) => Ref.update(ref, HashMap.remove(key)),
	}))
