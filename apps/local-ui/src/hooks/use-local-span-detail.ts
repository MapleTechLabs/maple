import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { SpanDetailOutput } from "@maple/query-engine/ch"
import { executeLocalQuery } from "@maple/query-engine/local"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { LOCAL_ORG_ID } from "../lib/constants"

export interface SpanDetailAttrs {
	spanAttributes: Record<string, string>
	resourceAttributes: Record<string, string>
}

/**
 * Lazily loads one span's full attribute maps. The span-hierarchy query that
 * backs the trace view intentionally trims attributes to the keys the tree
 * renders; this point lookup (`(OrgId, TraceId, SpanId)` sort key) fetches the
 * rest only when the detail panel opens. `narrowByTime` is off — local data is
 * tiny, so no time bounds are threaded.
 */
export function useLocalSpanDetail(traceId: string | undefined, spanId: string | undefined) {
	return useQuery<SpanDetailAttrs | null>({
		queryKey: ["local", "span-detail", traceId, spanId],
		enabled: !!traceId && !!spanId,
		queryFn: async () => {
			const compiled = CH.compile(CH.spanDetailQuery({ traceId: traceId!, spanId: spanId! }), {
				orgId: LOCAL_ORG_ID,
			})
			const rows = compiled.castRows(
				await executeLocalQuery(compiled.sql),
			) as ReadonlyArray<SpanDetailOutput>
			const row = rows[0]
			if (!row) return null
			return {
				spanAttributes: parseAttributes(row.spanAttributes),
				resourceAttributes: parseAttributes(row.resourceAttributes),
			}
		},
	})
}
