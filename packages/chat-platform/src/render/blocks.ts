/**
 * What an agent turn looks like once it has stopped being Maple's event stream and has not yet
 * become any platform's message format.
 *
 * A block is the unit both halves agree on: the renderer decides what the turn *says*, a connector
 * decides how its platform *shows* it. The split is what keeps a markdown dialect, an embed, a
 * button component and a mention syntax inside one directory each.
 */
import type { ChartSpec } from "@maple/domain/chat-chart-spec"
import type { ChatSessionId } from "@maple/domain/chat-session"
import type { ChatActionToken } from "../action-token"

/** Standard markdown, with chart fences and entity annotations already lifted out of it. */
export interface ChatProseBlock {
	readonly kind: "prose"
	readonly markdown: string
}

/**
 * A ```chart fence the model wrote.
 *
 * `imageUrl` is whatever {@link ChatRenderContext.chartImageUrl} minted; a platform that cannot
 * show an image — or a turn whose charts have no image — falls back to `summary`, so the numbers
 * are never simply lost.
 */
export interface ChatChartBlock {
	readonly kind: "chart"
	readonly spec: ChartSpec
	/** The spec's unit, resolved to one Maple formats by (`normalizeUnit`). */
	readonly unit: string
	readonly title: string | null
	/** One line that stands in for the plot: what it charts and how much of it there is. */
	readonly summary: string
	readonly imageUrl: string | null
}

export type ChatEntityKind = "trace" | "service" | "error" | "log"

/** A `<<maple:…>>` card, as a label, a line of context and a link into the Maple app. */
export interface ChatEntityBlock {
	readonly kind: "entity"
	readonly entity: ChatEntityKind
	readonly label: string
	readonly detail: string | null
	/** Null where the app has no detail page to open — an error type, a log with no trace. */
	readonly url: string | null
}

export interface ChatToolActivity {
	/** What the call is doing, as a phrase (`Running a query`) — never the tool's raw name. */
	readonly label: string
	readonly status: "running" | "done" | "failed"
	/** A sub-agent's progress, for a `task_*` call. */
	readonly detail: string | null
}

/**
 * What the agent is doing, as a status line rather than a card. A chat message is read in a
 * channel between other people's messages; a per-tool card turns one answer into a wall.
 */
export interface ChatActivityBlock {
	readonly kind: "activity"
	readonly tools: ReadonlyArray<ChatToolActivity>
}

/**
 * What came of a proposal, once somebody decided it — read out of the `tool-result` the session
 * recorded (see `approval-outcome.ts`), never that result verbatim.
 */
export interface ChatApprovalOutcome {
	readonly approved: boolean
	/** Who decided: `Approved by Ada.` */
	readonly decision: string
	/** What came of it, as one sentence in the bot's voice. Empty when there is nothing to add. */
	readonly text: string
	/** Where the change can be seen in Maple. */
	readonly url: string | null
}

/**
 * How much of a decided proposal's result a channel is worth showing; the rest is in Maple.
 *
 * A ceiling rather than a guideline: the cutting charges every approval for it whether or not the
 * proposal has been decided, so deciding one can never move its block into a different platform
 * message from the one that carried the controls.
 */
export const MAX_APPROVAL_OUTCOME_CHARS = 200

/** A mutation the agent paused on. The tool has NOT run; someone has to say yes. */
export interface ChatApprovalBlock {
	readonly kind: "approval"
	readonly toolName: string
	/** The call's arguments, in a sentence a reader can act on without reading JSON. */
	readonly summary: string
	readonly token: ChatActionToken
	/**
	 * Null while the proposal is still open, which is also when a connector gives it controls.
	 *
	 * A settled proposal keeps its block rather than disappearing: a reader coming back to the
	 * thread needs to see what was asked for as well as what came of it — and keeping the block
	 * count fixed is what lets the settling edit address the same platform message that carried the
	 * controls.
	 */
	readonly outcome: ChatApprovalOutcome | null
}

export interface ChatNoticeBlock {
	readonly kind: "notice"
	/** `pending` is the turn still running; `error` is the turn that did not finish. */
	readonly tone: "pending" | "info" | "error"
	readonly text: string
}

export interface ChatAlertField {
	readonly label: string
	/** Standard markdown. */
	readonly value: string
}

export interface ChatAlertLink {
	readonly label: string
	readonly url: string
	/** The one action the alert leads with, where the platform can emphasise a button. */
	readonly primary: boolean
}

/**
 * A notification Maple posts on its own — an alert firing or resolving — rather than a turn.
 *
 * A card rather than prose because an alert read in a busy channel needs what a card gives: the
 * state as a colour bar, the facts as labelled fields, and the links as buttons.
 */
export interface ChatAlertBlock {
	readonly kind: "alert"
	/** `#rrggbb`: the state and severity, as the bar beside the card. */
	readonly color: string
	/** Plain text, emoji included. Never parsed as markup. */
	readonly title: string
	/** Standard markdown: what happened, in a sentence — or a rule's own templated body. */
	readonly summary: string
	readonly fields: ReadonlyArray<ChatAlertField>
	readonly imageUrl: string | null
	/** What the image shows, for a screen reader and for a platform that will not load it. */
	readonly imageAlt: string
	readonly links: ReadonlyArray<ChatAlertLink>
	/** Standard markdown fragments, shown small under the card and joined by the connector. */
	readonly footer: ReadonlyArray<string>
	/** When it was sent, epoch ms, for a connector that can show it in each reader's own timezone. */
	readonly sentAtMs: number | null
}

export type ChatBlock =
	| ChatProseBlock
	| ChatChartBlock
	| ChatEntityBlock
	| ChatActivityBlock
	| ChatApprovalBlock
	| ChatNoticeBlock
	| ChatAlertBlock

/** Which chart, for the port that mints an image of it. */
export interface ChatChartRef {
	readonly sessionId: ChatSessionId
	readonly messageId: string
	/**
	 * Position among this message's chart fences, counted in order of appearance from zero.
	 *
	 * The ordering rule matters more than the number: whatever renders the image has to count the
	 * same fences the same way, or a turn with two charts shows each of them the other's plot.
	 */
	readonly chartIndex: number
	readonly spec: ChartSpec
}

export interface ChatRenderContext {
	/** Base of the Maple web app (`https://app.maple.dev`), without a trailing slash. */
	readonly appBaseUrl: string
	readonly sessionId: ChatSessionId
	/**
	 * An image for a chart, or null when none is available. A port rather than a renderer: minting
	 * one means signing a URL against a service that renders it, which this package does not do.
	 */
	readonly chartImageUrl: (ref: ChatChartRef) => string | null
}
