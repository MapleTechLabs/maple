import { localServerPortForLocation } from "@maple/local-ui/lib/constants"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Clock, Context, Duration, Effect, Layer, Option, Ref } from "effect"
import {
	asCacheValue,
	type CacheEntries,
	type CacheValue,
	type CacheEntry,
	hashKey,
	newestOlderWindow,
	parseSaved,
	type QueryKey,
	serialize,
	storageKeyFor,
} from "./cache-store"

// apps/local-ui/src/lib/query-cache.ts as a runtime resource: every result a page fetched, kept
// so a page opens on the newest one for its view, and saved in localStorage across reloads.

const SAVE_DELAY_MS = 2_000

/** A cached result: exact for the key, or an older window standing in for it. */
export type CacheHit = Readonly<{ data: CacheValue; updatedAtMs: number; isStandIn: boolean }>

/** The saved results this page was opened with (Flags: `hasCache` before anything loads). */
export const readSavedEntries: Effect.Effect<CacheEntries> = Effect.gen(function* () {
	const nowMs = yield* Clock.currentTimeMillis
	const key = storageKeyFor(localServerPortForLocation(window.location))
	return Option.match(readLocalStorage(key), { onNone: () => new Map(), onSome: (text) => parseSaved(text, nowMs) })
})

export class LocalQueryCache extends Context.Service<
	LocalQueryCache,
	{
		/** The exact result for `key`, else (windowed keys) its view's newest older window. */
		readonly lookup: (key: QueryKey) => Effect.Effect<Option.Option<CacheHit>>
		/** A fetch landed: keep it, and save shortly after (`persistQueryCache`). */
		readonly record: <A>(key: QueryKey, data: A, updatedAtMs: number) => Effect.Effect<void>
	}
>()("@maple/local-ui-foldkit/LocalQueryCache") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const storageKey = storageKeyFor(localServerPortForLocation(window.location))
			const entries = yield* Ref.make<CacheEntries>(yield* readSavedEntries)
			const isSaveScheduled = yield* Ref.make(false)
			const scope = yield* Effect.scope
			const save = Effect.flatMap(Ref.get(entries), (current) =>
				Effect.sync(() => writeLocalStorage(storageKey, serialize(current))),
			)
			// `visibilitychange` to hidden saves at once: the tab may not come back.
			const services = yield* Effect.context()
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					const onHide = () => {
						if (document.visibilityState === "hidden") Effect.runSyncWith(services)(save)
					}
					document.addEventListener("visibilitychange", onHide)
					return onHide
				}),
				(onHide) => Effect.sync(() => document.removeEventListener("visibilitychange", onHide)),
			)
			const scheduleSave = Effect.flatMap(
				Ref.getAndSet(isSaveScheduled, true),
				(wasScheduled) =>
					wasScheduled
						? Effect.void
						: Effect.asVoid(
								Effect.forkIn(
									Effect.andThen(Effect.sleep(Duration.millis(SAVE_DELAY_MS)), Effect.andThen(Ref.set(isSaveScheduled, false), save)),
									scope,
								),
							),
			)
			return {
				lookup: (key) =>
					Effect.map(Ref.get(entries), (current): Option.Option<CacheHit> => {
						const exact = Option.fromNullishOr(current.get(hashKey(key)))
						const toHit = (entry: CacheEntry, isStandIn: boolean): CacheHit => ({
							data: entry.data,
							updatedAtMs: entry.updatedAtMs,
							isStandIn,
						})
						return Option.isSome(exact)
							? Option.some(toHit(exact.value, false))
							: Option.map(newestOlderWindow(current, key), (entry) => toHit(entry, true))
					}),
				// Kept as `restore` would rebuild it, so a reload reads the same values back.
				record: (key, data, updatedAtMs) =>
					Option.match(asCacheValue(data), {
						onNone: () => Effect.void,
						onSome: (value) =>
							Effect.andThen(
								Ref.update(entries, (current) => new Map([...current, [hashKey(key), { key, data: value, updatedAtMs }]])),
								scheduleSave,
							),
					}),
			}
		}),
	)
}
