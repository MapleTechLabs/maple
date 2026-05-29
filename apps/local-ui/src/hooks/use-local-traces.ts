import { useInfiniteQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { TracesRootListOutput } from "@maple/query-engine/ch"
import { executeLocalQuery } from "../lib/local-query-client"
import { LOCAL_ORG_ID } from "../lib/constants"
import { defaultTimeBounds } from "../lib/time"

const PAGE_SIZE = 25

/**
 * Infinite list of root traces, newest first. Uses keyset (cursor) pagination
 * on the root span `Timestamp` — the cursor is the last row's `startTime`.
 */
export function useLocalTraces() {
	return useInfiniteQuery({
		queryKey: ["local", "traces"],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const { startTime, endTime } = defaultTimeBounds()
			const compiled = CH.compile(
				CH.tracesRootListQuery({ limit: PAGE_SIZE, cursor: pageParam }),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			const rows = await executeLocalQuery(compiled.sql)
			return compiled.castRows(rows) as ReadonlyArray<TracesRootListOutput>
		},
		getNextPageParam: (lastPage) =>
			lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1]?.startTime : undefined,
	})
}
