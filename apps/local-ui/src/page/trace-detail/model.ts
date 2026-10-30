import * as Waterfall from "@maple/web/page/traces/detail/waterfall"
import * as Timeline from "@maple/web/page/traces/detail/timeline"
import { TraceData } from "@maple/web/page/traces/detail/trace-data"
import type { FlowGraph } from "@maple/web/service-map/trace-flow/trace-flow"
import * as TraceFlow from "@maple/web/service-map/trace-flow/trace-flow"
import * as AttributesPanel from "@maple/web/ui/attributes/attributes-panel"
import * as Tabs from "@maple/web/ui/tabs"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import * as LogSheet from "../kit/log-sheet/model"
import { PanelModel } from "./panel-model"

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
	/** `TraceViewTabs`: the tabs, the colour-by state and the mounted tab's Block. */
	tabs: Tabs.Model,
	colorBy: Schema.String,
	timeline: Schema.Option(Timeline.Model),
	waterfall: Schema.Option(Waterfall.Model),
	flow: Schema.NullOr(Schema.Struct({ graph: FlowGraphData, model: TraceFlow.Model })),
	/** The span panel, mounted while the hash's `spanId` names a span of the trace. */
	panel: Schema.NullOr(PanelModel),
	/**
	 * The panel's child Blocks live beside it so their Bindings can start them. The tabs stay
	 * mounted across selections; the attributes restart with each span.
	 */
	panelTabs: Tabs.Model,
	panelAttributes: AttributesPanel.Model,
	/** `SpanLogs`' own `LogDetailSheet`, once a log row of the open panel was clicked. */
	panelLogSheet: Schema.Option(LogSheet.Model),
	/** Where the span tooltip anchors (the last pointer move), none before the first. */
	pointer: Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
})
export type Model = typeof Model.Type

/** What the page's child Bindings start from: the tab the hash names. */
export const ChildInitContext = Schema.Struct({ view: Schema.String })
export type ChildInitContext = typeof ChildInitContext.Type
