import { useInfiniteQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { LogsListOutput } from "@maple/query-engine/ch"
import { executeLocalQuery } from "../lib/local-query-client"
import { LOCAL_ORG_ID } from "../lib/constants"
import { defaultTimeBounds } from "../lib/time"

const PAGE_SIZE = 50

/**
 * Infinite log stream, newest first. Keyset pagination on `Timestamp` — the
 * cursor is the last row's `timestamp`.
 */
export function useLocalLogs() {
	return useInfiniteQuery({
		queryKey: ["local", "logs"],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const { startTime, endTime } = defaultTimeBounds()
			const compiled = CH.compile(
				CH.logsListQuery({ limit: PAGE_SIZE, cursor: pageParam }),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			const rows = await executeLocalQuery(compiled.sql)
			return compiled.castRows(rows) as ReadonlyArray<LogsListOutput>
		},
		getNextPageParam: (lastPage) =>
			lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1]?.timestamp : undefined,
	})
}
