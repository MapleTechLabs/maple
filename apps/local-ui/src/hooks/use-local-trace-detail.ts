import { skipToken, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { buildTraceDetail, type TraceDetail } from "@maple/ui/lib/span-tree"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"

/**
 * Full span hierarchy for one trace, shaped into everything `TraceViewTabs`
 * needs. `narrowByTime` stays off: local volume is small enough that the
 * trace-id lookup is cheaper than threading time bounds.
 */
export function useLocalTraceDetail(traceId: string | undefined) {
	return useQuery<TraceDetail>({
		queryKey: ["local", "trace", traceId],
		queryFn: traceId
			? async ({ signal }) => {
					const compiled = CH.compile(CH.spanHierarchyQuery({ traceId }), { orgId: LOCAL_ORG_ID })
					return buildTraceDetail(await executeLocalCompiledQuery(compiled, signal))
				}
			: skipToken,
	})
}
