import { MarkdownDocument } from "@foldkit/markdown"
import { AiSessionSpan, AiSessionSpanCursor, GetAiSessionSummaryResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { AgentSessionSearch } from "../../../route/search"
import * as Canvas from "../../../service-map/xyflow/canvas"
import * as CopyButton from "../../../ui/copy-button"
import * as Popover from "../../../ui/popover"
import * as Tabs from "../../../ui/tabs"
import { Detections } from "../kit/detected-models"

// `/agent-sessions/$sessionId` (routes/agent-sessions/$sessionId.tsx, session-detail/*).

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
	/** The Flow view's camera and pane, kept across view switches like legacy's zoom. */
	flowCanvas: Canvas.Model,
	/** The open flow was laid out again: its edges leave measured handles, a half pixel lower and one right. */
	isFlowRelaid: Schema.Boolean,
	/** Bodies measured as overrunning their clamp. */
	clampedBodies: Schema.Array(Schema.String),
	/** The transcript's payload copies: one status, for the payload last copied. */
	payloadCopy: Schema.Struct({ key: Schema.NullOr(Schema.String), copy: CopyButton.Model }),
})
export type Model = typeof Model.Type
