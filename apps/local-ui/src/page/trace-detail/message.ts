import * as Waterfall from "@maple/web/page/traces/detail/waterfall"
import * as Timeline from "@maple/web/page/traces/detail/timeline"
import * as SpanPanel from "@maple/web/page/traces/detail/span-panel/message"
import { TraceData } from "@maple/web/page/traces/detail/trace-data"
import * as TraceFlow from "@maple/web/service-map/trace-flow/trace-flow"
import * as AttributesPanel from "@maple/web/ui/attributes/attributes-panel"
import * as Tabs from "@maple/web/ui/tabs"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
import { Message as LogSheetMessage } from "../kit/log-sheet/message"
import { LocalLog } from "../kit/log-sheet/model"
import { SpanDetailRequest, SpanLogsRequest } from "./requests"
import { SpanAttrs, SpanLog } from "./panel-model"

export const Message = defineMessageUnion({
	SucceededFetchTrace: { key: Schema.String, trace: Schema.Option(TraceData), fetchedAtMs: Schema.Number },
	/** The result cache held this trace before the fetch ran. */
	FoundCachedTrace: { key: Schema.String, cached: CachedOf(Schema.Option(TraceData)) },
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
	SucceededFetchSpanDetail: { key: Schema.String, detail: SpanAttrs, fetchedAtMs: Schema.Number },
	FailedFetchSpanDetail: { key: Schema.String, failure: LoadFailure },
	/** The result cache answered first; `request` is the read the fetch then repeats. */
	FoundCachedSpanDetail: { request: SpanDetailRequest, cached: CachedOf(SpanAttrs) },
	SucceededFetchSpanLogs: { key: Schema.String, logs: Schema.Array(SpanLog), fetchedAtMs: Schema.Number },
	FailedFetchSpanLogs: { key: Schema.String, failure: LoadFailure },
	FoundCachedSpanLogs: { request: SpanLogsRequest, cached: CachedOf(Schema.Array(SpanLog)) },
	/** The panel's header, copy and error parts (the web panel's markup and Messages). */
	GotSpanPanelMessage: { message: SpanPanel.Message },
	GotPanelTabsMessage: { message: Tabs.Message },
	GotAttributesMessage: { message: AttributesPanel.Message },
	/** A row of the span's Logs tab: `LogDetailSheet` opens on it. */
	ClickedSpanLog: { log: LocalLog },
	GotLogSheetMessage: { message: LogSheetMessage },
	CompletedWriteClipboard: { id: Schema.String, generation: Schema.Number, isOk: Schema.Boolean },
	ElapsedCopyStatus: { id: Schema.String, generation: Schema.Number },
	CompletedFocusSpanPanel: {},
})
export type Message = typeof Message.Type
