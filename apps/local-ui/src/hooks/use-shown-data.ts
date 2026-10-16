import { useSyncExternalStore } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { standInSince } from "../lib/query-cache"

export interface ShownData {
	/** Any saved result exists, so the views have something to show without the server. */
	readonly hasCache: boolean
	/** Fetch time of the oldest result on screen, or null when nothing is shown. */
	readonly shownAsOfMs: number | null
	/** Fetch time of the oldest result standing in for one that has not loaded or failed to refresh. */
	readonly staleAsOfMs: number | null
	/** A shown result's refresh failed. */
	readonly refreshFailed: boolean
}

const isStatusQuery = (key: ReadonlyArray<unknown>) => key[1] === "server-status"

const minOf = (current: number | null, next: number) => (current === null || next < current ? next : current)

/** Last snapshot per client, so `useSyncExternalStore` gets the same object until a field changes. */
const lastSnapshot = new WeakMap<QueryClient, ShownData>()

function snapshot(client: QueryClient): ShownData {
	const cache = client.getQueryCache()
	const hasCache = cache
		.findAll({ queryKey: ["local"] })
		.some((query) => !isStatusQuery(query.queryKey) && query.state.data !== undefined)
	let shown: number | null = null
	let stale: number | null = null
	let failed = false
	for (const query of cache.findAll({ queryKey: ["local"], type: "active" })) {
		if (isStatusQuery(query.queryKey)) continue
		for (const observer of query.observers) {
			const result = observer.getCurrentResult()
			// A placeholder is the previous filter's rows while this one loads, not old data.
			if (result.data === undefined || result.isPlaceholderData) continue
			const at = standInSince(query) ?? query.state.dataUpdatedAt
			shown = minOf(shown, at)
			const waiting = standInSince(query) !== undefined || (result.isFetching && result.isStale)
			if (waiting || result.isError) stale = minOf(stale, at)
			if (result.isError) failed = true
		}
	}
	const previous = lastSnapshot.get(client)
	if (
		previous?.hasCache === hasCache &&
		previous.shownAsOfMs === shown &&
		previous.staleAsOfMs === stale &&
		previous.refreshFailed === failed
	)
		return previous
	const next: ShownData = { hasCache, shownAsOfMs: shown, staleAsOfMs: stale, refreshFailed: failed }
	lastSnapshot.set(client, next)
	return next
}

/** What the views currently show from the cache, and how old it is. */
export function useShownData(): ShownData {
	const client = useQueryClient()
	return useSyncExternalStore(
		(onChange) => client.getQueryCache().subscribe(onChange),
		() => snapshot(client),
	)
}
