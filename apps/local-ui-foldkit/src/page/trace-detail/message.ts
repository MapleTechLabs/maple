import * as Waterfall from "@maple/web-foldkit/page/traces/detail/waterfall"
import * as Timeline from "@maple/web-foldkit/page/traces/detail/timeline"
import * as SpanPanel from "@maple/web-foldkit/page/traces/detail/span-panel/message"
import { TraceData } from "@maple/web-foldkit/page/traces/detail/trace-data"
import * as TraceFlow from "@maple/web-foldkit/service-map/trace-flow/trace-flow"
import * as AttributesPanel from "@maple/web-foldkit/ui/attributes/attributes-panel"
import * as Tabs from "@maple/web-foldkit/ui/tabs"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { SpanAttrs, SpanLog } from "./panel-model"

export const Message = defineMessageUnion({
	SucceededFetchTrace: { key: Schema.String, trace: Schema.Option(TraceData), fetchedAtMs: Schema.Number },
	FailedFetchTrace: { key: Schema.String, failure: LoadFailure },
	ClickedBack: {},
	ClickedRefresh: {},
	PressedEscape: {},
	/** The pointer over the page, for the timeline's span tooltip (`handleHover`'s position). */
	MovedPointer: { x: Schema.Number, y: Schema.Number },
	GotTabsMessage: { message: Tabs.Message },
	GotTimelineMessage: { message: Timeline.Message },
	GotWaterfallMessage: { message: Waterfall.Message },
	GotFlowMessage: { message: TraceFlow.Message },
	SucceededFetchSpanDetail: { key: Schema.String, detail: SpanAttrs },
	FailedFetchSpanDetail: { key: Schema.String, failure: LoadFailure },
	SucceededFetchSpanLogs: { key: Schema.String, logs: Schema.Array(SpanLog) },
	FailedFetchSpanLogs: { key: Schema.String, failure: LoadFailure },
	/** The panel's header, copy and error parts (the web panel's markup and Messages). */
	GotSpanPanelMessage: { message: SpanPanel.Message },
	GotPanelTabsMessage: { message: Tabs.Message },
	GotAttributesMessage: { message: AttributesPanel.Message },
	CompletedWriteClipboard: { id: Schema.String, generation: Schema.Number, isOk: Schema.Boolean },
	ElapsedCopyStatus: { id: Schema.String, generation: Schema.Number },
})
export type Message = typeof Message.Type
