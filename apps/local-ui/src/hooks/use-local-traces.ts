import { useInfiniteQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { TracesRootListOutput } from "@maple/query-engine/ch"
import { executeLocalQuery } from "../lib/local-query-client"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"

const PAGE_SIZE = 25

export interface TraceFilters {
	/** Exact service name match. */
	service?: string
	/** Substring match on the root span name. */
	search?: string
	/** Restrict to traces whose root span errored. */
	errorsOnly?: boolean
	/** Time-range preset key (see `TIME_RANGES`). */
	range?: string
}

/**
 * Infinite list of root traces, newest first. Uses keyset (cursor) pagination
 * on the root span `Timestamp` — the cursor is the last row's `startTime`.
 */
export function useLocalTraces(filters: TraceFilters) {
	return useInfiniteQuery({
		queryKey: ["local", "traces", filters],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const compiled = CH.compile(
				CH.tracesRootListQuery({
					limit: PAGE_SIZE,
					cursor: pageParam,
					serviceName: filters.service,
					spanName: filters.search,
					matchModes: filters.search ? { spanName: "contains" } : undefined,
					errorsOnly: filters.errorsOnly,
				}),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			const rows = await executeLocalQuery(compiled.sql)
			return compiled.castRows(rows) as ReadonlyArray<TracesRootListOutput>
		},
		getNextPageParam: (lastPage) =>
			lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1]?.startTime : undefined,
	})
}
