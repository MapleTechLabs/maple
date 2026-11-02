import * as TraceFlow from "@maple/views/service-map/trace-flow/trace-flow"
import * as Flamegraph from "@maple/views/traces/flamegraph"
import type { FlamegraphInput } from "@maple/views/traces/flamegraph-layout"
import { defineMessageUnion } from "foldkit/message"
import { Schema } from "effect"
import { BASE_TIME, ROOT_SPANS, SERVICES, TOTAL_DURATION_MS } from "./fixture"

export const TRACE_INPUT: FlamegraphInput = {
	rootSpans: ROOT_SPANS,
	totalDurationMs: TOTAL_DURATION_MS,
	traceStartTime: BASE_TIME,
	services: SERVICES,
}
export const FLOW_GRAPH = TraceFlow.buildFlowGraph(TRACE_INPUT)
export const FLAME_ID = "trace-explorer-flamegraph"

export const Tab = Schema.Literals(["flow", "waterfall", "flamegraph"])
export type Tab = typeof Tab.Type

export const Model = Schema.Struct({
	tab: Tab,
	selectedSpanId: Schema.Option(Schema.String),
	flow: TraceFlow.Model,
	flame: Flamegraph.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ClickedTab: { tab: Tab },
	ClickedWaterfallRow: { spanId: Schema.String },
	GotFlowMessage: { message: TraceFlow.Message },
	GotFlameMessage: { message: Flamegraph.Message },
})
export type Message = typeof Message.Type
