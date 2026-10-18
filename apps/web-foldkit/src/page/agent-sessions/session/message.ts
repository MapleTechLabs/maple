import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Canvas from "../../../service-map/xyflow/canvas"
import * as CopyButton from "../../../ui/copy-button"
import * as Popover from "../../../ui/popover"
import * as Tabs from "../../../ui/tabs"
import { DetectedModel } from "../kit/detected-models"
import { ParsedMarkdown } from "./message-response"
import { SESSION_VIEWS, SessionTotals, SpansPage, ViewOption } from "./model"

export const SpanScope = Schema.Literals(["ai", "app"])
export type SpanScope = typeof SpanScope.Type

export const Message = defineMessageUnion({
	CompletedResolveClock: { nowMs: Schema.Number },
	CompletedFetchFirstPage: { key: Schema.String, result: Schema.Result(SpansPage, LoadFailure) },
	/** A background page; `isTooLarge` asks again at half the page size. */
	CompletedFetchMorePage: {
		key: Schema.String,
		scope: SpanScope,
		result: Schema.Result(SpansPage, LoadFailure),
		isTooLarge: Schema.Boolean,
	},
	CompletedFetchTotals: { key: Schema.String, result: Schema.Result(SessionTotals, LoadFailure) },
	CompletedDetectModels: { key: Schema.String, models: Schema.Array(DetectedModel) },
	ClickedRetryLoad: {},
	GotTabsMessage: { message: Tabs.Message },
	PressedViewKey: { view: Schema.Literals(SESSION_VIEWS) },
	GotDisplayPopoverMessage: { message: Popover.Message },
	ChangedQuery: { value: Schema.String },
	ToggledOption: { option: ViewOption },
	ToggledTurn: { turnId: Schema.String },
	ToggledRow: { key: Schema.String },
	ClickedSpan: { spanId: Schema.UndefinedOr(Schema.String) },
	ToggledChecks: { which: Schema.Literals(["passed", "skipped"]), isOpen: Schema.Boolean },
	ToggledLedgerTool: { name: Schema.String },
	ClickedOpenTools: {},
	CompletedScroll: {},
	GotCopyMessage: { message: CopyButton.Message },
	PressedBodyView: { key: Schema.String, isRaw: Schema.Boolean },
	GotFlowCanvasMessage: { message: Canvas.Message },
	ClickedResetFlowView: {},
	MeasuredClamp: { key: Schema.String, isClamped: Schema.Boolean },
	CompletedParseMarkdown: { parsed: Schema.Array(ParsedMarkdown) },
	GotPayloadCopyMessage: { key: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
