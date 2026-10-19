import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Canvas from "../../../service-map/xyflow/canvas"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import { Message as SpanPanelMessage } from "../../traces/detail/span-panel/message"
import * as Popover from "../../../ui/popover"
import * as Tabs from "../../../ui/tabs"
import * as Tooltip from "../../../ui/tooltip"
import { DetectedModel } from "../kit/detected-models"
import { VirtualWindow } from "../kit/virtualize"
import { ParsedMarkdown } from "../../kit/message-response"
import { SESSION_VIEWS, SessionTotals, SpanDetailTab, SpansPage, ViewOption } from "./model"

export const SpanScope = Schema.Literals(["ai", "app"])
export type SpanScope = typeof SpanScope.Type

export const Message = defineMessageUnion({
	/** The clock and the browser's locale (the token titles' `toLocaleString`). */
	CompletedResolveClock: { nowMs: Schema.Number, locale: Schema.String },
	CompletedFetchFirstPage: { key: Schema.String, result: Schema.Result(SpansPage, LoadFailure) },
	/** A background page; `isTooLarge` asks again at half the page size. */
	CompletedFetchMorePage: {
		key: Schema.String,
		/** How many later pages had landed when it was asked for: a page answers one position. */
		index: Schema.Number,
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
	ClickedCodeAction: {
		action: Schema.Literals(["copy", "download"]),
		code: Schema.String,
		language: Schema.String,
	},
	CompletedCodeAction: { code: Schema.String, isCopied: Schema.Boolean },
	ElapsedCodeCopied: { generation: Schema.Number },
	ClickedResetFlowView: {},
	MeasuredClamp: { key: Schema.String, isClamped: Schema.Boolean },
	CompletedParseMarkdown: { parsed: Schema.Array(ParsedMarkdown) },
	GotPayloadCopyMessage: { key: Schema.String, message: CopyButton.Message },
	ChangedWaterfallWindow: { window: VirtualWindow },
	ChangedTranscriptWindow: { window: VirtualWindow },
	/** A waterfall row: the cursor moves onto it and the span opens, or closes if it was open. */
	ClickedWaterfallSpan: { spanId: Schema.String },
	GotSpanDialogMessage: { message: Dialog.Message },
	GotSpanPanelMessage: { message: SpanPanelMessage },
	/** `null`: the pressed tab clicked again, which keeps it. */
	PickedSpanTab: { tab: Schema.NullOr(SpanDetailTab) },
	ClickedCloseSpan: {},
	GotCloseTooltipMessage: { message: Tooltip.Message },
	/** Base UI opens a tooltip on keyboard focus only: what `:focus-visible` said of a focus. */
	CheckedCloseFocus: { triggerId: Schema.String, isFocusVisible: Schema.Boolean },
	/** The popover's "Open in Traces view": close it, cross, and land on the row. */
	ClickedOpenInTraceView: {},
	PressedSpanKey: { key: Schema.Literals(["Next", "Previous", "Open", "Escape"]) },
})
export type Message = typeof Message.Type
