import { LoadFailure as WebLoadFailure } from "@maple/web/data/load-failure"
import { AttributeScope } from "@maple/web/page/traces/detail/span-panel/message"
import { LogEntry, SpanDetail } from "@maple/web/page/traces/detail/span-panel/model"
import { TraceData } from "@maple/web/page/traces/detail/trace-data"
import * as TraceFlow from "@maple/web/service-map/trace-flow/trace-flow"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
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
	/** The flow canvas is a plain helper module (not a Block): its Messages come back wrapped. */
	ReceivedFlowMessage: { message: TraceFlow.Message },
	/** A tab click, relayed back by `RelayTabChoice` so the update can read the hash. */
	ChoseTab: { value: Schema.String },
	/** A timeline or waterfall row click, relayed back by `RelaySpanChoice` for the same reason. */
	ChoseSpan: { spanId: Schema.String },
	/** The root saw the fragment change under the open page: a new `view` or `spanId`. */
	InformedOfLocationChange: {},
	SucceededFetchSpanDetail: { key: Schema.String, detail: SpanAttrs, fetchedAtMs: Schema.Number },
	FailedFetchSpanDetail: { key: Schema.String, failure: LoadFailure },
	/** The result cache answered first; `request` is the read the fetch then repeats. */
	FoundCachedSpanDetail: { request: SpanDetailRequest, cached: CachedOf(SpanAttrs) },
	SucceededFetchSpanLogs: { key: Schema.String, logs: Schema.Array(SpanLog), fetchedAtMs: Schema.Number },
	FailedFetchSpanLogs: { key: Schema.String, failure: LoadFailure },
	FoundCachedSpanLogs: { request: SpanLogsRequest, cached: CachedOf(Schema.Array(SpanLog)) },
	/**
	 * The web span panel's Messages, field for field: its header, copy and error helpers render
	 * with this page's builder, so this union must contain every one of them.
	 */
	CompletedFetchDetail: { key: Schema.String, result: Schema.Result(SpanDetail, WebLoadFailure) },
	CompletedFetchLogs: { key: Schema.String, result: Schema.Result(Schema.Array(LogEntry), WebLoadFailure) },
	ClickedClose: {},
	ClickedParentSpan: { spanId: Schema.String },
	ClickedCopy: { id: Schema.String, text: Schema.String },
	SucceededCopy: { id: Schema.String, generation: Schema.Number },
	FailedCopy: { id: Schema.String, generation: Schema.Number },
	ElapsedCopyStatus: { id: Schema.String, generation: Schema.Number },
	ToggledCollapsible: { id: Schema.String },
	ToggledErrorExpanded: {},
	ClickedAttributeFilter: {
		scope: AttributeScope,
		key: Schema.String,
		value: Schema.String,
		isExclude: Schema.Boolean,
	},
	/** A row of the span's Logs tab: `LogDetailSheet` opens on it. */
	ClickedSpanLog: { log: LocalLog },
	CompletedWriteClipboard: { id: Schema.String, generation: Schema.Number, isOk: Schema.Boolean },
	CompletedFocusSpanPanel: {},
})
export type Message = typeof Message.Type
