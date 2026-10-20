import { MarkdownDocument } from "@foldkit/markdown"
import { AiSessionSpan, AiSessionSpanCursor, GetAiSessionSummaryResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { AgentSessionSearch } from "../../../route/search"
import * as Canvas from "../../../service-map/xyflow/canvas"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import { PanelState } from "../../traces/detail/span-panel/model"
import * as Popover from "../../../ui/popover"
import * as Tabs from "../../../ui/tabs"
import * as Tooltip from "../../../ui/tooltip"
import { Detections } from "../kit/detected-models"
import { VirtualWindow } from "../kit/virtualize"

export const SPAN_DETAIL_TABS = ["details", "messages", "tools", "logs"] as const
export const SpanDetailTab = Schema.Literals(SPAN_DETAIL_TABS)
export type SpanDetailTab = typeof SpanDetailTab.Type

export const ScrollRequest = Schema.Struct({
	seq: Schema.Number,
	index: Schema.Number,
	align: Schema.Literals(["auto", "center"]),
	reveal: Schema.Boolean,
})

// `/agent-sessions/$sessionId`.

export const SESSION_VIEWS = ["overview", "trace", "flow", "transcript"] as const
export type SessionView = (typeof SESSION_VIEWS)[number]

/** One page of a session's spans; `nextCursor` null when the page ended the read. */
export const SpansPage = Schema.Struct({
	data: Schema.Array(AiSessionSpan),
	nextCursor: Schema.NullOr(AiSessionSpanCursor),
})
export type SpansPage = typeof SpansPage.Type

export const SessionTotals = Schema.Struct(GetAiSessionSummaryResponse.fields)
export type SessionTotals = typeof SessionTotals.Type

/** Pages past the first, drained in the background for a session larger than one page. */
export const MorePages = Schema.Struct({
	key: Schema.String,
	agentPages: Schema.Array(SpansPage),
	appPages: Schema.Array(SpansPage),
	status: Schema.Literals(["loading", "complete", "failed"]),
	/** The page size the drain is asking at; it halves on a too-large answer. */
	limit: Schema.Number,
})
export type MorePages = typeof MorePages.Type

export const ViewOption = Schema.Literals([
	"agentSpansOnly",
	"collapseIdle",
	"mergeRepeats",
	"showThinking",
	"showPayloads",
])
export type ViewOption = typeof ViewOption.Type

export const Model = Schema.Struct({
	sessionId: Schema.String,
	search: AgentSessionSearch,
	/** The search string the session was entered from, for the back-to-list crumb. */
	searchStr: Schema.String,
	nowMs: Schema.Number,
	locale: Schema.String,
	firstPage: KeyedSchema(SpansPage, LoadFailure),
	more: MorePages,
	totals: KeyedSchema(SessionTotals, LoadFailure),
	detections: Detections,
	tabs: Tabs.Model,
	displayPopover: Popover.Model,
	/** The span filter: seeded from `?tool=`, the reader's from the first keystroke. */
	query: Schema.String,
	options: Schema.Struct({
		agentSpansOnly: Schema.Boolean,
		collapseIdle: Schema.Boolean,
		mergeRepeats: Schema.Boolean,
		showThinking: Schema.Boolean,
		showPayloads: Schema.Boolean,
	}),
	collapsedTurns: Schema.Array(Schema.String),
	openRows: Schema.Array(Schema.String),
	/** The Overview's Passed / Not checked disclosures, once the reader chose. */
	checksChoice: Schema.Struct({
		passed: Schema.NullOr(Schema.Boolean),
		skipped: Schema.NullOr(Schema.Boolean),
	}),
	/** The tool ledger row that is open. */
	ledgerOpen: Schema.NullOr(Schema.String),
	/** The span a cross-view jump landed on, highlighted until the next pick. */
	revealedSpanId: Schema.NullOr(Schema.String),
	/** The header's session id copy. */
	copy: CopyButton.Model,
	/** Markdown parses by text hash; `null` while the parse is in flight. */
	markdown: Schema.Record(
		Schema.String,
		Schema.NullOr(Schema.Struct({ document: Schema.NullOr(MarkdownDocument) })),
	),
	/** The Flow view's camera and pane, kept across view switches. */
	flowCanvas: Canvas.Model,
	/** The open flow was laid out again: its edges leave measured handles, a half pixel lower and one right. */
	isFlowRelaid: Schema.Boolean,
	/** Bodies measured as overrunning their clamp. */
	clampedBodies: Schema.Array(Schema.String),
	/** The transcript's payload copies: one status, for the payload last copied. */
	payloadCopy: Schema.Struct({ key: Schema.NullOr(Schema.String), copy: CopyButton.Model }),
	/** The virtualizers' windows, reset when the view they belong to mounts again. */
	waterfallWindow: VirtualWindow,
	transcriptWindow: VirtualWindow,
	/** The waterfall's keyboard span cursor (`useListNavigation`'s `focusedId`). */
	focusedSpanId: Schema.NullOr(Schema.String),
	/** A scroll the open view's list should make; `landed` once its `?span=` landing was spent. */
	scroll: Schema.NullOr(ScrollRequest),
	landed: Schema.Boolean,
	/** `SpanPopover`: open while the active view has a span selected (`?span=`). */
	spanDialog: Dialog.Model,
	/** The reader's tab choice, held across spans and views; `null` picks by content. */
	spanTab: Schema.NullOr(SpanDetailTab),
	/** The open span's lazy detail and logs reads, copies and disclosures, for `spanPanelId`. */
	spanPanel: PanelState,
	spanPanelId: Schema.NullOr(Schema.String),
	/** The code block whose Copy shows its check (Streamdown holds it 2s), and the hold's generation. */
	codeCopy: Schema.Struct({ code: Schema.NullOr(Schema.String), generation: Schema.Number }),
	/** The popover's Close button tooltip, shown on keyboard focus (a pasted link focuses it). */
	closeTooltip: Tooltip.Model,
})
export type Model = typeof Model.Type
