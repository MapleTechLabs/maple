import { findSpanById } from "@maple/views/service-map/trace-flow/flow-graph"
import { Option } from "effect"
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

export const selectedSpanOf = (model: Model): SpanNodeData | undefined => {
	const spanId = model.search.spanId
	return spanId === undefined || spanId === ""
		? undefined
		: Option.match(loadedTrace(model), {
				onNone: () => undefined,
				onSome: (trace) => findSpanById(trace.data.rootSpans, spanId),
			})
}
