import { type CacheValue, decodeCacheValue, encodeCacheValue } from "../lib/cache-codec"
import { parseClickHouseDateTime } from "../lib/time"
import { trySync } from "@maple/ui/lib/try-sync"
import { Array, Option, Order, Schema } from "effect"

// The pure half of the result cache (query-cache.ts): query keys and their hash, the
// saved form in localStorage, and the "newest older window" a windowed query opens on.

/** What the cache codec rebuilds: plain data plus `DateTime.Utc`, `Option` and collections. */
export type { CacheValue }

/** A query key (`["local", "traces", filters, "start/end"]`). */
export type QueryKey = ReadonlyArray<unknown>

/** One result: the key, the hook's data (codec values rebuilt) and when it was fetched. */
export type CacheEntry = Readonly<{ key: QueryKey; data: CacheValue; updatedAtMs: number }>

/** By `hashKey(key)`. */
export type CacheEntries = ReadonlyMap<string, CacheEntry>

/** One per server port, as legacy keys it. */
export const storageKeyFor = (port: string): string => `maple-local:query-cache:${port}`

/** Saved results older than this are dropped on load. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** UTF-16 units; leaves room under the ~5M per-origin localStorage quota. */
const STORAGE_BUDGET = 2_000_000
const MAX_ENTRIES = 150

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
	if (value === null || typeof value !== "object") return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/** A key's hash: JSON with object keys sorted (undefined fields drop out). */
export const hashKey = (key: QueryKey): string =>
	JSON.stringify(key, (_, value: unknown) =>
		isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map((name) => [name, value[name]])) : value,
	)

/** Epoch ms of a `boundsKey` ("start/end") window, or none for any other key part. */
const windowOf = (part: unknown): Option.Option<Readonly<{ start: number; end: number }>> => {
	if (typeof part !== "string") return Option.none()
	const [start, end, extra] = part.split("/")
	if (start === undefined || end === undefined || extra !== undefined) return Option.none()
	const startMs = parseClickHouseDateTime(start)
	const endMs = parseClickHouseDateTime(end)
	return startMs === null || endMs === null ? Option.none() : Option.some({ start: startMs, end: endMs })
}

const byNewest = Order.mapInput(Order.flip(Order.Number), (entry: CacheEntry) => entry.updatedAtMs)

/**
 * `newestOlderWindow`: the same key except an earlier window of the same length as its last part.
 * Relative ranges re-anchor to the current minute on every page open, so a page would start empty.
 */
export const newestOlderWindow = (entries: CacheEntries, key: QueryKey): Option.Option<CacheEntry> =>
	Option.flatMap(windowOf(key.at(-1)), (window) => {
		const prefix = hashKey(key.slice(0, -1))
		const older = Array.fromIterable(entries.values()).filter(
			(entry) =>
				entry.key.length === key.length &&
				hashKey(entry.key.slice(0, -1)) === prefix &&
				Option.exists(
					windowOf(entry.key.at(-1)),
					(other) => other.end < window.end && other.end - other.start === window.end - window.start,
				),
		)
		return Array.head(Array.sort(older, byNewest))
	})

const SavedCache = Schema.Struct({
	version: Schema.Literal(1),
	entries: Schema.Array(Schema.Struct({ key: Schema.Array(Schema.Unknown), data: Schema.Unknown, updatedAt: Schema.Number })),
})
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(SavedCache))

/** `restoreQueryCache`: the saved results younger than a day; an entry the codec cannot rebuild is skipped. */
export const parseSaved = (text: string, nowMs: number): CacheEntries =>
	new Map(
		Option.match(decodeSaved(text), {
			onNone: () => [],
			onSome: (saved) =>
				Array.getSomes(
					saved.entries
						.filter((entry) => nowMs - entry.updatedAt <= MAX_AGE_MS)
						.map((entry) =>
							trySync((): readonly [string, CacheEntry] => {
								const key = entry.key.map(decodeCacheValue)
								return [hashKey(key), { key, data: decodeCacheValue(entry.data), updatedAtMs: entry.updatedAt }]
							}),
						),
				),
		}),
	)

/** What `restore` would rebuild from `data`: none when the codec cannot encode it (`serialize` skips it). */
export const asCacheValue = <A>(data: A): Option.Option<CacheValue> => Option.map(encodeCacheValue(data), decodeCacheValue)

/** `serializeQueryCache`: the newest results that fit the budget, in legacy's saved form. */
export const serialize = (entries: CacheEntries): string => {
	const encoded = Array.getSomes(
		Array.sort(Array.fromIterable(entries.values()), byNewest).map((entry) =>
			Option.zipWith(encodeCacheValue(entry.key), encodeCacheValue(entry.data), (key, data) =>
				JSON.stringify({ key, data, updatedAt: entry.updatedAtMs }),
			),
		),
	)
	const kept = encoded.reduce<{ readonly items: ReadonlyArray<string>; readonly size: number }>(
		(acc, item) =>
			acc.items.length >= MAX_ENTRIES || acc.size + item.length > STORAGE_BUDGET
				? acc
				: { items: [...acc.items, item], size: acc.size + item.length },
		{ items: [], size: 0 },
	)
	return `{"version":1,"entries":[${kept.items.join(",")}]}`
}

/** The client's `gcTime`: a result nothing has read or written for an hour leaves the cache. */
export const GC_MS = 60 * 60 * 1000

/** `gcTime` applied: the entries used (read or written) within the last hour, by `lastUsedAtMs`. */
export const dropUnused = (
	entries: CacheEntries,
	lastUsedAtMs: ReadonlyMap<string, number>,
	nowMs: number,
): CacheEntries =>
	new Map(Array.filter(Array.fromIterable(entries), ([hash]) => nowMs - (lastUsedAtMs.get(hash) ?? 0) < GC_MS))
