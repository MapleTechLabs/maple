import { TraceId } from "@maple/domain"
import { CH } from "@maple/query-engine"
import { LOCAL_ORG_ID } from "@maple/query-engine/local"
import type { TraceData } from "@maple/views/traces/trace-data"
import { buildTraceDetail } from "@maple/ui/lib/span-tree"
import { DateTime, Effect, Option, Schema } from "effect"
import { queryRows } from "../../data/local-query"

// The query of `useLocalTraceDetail` (the span panel reads through `TraceSource`).

const decodeTraceId = Schema.decodeUnknownOption(TraceId)

/**
 * The full span hierarchy, shaped like `TraceViewTabs` reads it; none for a trace with no spans.
 * `narrowByTime` stays off: the trace-id lookup is cheaper than threading time bounds.
 */
export const fetchTrace = (traceId: string, apiBase: string) =>
	Effect.map(
		queryRows(CH.compile(CH.spanHierarchyQuery({ traceId }), { orgId: LOCAL_ORG_ID }), apiBase),
		(rows): Option.Option<TraceData> => {
			const detail = buildTraceDetail(rows.map((row) => ({ ...row, startTime: DateTime.formatIso(row.startTime) })))
			if (detail.spans.length === 0) return Option.none()
			return Option.map(decodeTraceId(traceId), (id) => ({
				traceId: id,
				spans: detail.spans,
				rootSpans: detail.rootSpans,
				totalDurationMs: detail.totalDurationMs,
				traceStartTime: detail.traceStartTime,
			}))
		},
	)
