import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"

const PAGE_SIZE = 50

export interface SessionFilters {
	service?: string
	browser?: string
	device?: string
	/** Only sessions with at least one recorded error. */
	errorsOnly?: boolean
	/** Substring match on the initial page URL. */
	search?: string
	/** Time-range preset key (see `TIME_RANGES`). */
	range?: string
}

/** Infinite list of browser sessions, newest first (keyset on StartTime). */
export function useLocalSessions(filters: SessionFilters) {
	return useInfiniteQuery({
		queryKey: ["local", "sessions", filters],
		initialPageParam: undefined as { startTime: string; sessionId: string } | undefined,
		queryFn: async ({ pageParam }) => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const compiled = CH.compile(
				CH.sessionReplaysListQuery({
					limit: PAGE_SIZE,
					cursor: pageParam,
					serviceName: filters.service,
					browser: filters.browser,
					deviceType: filters.device,
					hasErrors: filters.errorsOnly,
					search: filters.search,
				}),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			return executeLocalCompiledQuery(compiled)
		},
		// (StartTime, SessionId), not StartTime alone: the SDK stamps start times
		// from a JS `Date`, so they are only millisecond-resolution and two
		// sessions sharing one is ordinary. A page boundary landing inside such a
		// tie would drop every session on the far side of it.
		getNextPageParam: (lastPage) => {
			const last = lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1] : undefined
			return last ? { startTime: last.startTime, sessionId: last.sessionId } : undefined
		},
	})
}

export interface SessionFacets {
	readonly service: ReadonlyArray<FilterOption>
	readonly browser: ReadonlyArray<FilterOption>
	readonly device: ReadonlyArray<FilterOption>
	/** Distinct sessions with at least one error, for the toggle count. */
	readonly errorCount: number
}

const EMPTY_FACETS: SessionFacets = {
	service: [],
	browser: [],
	device: [],
	errorCount: 0,
}

/**
 * Facet counts for the sessions filter bar. Each dimension excludes its own
 * active filter so selecting it doesn't collapse the option list (handled in
 * the DSL query).
 */
export function useLocalSessionFacets(filters: SessionFilters) {
	return useQuery<SessionFacets>({
		queryKey: ["local", "session-facets", filters],
		staleTime: 30_000,
		queryFn: async () => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const compiled = CH.compileUnion(
				CH.sessionReplaysFacetsQuery({
					serviceName: filters.service,
					browser: filters.browser,
					deviceType: filters.device,
					hasErrors: filters.errorsOnly,
					search: filters.search,
				}),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			const rows = await executeLocalCompiledQuery(compiled)

			const pick = (facetType: string): ReadonlyArray<FilterOption> =>
				rows
					.filter((row) => row.facetType === facetType && row.name)
					.map((row) => ({ name: row.name, count: row.count }))

			return {
				service: pick("service"),
				browser: pick("browser"),
				device: pick("device"),
				errorCount: rows.find((row) => row.facetType === "error")?.count ?? 0,
			}
		},
		placeholderData: EMPTY_FACETS,
	})
}
