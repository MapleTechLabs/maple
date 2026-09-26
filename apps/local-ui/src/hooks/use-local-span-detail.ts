import { skipToken, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { Option } from "effect"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { executeLocalCompiledFirstRow } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"

export interface SpanDetailAttrs {
	spanAttributes: Record<string, string>
	resourceAttributes: Record<string, string>
}

/**
 * Lazily loads one span's full attribute maps. The span-hierarchy query that
 * backs the trace view trims attributes to the keys the tree renders; this
 * point lookup (`(OrgId, TraceId, SpanId)` sort key) fetches the rest only
 * when the detail panel opens.
 */
export function useLocalSpanDetail(traceId: string | undefined, spanId: string | undefined) {
	return useQuery<SpanDetailAttrs | null>({
		queryKey: ["local", "span-detail", traceId, spanId],
		queryFn:
			traceId && spanId
				? async ({ signal }) => {
						const compiled = CH.compile(CH.spanDetailQuery({ traceId, spanId }), {
							orgId: LOCAL_ORG_ID,
						})
						return Option.match(await executeLocalCompiledFirstRow(compiled, signal), {
							onNone: () => null,
							onSome: (row) => ({
								spanAttributes: parseAttributes(row.spanAttributes),
								resourceAttributes: parseAttributes(row.resourceAttributes),
							}),
						})
					}
				: skipToken,
	})
}
