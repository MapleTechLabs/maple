import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TraceSearch } from "../../../route/search"
import type { FlowGraph } from "../../../service-map/trace-flow/trace-flow"
import * as TraceFlow from "../../../service-map/trace-flow/trace-flow"
import * as Resizable from "../../../ui/resizable"
import * as Tabs from "../../../ui/tabs"
import * as SpanPanel from "./span-panel"
import * as Timeline from "./timeline"
import { SpanEvents, TraceData } from "./trace-data"
import * as Waterfall from "./waterfall"

// `/traces/$traceId`.

export const ProductEvent = Schema.Struct({
	eventName: Schema.String,
	spanId: Schema.String,
	serviceName: Schema.String,
	userId: Schema.String,
	groupId: Schema.String,
	visitorId: Schema.String,
	attributes: Schema.Record(Schema.String, Schema.String),
})
export type ProductEvent = typeof ProductEvent.Type

/** The laid-out flow graph is derived from the trace once; it is plain data the canvas reads. */
const FlowGraphData = Schema.declare(
	(input: unknown): input is FlowGraph => typeof input === "object" && input !== null && "nodes" in input,
)

export const Model = Schema.Struct({
	traceId: Schema.String,
	search: TraceSearch,
	/** The clock at entry, for "16m ago". */
	nowMs: Schema.Number,
	/** The list filters on the URL (`list-query.ts`), kept on every navigation and the crumb. */
	listQuery: Schema.String,
	hierarchy: KeyedSchema(TraceData, LoadFailure),
	spanEvents: KeyedSchema(SpanEvents, LoadFailure),
	productEvents: KeyedSchema(Schema.Array(ProductEvent), LoadFailure),
	logsCount: KeyedSchema(Schema.Number, LoadFailure),
	replaySessionId: KeyedSchema(Schema.NullOr(Schema.String), LoadFailure),
	/** `TraceViewTabs`' colour-by state: it outlives the timeline when the tab changes. */
	colorBy: Schema.String,
	/** The view tabs (Base UI Tabs, controlled by the URL's `view`). */
	tabs: Tabs.Model,
	/** The trace pane and, with a span selected, the span panel beside it. */
	split: Resizable.Model,
	/** The split group's content width, which its pixel-sized panels are laid out against. */
	splitWidth: Schema.NullOr(Schema.Number),
	timeline: Schema.NullOr(Timeline.Model),
	waterfall: Schema.NullOr(Waterfall.Model),
	flow: Schema.NullOr(Schema.Struct({ graph: FlowGraphData, model: TraceFlow.Model })),
	spanPanel: Schema.NullOr(SpanPanel.Model),
	/** Inside the list's peek sheet: no span or product events are read (`TracePeekLoaded`). */
	isPeek: Schema.Boolean,
})
export type Model = typeof Model.Type
