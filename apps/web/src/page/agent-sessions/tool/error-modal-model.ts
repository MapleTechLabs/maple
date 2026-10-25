import { AiToolErrorSampleCursor } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"

// The tool error modal's state:
// one error group of the tool in full, open while `?error=` names a row the Errors table holds.

export const ToolErrorSessionRow = Schema.Struct({
	sessionId: Schema.String,
	vendorId: Schema.String,
	agentName: Schema.String,
	service: Schema.String,
	hits: Schema.Number,
	lastSeen: Schema.Number,
})

export const ToolErrorVariantRow = Schema.Struct({
	message: Schema.String,
	calls: Schema.Number,
	lastSeen: Schema.Number,
})

export const ToolErrorBreakdownRow = Schema.Struct({
	model: Schema.String,
	service: Schema.String,
	calls: Schema.Number,
})

/** `getAiToolErrorDetail`: the sessions it hit, the raw texts it folded, where it happens. */
export const ErrorDetail = Schema.Struct({
	sessions: Schema.Array(ToolErrorSessionRow),
	variants: Schema.Array(ToolErrorVariantRow),
	breakdown: Schema.Array(ToolErrorBreakdownRow),
})
export type ErrorDetail = typeof ErrorDetail.Type

export const ToolErrorOccurrenceRow = Schema.Struct({
	timestamp: Schema.Number,
	traceId: Schema.String,
	spanId: Schema.String,
	sessionId: Schema.String,
	vendorId: Schema.String,
	agentName: Schema.String,
	model: Schema.String,
	service: Schema.String,
	errorType: Schema.String,
	message: Schema.String,
	durationNs: Schema.Number,
	statusCode: Schema.String,
	arguments: Schema.String,
	argumentsBytes: Schema.Number,
	result: Schema.String,
	resultBytes: Schema.Number,
})
export type ToolErrorOccurrenceRow = typeof ToolErrorOccurrenceRow.Type

/** One page of a group's failed calls, newest first. */
export const SamplesPage = Schema.Struct({
	occurrences: Schema.Array(ToolErrorOccurrenceRow),
	nextCursor: Schema.optional(AiToolErrorSampleCursor),
})
export type SamplesPage = typeof SamplesPage.Type

const SamplesSlot = KeyedSchema(SamplesPage, LoadFailure)

export const CopyState = Schema.Literals(["idle", "copied", "failed"])
export type CopyState = typeof CopyState.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	/** The group the modal reads; `null` while it is closed. */
	fingerprint: Schema.NullOr(Schema.String),
	detail: KeyedSchema(ErrorDetail, LoadFailure),
	/** The narrowing the pages extend (`JSON.stringify` of the samples input) and one slot per page. */
	samplesKey: Schema.String,
	pages: Schema.Array(SamplesSlot),
	/** `SamplesPane`: the open sample, and whether the reader closed it. */
	selected: Schema.Number,
	isSampleClosed: Schema.Boolean,
	linkCopy: CopyState,
	/** The open sample's `ArgumentsBlock`: the full payload shown, and its copy. */
	isFullArguments: Schema.Boolean,
	argumentsCopy: CopyState,
})
export type Model = typeof Model.Type

export const MODAL_ID = "agent-tool-error"

export const init = (): Model => ({
	dialog: Dialog.init(MODAL_ID, "dialog"),
	fingerprint: null,
	detail: { key: null, data: { _tag: "Idle" } },
	samplesKey: "",
	pages: [],
	selected: 0,
	isSampleClosed: false,
	linkCopy: "idle",
	isFullArguments: false,
	argumentsCopy: "idle",
})

export const ModalKey = Schema.Literals(["StepUp", "StepDown", "OlderSample", "NewerSample"])
export type ModalKey = typeof ModalKey.Type

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	CompletedFetchDetail: { key: Schema.String, result: Schema.Result(ErrorDetail, LoadFailure) },
	CompletedFetchSamples: { key: Schema.String, result: Schema.Result(SamplesPage, LoadFailure) },
	ClickedLoadMore: {},
	ClickedSample: { index: Schema.Number },
	PressedModalKey: { key: ModalKey },
	ClickedStep: { offset: Schema.Literals([-1, 1]) },
	ClickedVariant: { variant: Schema.UndefinedOr(Schema.String) },
	ClickedSession: { session: Schema.UndefinedOr(Schema.String) },
	ClickedClose: {},
	ClickedCopyLink: {},
	CompletedCopyLink: { isCopied: Schema.Boolean },
	ClickedCopyArguments: { text: Schema.String },
	CompletedCopyArguments: { isCopied: Schema.Boolean },
	ToggledFullArguments: {},
	CompletedScrollSample: {},
})
export type Message = typeof Message.Type
