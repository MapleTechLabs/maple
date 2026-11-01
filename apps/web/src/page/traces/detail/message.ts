import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as TraceFlow from "../../../service-map/trace-flow/trace-flow"
import * as Dialog from "../../../ui/dialog"
import * as Resizable from "../../../ui/resizable"
import * as Tabs from "../../../ui/tabs"
import { ProductEvent } from "./model"
import * as SpanPanel from "./span-panel"
import * as Timeline from "./timeline"
import { SpanEvents, TraceData } from "./trace-data"
import * as Waterfall from "./waterfall"

export const TraceView = Schema.Literals(["waterfall", "timeline", "flow"])
export type TraceView = typeof TraceView.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	CompletedReadListQuery: { listQuery: Schema.String },
	/** `useAppHotkey("list.clear")`: Escape on the page closes the span panel. */
	PressedPageEscape: {},
	/** The mobile span sheet (`Sheet side="bottom"`); it is open exactly while a span is selected. */
	GotSpanSheetMessage: { message: Dialog.Message },
	CompletedFetchHierarchy: result(TraceData),
	ClickedRetryHierarchy: {},
	CompletedFetchSpanEvents: result(SpanEvents),
	CompletedFetchProductEvents: result(Schema.Array(ProductEvent)),
	CompletedFetchLogsCount: result(Schema.Number),
	CompletedFetchReplays: result(Schema.NullOr(Schema.String)),
	GotTabsMessage: { message: Tabs.Message },
	GotSplitMessage: { message: Resizable.Message },
	MeasuredSplitWidth: { width: Schema.Number },
	ClickedViewOriginSpan: { spanId: Schema.String },
	ClickedProductEvent: { spanId: Schema.String },
	GotTimelineMessage: { message: Timeline.Message },
	GotWaterfallMessage: { message: Waterfall.Message },
	GotFlowMessage: { message: TraceFlow.Message },
	GotSpanPanelMessage: { message: SpanPanel.Message },
	ClickedCopyTraceId: {},
	CompletedCopyTraceId: { isOk: Schema.Boolean },
})
export type Message = typeof Message.Type
