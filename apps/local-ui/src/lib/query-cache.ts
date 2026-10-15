// Keeps the dashboard readable while the server is busy or gone. chDB answers
// one query at a time, so under load a new page can wait 20s+ for its rows.
// Pages therefore open on the newest cached result for the same view, and the
// cache is saved in the browser so a reload (or a stopped server) still shows
// the last results.

import {
	hashKey,
	keepPreviousData,
	QueryClient,
	type DefaultedQueryObserverOptions,
	type DefaultError,
	type Query,
	type QueryKey,
	type QueryObserverOptions,
} from "@tanstack/react-query"
import { Option, Schema } from "effect"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { trySync } from "@maple/ui/lib/try-sync"
import { decodeCacheValue, encodeCacheValue } from "./cache-codec"
import { parseClickHouseDateTime } from "./time"

const STATUS_KEY_PART = "server-status"
const WINDOWED_META = "maple-local/windowed"
/** Saved results older than this are dropped on load. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** UTF-16 units; leaves room under the ~5M per-origin localStorage quota. */
const STORAGE_BUDGET = 2_000_000
const MAX_ENTRIES = 150
const SAVE_DELAY_MS = 2_000

/**
 * Queries opened on an older window's result, by query hash: the data they were
 * given and when it was fetched. A query stops being a stand-in once a fetch
 * replaces that data.
 */
const standIns = new Map<string, { readonly data: unknown; readonly updatedAt: number }>()

/** Epoch ms of a `boundsKey` ("start/end") window, or null for any other key part. */
const windowOf = (part: unknown): { readonly start: number; readonly end: number } | null => {
	if (typeof part !== "string") return null
	const [start, end, extra] = part.split("/")
	if (start === undefined || end === undefined || extra !== undefined) return null
	const startMs = parseClickHouseDateTime(start)
	const endMs = parseClickHouseDateTime(end)
	return startMs === null || endMs === null ? null : { start: startMs, end: endMs }
}

/**
 * The newest cached query for `queryKey`'s view: same key except an earlier
 * window of the same length as its last part. Relative ranges re-anchor to the
 * current minute on every page open, so without this a page always starts empty.
 */
function newestOlderWindow(client: QueryClient, queryKey: QueryKey): Query | undefined {
	const window = windowOf(queryKey.at(-1))
	if (window === null) return undefined
	return client
		.getQueryCache()
		.findAll({ queryKey: queryKey.slice(0, -1) })
		.filter((query) => {
			if (query.queryKey.length !== queryKey.length || query.state.data === undefined) return false
			if (standInSince(query) !== undefined) return false
			const other = windowOf(query.queryKey.at(-1))
			return (
				other !== null &&
				other.end < window.end &&
				other.end - other.start === window.end - window.start
			)
		})
		.sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0]
}

/** The result `queryKey` opens on: its view's newest older window, recorded as a stand-in. */
export function olderWindowData<T>(client: QueryClient, queryKey: QueryKey): T | undefined {
	const source = newestOlderWindow(client, queryKey)
	if (source === undefined) return undefined
	const data = client.getQueryData<T>(source.queryKey)
	standIns.set(hashKey(queryKey), { data, updatedAt: source.state.dataUpdatedAt })
	return data
}

/** When the older window behind `queryKey`'s stand-in was fetched. */
export const olderWindowUpdatedAt = (client: QueryClient, queryKey: QueryKey): number | undefined =>
	newestOlderWindow(client, queryKey)?.state.dataUpdatedAt

/** When the result `query` shows was fetched, if it is still an older window's stand-in. */
export function standInSince(query: {
	readonly queryHash: string
	readonly state: { readonly data: unknown; readonly dataUpdatedAt: number }
}): number | undefined {
	const standIn = standIns.get(query.queryHash)
	if (standIn === undefined) return undefined
	// Structural sharing keeps the reference when a refetch returns equal rows,
	// but every successful fetch moves `dataUpdatedAt`.
	if (standIn.data === query.state.data && query.state.dataUpdatedAt === standIn.updatedAt)
		return standIn.updatedAt
	standIns.delete(query.queryHash)
	return undefined
}

/**
 * Options for a query whose key ends in `boundsKey(bounds)`. A filter change
 * keeps the previous filter's rows until the new ones arrive; a new window opens
 * on its view's newest older result (see `LocalQueryClient`).
 */
export const windowed = <const K extends QueryKey>(queryKey: K) => ({
	queryKey,
	meta: { [WINDOWED_META]: true },
	placeholderData: keepPreviousData,
})

/**
 * Opens windowed queries on their view's newest older result. That result is
 * the query's data, not a placeholder, so it stays on screen when the fetch
 * fails; it counts as stale at once, so the fetch still starts immediately.
 */
export class LocalQueryClient extends QueryClient {
	override defaultQueryOptions<
		TQueryFnData = unknown,
		TError = DefaultError,
		TData = TQueryFnData,
		TQueryData = TQueryFnData,
		TQueryKey extends QueryKey = QueryKey,
		TPageParam = never,
	>(
		options:
			| QueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey, TPageParam>
			| DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>,
	): DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey> {
		const defaulted = super.defaultQueryOptions(options)
		if (defaulted.meta?.[WINDOWED_META] !== true || defaulted.initialData !== undefined) return defaulted
		const { queryKey, staleTime } = defaulted
		return {
			...defaulted,
			initialData: () => olderWindowData<TQueryData>(this, queryKey),
			initialDataUpdatedAt: () => olderWindowUpdatedAt(this, queryKey),
			staleTime: (query) =>
				standInSince(query) !== undefined
					? 0
					: typeof staleTime === "function"
						? staleTime(query)
						: (staleTime ?? 0),
		}
	}
}

const isPersistable = (query: Query): boolean =>
	query.queryKey[0] === "local" &&
	query.queryKey[1] !== STATUS_KEY_PART &&
	query.state.data !== undefined &&
	standInSince(query) === undefined &&
	query.state.dataUpdatedAt > 0

const SavedCache = Schema.Struct({
	version: Schema.Literal(1),
	entries: Schema.Array(
		Schema.Struct({
			key: Schema.Array(Schema.Unknown),
			data: Schema.Unknown,
			updatedAt: Schema.Number,
		}),
	),
})
const decodeSaved = Schema.decodeUnknownOption(SavedCache)

const parseJson = (text: string): Option.Option<unknown> => trySync(() => JSON.parse(text))

/** Put saved results back into the cache. They load as stale, so a mounted view still refetches. */
export function restoreQueryCache(client: QueryClient, storageKey: string, now = Date.now()): void {
	const saved = Option.flatMap(Option.flatMap(readLocalStorage(storageKey), parseJson), decodeSaved)
	if (Option.isNone(saved)) return
	for (const entry of saved.value.entries) {
		if (now - entry.updatedAt > MAX_AGE_MS) continue
		// Storage can hold edited or corrupt values (`BigInt("abc")` throws); skip that entry, not startup.
		const decoded = trySync(() => ({
			queryKey: entry.key.map(decodeCacheValue),
			data: decodeCacheValue(entry.data),
		}))
		if (Option.isNone(decoded)) continue
		const { queryKey, data } = decoded.value
		if (client.getQueryState(queryKey)?.data !== undefined) continue
		client.setQueryData(queryKey, data, { updatedAt: entry.updatedAt })
	}
}

/** Serialize the newest results that fit the storage budget. */
export function serializeQueryCache(client: QueryClient): string {
	const queries = client
		.getQueryCache()
		.getAll()
		.filter(isPersistable)
		.sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
	const entries: Array<string> = []
	let size = 0
	for (const query of queries) {
		if (entries.length >= MAX_ENTRIES) break
		const key = encodeCacheValue(query.queryKey)
		const data = encodeCacheValue(query.state.data)
		if (Option.isNone(key) || Option.isNone(data)) continue
		const entry = JSON.stringify({
			key: key.value,
			data: data.value,
			updatedAt: query.state.dataUpdatedAt,
		})
		if (size + entry.length > STORAGE_BUDGET) continue
		size += entry.length
		entries.push(entry)
	}
	return `{"version":1,"entries":[${entries.join(",")}]}`
}

/** Save the cache shortly after results change, and when the page is hidden. Returns the unsubscribe. */
export function persistQueryCache(client: QueryClient, storageKey: string): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined
	const save = () => {
		timer = undefined
		writeLocalStorage(storageKey, serializeQueryCache(client))
	}
	const unsubscribe = client.getQueryCache().subscribe((event) => {
		if (event.type !== "updated" || event.action.type !== "success" || timer !== undefined) return
		if (!isPersistable(event.query)) return
		timer = setTimeout(save, SAVE_DELAY_MS)
	})
	const onHide = () => {
		if (document.visibilityState === "hidden") save()
	}
	document.addEventListener("visibilitychange", onHide)
	return () => {
		unsubscribe()
		document.removeEventListener("visibilitychange", onHide)
		if (timer !== undefined) clearTimeout(timer)
	}
}
