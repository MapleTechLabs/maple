import {
	TIMELINE_LAB_EVENTS,
	TIMELINE_LAB_MARKERS,
	TIMELINE_LAB_TRACE,
} from "../timeline-fixture"
import { Option, Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as SpanPanel from "../../page/traces/detail/span-panel"
import * as Timeline from "../../page/traces/detail/timeline"
import { type SpanEvents, TraceData, toSpanNode } from "../../page/traces/detail/trace-data"
import * as Waterfall from "../../page/traces/detail/waterfall"
import * as TraceFlow from "../../service-map/trace-flow/trace-flow"
import * as Tabs from "../../ui/tabs"

// `/lab/timeline`: `TraceViewTabs` over a synthetic trace with a
// wide dynamic range, span event markers, and the selected span's events beside it.

/** The fixture as the trace page's Model data, with the id `getSpanHierarchy` adds to the tree. */
export const LAB_TRACE: Option.Option<TraceData> = Schema.decodeUnknownOption(TraceData)({
	...TIMELINE_LAB_TRACE,
	traceId: TIMELINE_LAB_TRACE.spans[0]?.traceId,
})

export const LAB_MARKERS: SpanEvents = Object.fromEntries(
	[...TIMELINE_LAB_MARKERS].map(([spanId, events]) => [spanId, [...events]]),
)

export const eventsOf = (spanId: string) => TIMELINE_LAB_EVENTS.get(spanId) ?? []

export const LAB_FLOW_GRAPH = Option.map(LAB_TRACE, (trace) =>
	TraceFlow.buildFlowGraph({
		rootSpans: trace.rootSpans.map(toSpanNode),
		totalDurationMs: trace.totalDurationMs,
		services: [...new Set(trace.spans.map((span) => span.serviceName))],
	}),
)

export const TAB_VALUES = ["waterfall", "timeline", "flow"]

export const Model = Schema.Struct({
	/** `TraceViewTabs` uncontrolled: `defaultValue="timeline"`. */
	tabs: Tabs.Model,
	colorBy: Schema.String,
	selectedSpanId: Schema.NullOr(Schema.String),
	timeline: Schema.NullOr(Timeline.Model),
	waterfall: Schema.NullOr(Waterfall.Model),
	flow: Schema.NullOr(TraceFlow.Model),
	/** Only the copy and expand state of the events list is read; the lab fetches nothing. */
	panel: Schema.NullOr(SpanPanel.Model),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotTabsMessage: { message: Tabs.Message },
	GotTimelineMessage: { message: Timeline.Message },
	GotWaterfallMessage: { message: Waterfall.Message },
	GotFlowMessage: { message: TraceFlow.Message },
	GotPanelMessage: { message: SpanPanel.Message },
})
export type Message = typeof Message.Type
