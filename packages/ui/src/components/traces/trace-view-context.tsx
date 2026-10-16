import * as React from "react"
import type { ReactNode } from "react"
import type { SpanNode } from "../../lib/types"
import type { ColorByField } from "./color-by"
import type { SpanEventsBySpanId } from "../../lib/span-event-markers"

interface TraceViewContextValue {
	rootSpans: SpanNode[]
	totalDurationMs: number
	traceStartTime: string
	services: string[]
	selectedSpanId?: string
	onSelectSpan?: (span: SpanNode) => void
	colorBy: ColorByField
	setColorBy: (next: ColorByField) => void
	/** Loaded after the hierarchy; absent until then, and for views that never fetch them. */
	spanEvents?: SpanEventsBySpanId
}

const TraceViewContext = React.createContext<TraceViewContextValue | null>(null)

export function TraceViewProvider({ children, ...value }: TraceViewContextValue & { children: ReactNode }) {
	const ctx = React.useMemo(
		() => value,
		[
			value.rootSpans,
			value.totalDurationMs,
			value.traceStartTime,
			value.services,
			value.selectedSpanId,
			value.onSelectSpan,
			value.colorBy,
			value.setColorBy,
			value.spanEvents,
		],
	)
	return <TraceViewContext value={ctx}>{children}</TraceViewContext>
}

export function useTraceView() {
	const ctx = React.use(TraceViewContext)
	if (!ctx) throw new Error("useTraceView must be used within TraceViewProvider")
	return ctx
}
