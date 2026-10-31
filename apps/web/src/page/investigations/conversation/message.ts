import { ChatEvent } from "@maple/domain/chat-session"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { ParsedMarkdown } from "../../kit/markdown"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import { MinimapMessage } from "./kit/turn-minimap"
import { UIMessage } from "./kit/ui-message"

export const History = Schema.Struct({
	messages: Schema.Array(UIMessage),
	cursor: Schema.Number,
	running: Schema.Boolean,
})
export type History = typeof History.Type

export const Sent = Schema.Struct({ cursor: Schema.Number, messageId: Schema.String })

/** The `chat.apply` answer: a failed apply carries the tool's own text. */
export const ApplyOutcome = Schema.Struct({ isError: Schema.Boolean, content: Schema.String })

export const Message = defineMessageUnion({
	CompletedLoadHistory: { generation: Schema.Number, result: Schema.Result(History, Schema.String) },
	ClickedRetryHistory: {},
	ChangedDraft: { text: Schema.String },
	/** The form's submit (the button, or Enter in the textarea). */
	SubmittedComposer: {},
	ClickedSuggestion: { text: Schema.String },
	ClickedRetrySend: { text: Schema.String },
	ClickedContinue: {},
	ClickedStop: {},
	CompletedPostMessage: {
		generation: Schema.Number,
		localId: Schema.String,
		text: Schema.String,
		result: Schema.Result(Sent, Schema.String),
	},
	ReceivedChatEvents: { generation: Schema.Number, events: Schema.Array(ChatEvent), nowMs: Schema.Number },
	FailedChatStream: { generation: Schema.Number, message: Schema.String },
	CompletedAbortTurn: {},
	ToggledPanel: { id: Schema.String },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
	CompletedParseMarkdown: { parsed: Schema.Array(ParsedMarkdown) },
	ClickedCopyCode: { code: Schema.String },
	ClickedDownloadCode: { code: Schema.String, language: Schema.String },
	CompletedCodeAction: {},
	CompletedMountJump: {},
	CompletedMountClock: {},
	GotTaskSheetMessage: { toolCallId: Schema.String, message: Dialog.Message },
	GotChartMessage: { id: Schema.String, message: Chart.Message },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotMinimapMessage: { message: MinimapMessage },
	ClickedApprove: { toolCallId: Schema.String, tool: Schema.String },
	ClickedDeny: { toolCallId: Schema.String },
	CompletedDecideApproval: {
		toolCallId: Schema.String,
		tool: Schema.String,
		decision: Schema.Literals(["approve", "deny"]),
		result: Schema.Result(ApplyOutcome, Schema.String),
	},
})
export type Message = typeof Message.Type

/** Facts the host acts on: a toast. */
export const OutMessage = defineMessageUnion({
	RequestedToast: { type: Schema.Literals(["success", "error"]), title: Schema.String },
})
export type OutMessage = typeof OutMessage.Type
