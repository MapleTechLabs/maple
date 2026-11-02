import * as Waterfall from "@maple/web/page/traces/detail/waterfall"
import * as Timeline from "@maple/web/page/traces/detail/timeline"
import { TraceData } from "@maple/views/traces/trace-data"
import type { FlowGraph } from "@maple/views/service-map/trace-flow/trace-flow"
import * as TraceFlow from "@maple/views/service-map/trace-flow/trace-flow"
import * as Tabs from "@maple/views/ui/tabs"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import * as SpanPanel from "@maple/views/traces/span-panel"
import * as LogSheet from "../kit/log-sheet/model"

// The trace detail page.

/** The laid-out flow graph is derived from the trace once; it is plain data the canvas reads. */
const FlowGraphData = Schema.declare(
	(input: unknown): input is FlowGraph => typeof input === "object" && input !== null && "nodes" in input,
)

export const Model = Schema.TaggedStruct("TraceDetailPage", {
	traceId: Schema.String,
	/** The trace's spans: none when the trace has no spans (or its id is not a trace id). */
	trace: SlotSchema(Schema.Option(TraceData)),
	/** `dataUpdatedAt` of the trace, for the "New data" pill. */
	traceUpdatedAtMs: Schema.Number,
	isRefreshing: Schema.Boolean,
	/** `TraceViewTabs`: the tabs, the colour-by state and the mounted tab's Submodel. */
	tabs: Tabs.Model,
	colorBy: Schema.String,
	timeline: Schema.NullOr(Timeline.Model),
	waterfall: Schema.NullOr(Waterfall.Model),
	flow: Schema.NullOr(Schema.Struct({ graph: FlowGraphData, model: TraceFlow.Model })),
	/** The span panel, mounted while the hash's `spanId` names a span of the trace. */
	panel: Schema.NullOr(SpanPanel.Model),
	/** `LogDetailSheet` over the span panel, once a Logs-tab row was clicked. */
	maybeLogSheet: Schema.Option(LogSheet.Model),
	/** Where the span tooltip anchors (the last pointer move), none before the first. */
	pointer: Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
})
export type Model = typeof Model.Type
