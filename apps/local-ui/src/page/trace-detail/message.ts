import * as Waterfall from "@maple/web/page/traces/detail/waterfall"
import * as Timeline from "@maple/web/page/traces/detail/timeline"
import * as SpanPanel from "@maple/views/traces/span-panel"
import { TraceData } from "@maple/views/traces/trace-data"
import * as TraceFlow from "@maple/views/service-map/trace-flow/trace-flow"
import * as Tabs from "@maple/views/ui/tabs"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as LogSheet from "@maple/views/logs/log-sheet"
import { LocalLog } from "../../lib/log-shape"

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
	GotSpanPanelMessage: { message: SpanPanel.Message },
	/** A Logs-tab row's whole log: `LogDetailSheet` opens on it. */
	FoundSpanLog: { log: LocalLog },
	/** The clicked row's log could not be read again: the panel's reads are refreshed. */
	FailedReadSpanLog: {},
	GotLogSheetMessage: { message: LogSheet.Message },
	CompletedFocusSpanPanel: {},
})
export type Message = typeof Message.Type
