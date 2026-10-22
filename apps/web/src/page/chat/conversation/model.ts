import { MarkdownDocument } from "@foldkit/markdown"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import { HighlightedCode } from "../kit/code-highlight"
import { MinimapState } from "../kit/turn-minimap"
import { ChatStatus, UIMessage } from "../kit/ui-message"

// One conversation (`ChatConversation` + `useMapleChat`): its transcript, composer and live tail.

/** Why the thread cannot be replied to; `null` is a normal, writable conversation. */
export const ReadOnly = Schema.NullOr(Schema.Literals(["shared", "resolved", "transcript"]))
export type ReadOnly = typeof ReadOnly.Type

/** The live tail: `generation` names it so a superseded tail's events are dropped. */
export const ActiveStream = Schema.Struct({ generation: Schema.Number, cursor: Schema.Number })
export type ActiveStream = typeof ActiveStream.Type

/** A send that never reached the server; `message` is the raw text, retried as typed. */
export const FailedSend = Schema.Struct({ message: Schema.String, error: Schema.String })

export const Approval = Schema.Literals(["applied", "denied"])

export const Model = Schema.Struct({
	tabId: Schema.String,
	/** `<orgId>:<tabId>`. */
	sessionId: Schema.String,
	readOnly: ReadOnly,
	/** False until the durable history has been read. */
	historyReady: Schema.Boolean,
	/** The durable history could not be read: the thread is unknown, not empty, until a retry reads it. */
	historyError: Schema.NullOr(Schema.String),
	messages: Schema.Array(UIMessage),
	status: ChatStatus,
	error: Schema.NullOr(Schema.String),
	failedSend: Schema.NullOr(FailedSend),
	stream: Schema.NullOr(ActiveStream),
	/** Bumped by every send, stop and history load: results for an older one are stale. */
	generation: Schema.Number,
	/** The last folded event's seq; a reconnected tail never folds an event twice. */
	lastSeq: Schema.Number,
	/** The composer's text, read on submit. */
	draft: Schema.String,
	/** Expanded tool rows and groups, by id. */
	openPanels: Schema.Array(Schema.String),
	copies: Schema.Record(Schema.String, CopyButton.Model),
	resolvedApprovals: Schema.Record(Schema.String, Approval),
	/** Approvals with a decision in flight. */
	decidingApprovals: Schema.Array(Schema.String),
	/** ```chart fences: each plot's interaction state, by the fence's source. */
	charts: Schema.Record(Schema.String, Chart.Model),
	/** The lazily loaded plotting runtime; `null` until a chart fence asks for it. */
	chartRuntime: Schema.NullOr(ChartRuntime),
	themeColors: Schema.NullOr(ThemeColors),
	minimap: MinimapState,
	/** sugar-high tokens by fence (`highlightKey`). */
	highlights: Schema.Record(Schema.String, HighlightedCode),
	/** Each sub-agent row's sheet, by its tool call. */
	taskSheets: Schema.Record(Schema.String, Dialog.Model),
	/** Markdown parses of the bodies on screen, by text; `isStale` holds an earlier version's parse until its own lands. */
	markdown: Schema.Record(
		Schema.String,
		Schema.Struct({ document: Schema.NullOr(MarkdownDocument), isStale: Schema.Boolean }),
	),
	/** Texts with a parse in flight; a streaming body extending one waits for it (one parse at a time). */
	markdownPending: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

export const isLoading = (model: Model): boolean =>
	model.status === "submitted" || model.status === "streaming"
