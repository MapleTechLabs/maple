import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { buildTraceDetail, type SpanHierarchyRow, type TraceDetail } from "@maple/ui/lib/span-tree"
import { executeLocalQuery } from "../lib/local-query-client"
import { LOCAL_ORG_ID } from "../lib/constants"

/**
 * Full span hierarchy for one trace, shaped into everything `TraceViewTabs`
 * needs (flat spans + root tree + total duration + services + start time).
 *
 * `narrowByTime` is intentionally off: local data volume is tiny, so scanning
 * the whole window for the trace id is cheaper than threading time bounds.
 */
export function useLocalTraceDetail(traceId: string | undefined) {
	return useQuery<TraceDetail>({
		queryKey: ["local", "trace", traceId],
		enabled: !!traceId,
		queryFn: async () => {
			const compiled = CH.compile(CH.spanHierarchyQuery({ traceId: traceId! }), {
				orgId: LOCAL_ORG_ID,
			})
			const rows = await executeLocalQuery<SpanHierarchyRow>(compiled.sql)
			return buildTraceDetail(rows)
		},
	})
}
