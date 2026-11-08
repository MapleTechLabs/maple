import { Option, String as Str, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Model } from "./model"
import type { SpanNodeData, TraceData } from "@maple/views/traces/trace-data"

// What the page shows for a loaded hierarchy (`ResultPage`'s `select`) and its span lookup.

export interface LoadedTrace {
	readonly data: TraceData
	readonly traceStartTime: string
	readonly rootSpan: SpanNodeData | undefined
}

/** No spans (or no start) is a trace that isn't there; a missing root still renders a body. */
export const selectTrace = (data: TraceData): Option.Option<LoadedTrace> =>
	data.spans.length === 0 || data.traceStartTime === undefined
		? Option.none()
		: Option.some({ data, traceStartTime: data.traceStartTime, rootSpan: data.rootSpans[0] })

export const loadedTrace = (model: Model): Option.Option<LoadedTrace> =>
	Option.flatMap(AsyncData.getData(model.hierarchy.data), selectTrace)

/** `findSpanById`: a combined flow-node id (`combined-<spanId>-...`) resolves to its first span. */
export const findSpan = (
	rootSpans: ReadonlyArray<SpanNodeData>,
	spanId: string,
): SpanNodeData | undefined => {
	const searchId = Str.startsWith("combined-")(spanId)
		? (Str.split("-")(Str.slice("combined-".length)(spanId))[0] ?? spanId)
		: spanId
	const visit = (node: SpanNodeData): SpanNodeData | undefined =>
		node.spanId === searchId
			? node
			: Arr.reduce<SpanNodeData, SpanNodeData | undefined>(
					node.children,
					undefined,
					(found, child) => found ?? visit(child),
				)
	return Arr.reduce<SpanNodeData, SpanNodeData | undefined>(
		rootSpans,
		undefined,
		(found, root) => found ?? visit(root),
	)
}

export const selectedSpanOf = (model: Model): SpanNodeData | undefined => {
	const spanId = model.search.spanId
	return spanId === undefined || spanId === ""
		? undefined
		: Option.match(loadedTrace(model), {
				onNone: () => undefined,
				onSome: (trace) => findSpan(trace.data.rootSpans, spanId),
			})
}
