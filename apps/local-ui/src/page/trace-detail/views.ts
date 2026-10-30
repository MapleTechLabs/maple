import { findSpan } from "@maple/web/page/traces/detail/select"
import type { SpanNodeData, TraceData } from "@maple/web/page/traces/detail/trace-data"
import { queryOf } from "../../route"
import type { PageContext } from "../contract"

// `TraceViewTabs`: the hash's `view` picks the tab (timeline by default), `spanId` the selection.

export type TraceView = "waterfall" | "timeline" | "flow"
export const TAB_VALUES: ReadonlyArray<TraceView> = ["waterfall", "timeline", "flow"]

export const isTraceView = (value: string | null): value is TraceView =>
	TAB_VALUES.some((view) => view === value)

export const viewOf = (context: PageContext): TraceView => {
	const raw = queryOf(context.location).get("view")
	return isTraceView(raw) ? raw : "timeline"
}

/** `findSpanNode`: the hash's `spanId` in the rendered tree. */
export const selectedSpanOf = (trace: TraceData, context: PageContext): SpanNodeData | undefined => {
	const spanId = queryOf(context.location).get("spanId") || undefined
	return spanId === undefined ? undefined : findSpan(trace.rootSpans, spanId)
}
