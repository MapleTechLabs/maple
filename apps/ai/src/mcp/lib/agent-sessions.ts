// What the AI agent-session tools share: the window pair every session read
// takes, the paged span load the derivations run on, and the few primitives
// more than one tool prints. These are the `maple_ai.*` agent traces, not the
// browser session replays `search_sessions` serves.

import { Effect, Schema } from "effect"
import {
	AI_SESSION_SPANS_MAX_SPANS,
	GetAiSessionSpansRequest,
	type AiSessionSpan,
	type AiSessionTooLargeError,
} from "@maple/domain/http"
import type { AiGenAiField, MutableAiGenAiValues } from "@maple/domain/gen-ai"
import { classifyAiSpan, lastUserMessageText, padSessionWindow } from "@maple/agent-sessions"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import * as P from "./params"
import {
	readAiSessionSpans,
	resolveAiSessionWindow,
} from "@maple/backend/services/ai-sessions/ai-session-reads"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { McpInvalidInputError, McpQueryBudgetError } from "../tools/types"
import { formatNumber } from "./format"

/** Spans one call loads; past it the answer covers the session's beginning. */
export const MCP_AGENT_SESSION_MAX_SPANS = 5 * AI_SESSION_SPANS_MAX_SPANS

/** Smallest page a 413 is retried at. The byte cap trips on ROW WEIGHT, so the
 *  same page with fewer rows is what the failure asks for — the page's own
 *  loader halves the same way. */
const MIN_PAGE_SPANS = 125

/** Characters kept per string inside a retained message. */
const MESSAGE_TEXT_CHARS = 500

/** Characters kept per string inside a retained tool payload. */
const PAYLOAD_TEXT_CHARS = 1_000

/** The two captured JSON fields that are conversation histories — the only
 *  ones a whole-session read drops entries from. */
const MESSAGE_FIELDS = ["inputMessages", "outputMessages"] as const satisfies ReadonlyArray<AiGenAiField>

/** The rest of the captured JSON. An array here is a tool result, a tool
 *  catalog, a document set or a multi-part instruction — dropping entries from
 *  one loses facts rather than conversation, so only its strings are cut. */
const PAYLOAD_FIELDS = [
	"toolCallArguments",
	"toolCallResult",
	"toolDefinitions",
	"systemInstructions",
	"retrievalDocuments",
	"memoryRecords",
] as const satisfies ReadonlyArray<AiGenAiField>

const clipText = (value: string, chars: number): string =>
	value.length <= chars ? value : `${value.slice(0, chars)}…`

/** BOUNDARY: every string inside a captured value, cut. The shape is the
 *  vendor's own JSON, which this walks rather than parses. */
const clipStrings = (value: unknown, chars: number): unknown => {
	if (typeof value === "string") return clipText(value, chars)
	if (Array.isArray(value)) return value.map((entry) => clipStrings(entry, chars))
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, clipStrings(entry, chars)]),
		)
	}
	return value
}

/** The newest user message and the last one — the turn label the derivations
 *  read is that message, found by the reader `turnLabel` itself uses. */
const keptMessages = (messages: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
	const last = messages.length - 1
	if (last < 0) return messages
	for (let i = last - 1; i >= 0; i--) {
		if (lastUserMessageText([messages[i]]) !== undefined) return [messages[i], messages[last]]
	}
	return [messages[last]]
}

/** A span's content cut to what a whole-session read retains; a tool needing
 *  one span in full reads it on its own (`inspect_span`). */
export function clipSpanContent(span: AiSessionSpan): AiSessionSpan {
	const genAi: MutableAiGenAiValues = { ...span.genAi }
	for (const field of MESSAGE_FIELDS) {
		const value = genAi[field]
		if (value === undefined) continue
		genAi[field] = Array.isArray(value)
			? keptMessages(value).map((message) => clipStrings(message, MESSAGE_TEXT_CHARS))
			: clipStrings(value, MESSAGE_TEXT_CHARS)
	}
	for (const field of PAYLOAD_FIELDS) {
		const value = genAi[field]
		if (value === undefined) continue
		genAi[field] = clipStrings(value, PAYLOAD_TEXT_CHARS)
	}
	return { ...span, genAi }
}

/** The bounds a session read is pruned by, as the request classes take them. */
export interface SessionWindow {
	readonly startTime: NonNullable<GetAiSessionSpansRequest["startTime"]>
	readonly endTime: NonNullable<GetAiSessionSpansRequest["endTime"]>
}

/** The window pair, both bounds or neither: with it the read is a seek on both
 *  levels, without it the session's bounds cost a resolve round trip first. */
export const sessionWindowParams = {
	start_time: P.optionalTimestamp(
		"Start of the session's window (both bounds or neither; pass them as the `get_agent_session` call suggested by `list_agent_sessions` carries them, which makes the read a seek rather than a lookup)",
	),
	end_time: P.optionalTimestamp("End of the session's window (see start_time)"),
}

/** Both bounds are the decoded brand, so a tool cannot pass a raw string. */
export type SessionWindowParams = {
	readonly [K in keyof typeof sessionWindowParams]?: (typeof sessionWindowParams)[K]["Type"]
}

/** The pair as a window, or none; a lone bound is an input error naming the pair. */
export const sessionWindowFrom = (
	params: SessionWindowParams,
): Effect.Effect<SessionWindow | undefined, McpInvalidInputError> => {
	const { start_time, end_time } = params
	if ((start_time === undefined) !== (end_time === undefined)) {
		return Effect.fail(
			new McpInvalidInputError({
				message:
					"start_time and end_time are a pair: pass both (the bounds the `get_agent_session` call under a `list_agent_sessions` row carries) or neither.",
				parameter: start_time === undefined ? "start_time" : "end_time",
			}),
		)
	}
	return Effect.succeed(
		start_time !== undefined && end_time !== undefined
			? { startTime: start_time, endTime: end_time }
			: undefined,
	)
}

/** A list row's bounds as the window a next `get_agent_session` call passes, padded the way
 *  the page pads the same row (`padSessionWindow`). A row's bounds are the extent of its AGENT
 *  spans and both read levels bound on `Timestamp`, so handing them over verbatim drops the app
 *  spans around them. The pad also absorbs the sub-second end a whole-second param truncates. A
 *  bound `Date.parse` cannot read goes back verbatim. */
export function paddedWindowArgs(window: { readonly startTime: string; readonly endTime: string }): {
	readonly start_time: string
	readonly end_time: string
} {
	const startMs = parseWarehouseDateTime(window.startTime)
	const endMs = parseWarehouseDateTime(window.endTime)
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
		return { start_time: window.startTime, end_time: window.endTime }
	}
	const padded = padSessionWindow(startMs, endMs)
	return { start_time: padded.startTime, end_time: padded.endTime }
}

/** The sentinel a caught 413 hands back: retry this page smaller. */
const HALVE: "halve" = "halve"

/**
 * Every span of a session the derivations run on, up to
 * {@link MCP_AGENT_SESSION_MAX_SPANS} and clipped page by page; `truncated`
 * says the END of the session is missing, and which ceiling stopped the read.
 * The window is resolved once, not per page: every page's bounds must cover
 * the session, not the first page.
 */
export const loadAgentSessionSpans = Effect.fn("loadAgentSessionSpans")(function* (
	tenant: TenantContext,
	opts: { readonly sessionId: string; readonly window: SessionWindow | undefined },
) {
	yield* Effect.annotateCurrentSpan("maple.ai.window_source", opts.window ? "client" : "resolved")
	const window = opts.window ?? (yield* resolveAiSessionWindow(tenant, opts.sessionId)).window
	if (window === undefined) {
		yield* Effect.annotateCurrentSpan("maple.ai.found", false)
		return { spans: [], truncated: false as const, window: undefined }
	}

	const spans: AiSessionSpan[] = []
	let after = undefined as GetAiSessionSpansRequest["after"]
	let limit = AI_SESSION_SPANS_MAX_SPANS
	let truncated: "cap" | "too_large" | false = false
	while (spans.length < MCP_AGENT_SESSION_MAX_SPANS) {
		const page = yield* readAiSessionSpans(
			tenant,
			new GetAiSessionSpansRequest({
				sessionId: opts.sessionId,
				limit: Math.min(limit, MCP_AGENT_SESSION_MAX_SPANS - spans.length),
				...window,
				...(after !== undefined && { after }),
			}),
		).pipe(
			// A 413 is the BYTE cap, and the sessions this tool exists for are
			// exactly the ones whose heavy spans trip it on page one — so the same
			// page is retried at half the rows, down to the floor. Past that the
			// pages in hand are the session's beginning, and a first page that
			// cannot be read even at the floor fails the call.
			Effect.catchTag("@maple/http/ai-sessions/AiSessionTooLargeError", (error) =>
				limit > MIN_PAGE_SPANS
					? Effect.succeed(HALVE)
					: spans.length === 0
						? Effect.fail(error)
						: Effect.succeed(undefined),
			),
		)
		if (page === HALVE) {
			limit = Math.max(MIN_PAGE_SPANS, Math.floor(limit / 2))
			continue
		}
		if (page === undefined) {
			truncated = "too_large"
			break
		}
		for (const row of page.data) spans.push(clipSpanContent(row))
		after = page.nextCursor
		if (after === undefined) break
		truncated = spans.length >= MCP_AGENT_SESSION_MAX_SPANS ? "cap" : false
	}
	yield* Effect.annotateCurrentSpan({
		"maple.ai.span_count": spans.length,
		"maple.ai.page_limit": limit,
		"maple.ai.truncated": truncated,
	})

	return { spans, truncated, window }
})

/** How much of a session a load read: which ceiling stopped it, and for the byte cap (the one a
 *  narrower window fixes) the absolute `start_time` the next call resumes from. */
export function loadSummary(load: {
	readonly spans: ReadonlyArray<AiSessionSpan>
	readonly truncated: "cap" | "too_large" | false
}): {
	readonly spans: number
	readonly truncated: "none" | "cap" | "too_large"
	readonly resumeStartTime?: string
} {
	if (load.truncated !== "too_large") {
		return { spans: load.spans.length, truncated: load.truncated === false ? "none" : "cap" }
	}
	const last = load.spans[load.spans.length - 1]
	const resumeMs = last === undefined ? Number.NaN : parseWarehouseDateTime(last.timestamp)
	return {
		spans: load.spans.length,
		truncated: "too_large",
		...(Number.isNaN(resumeMs) ? undefined : { resumeStartTime: formatWarehouseDateTime(resumeMs) }),
	}
}

/** The sentence a truncated load reads as. Without one the model has no bound to narrow
 *  towards but the session's own. */
export function truncationNote(load: ReturnType<typeof loadSummary>): string | undefined {
	if (load.truncated === "none") return undefined
	const count = formatNumber(load.spans)
	if (load.truncated === "cap") {
		return `Loaded the first ${count} spans of this session (the cap); every figure below covers those spans only.`
	}
	const resume =
		load.resumeStartTime === undefined
			? "a narrower start_time/end_time"
			: `start_time="${load.resumeStartTime}" with the same end_time`
	return `Loaded the first ${count} spans; the rest exceeded the response byte limit. Pass ${resume} to read the remainder.`
}

/** The tool's answer to a 413, the one failure a narrower request fixes:
 *  `Effect.catchTag("@maple/http/ai-sessions/AiSessionTooLargeError", sessionTooLarge(...))`. */
export const sessionTooLarge =
	(tool: string, recovery: string) =>
	(error: AiSessionTooLargeError): Effect.Effect<never, McpQueryBudgetError> =>
		Effect.fail(
			new McpQueryBudgetError({
				message: `${error.message} ${recovery}`,
				pipeName: tool,
				setting: "max_response_bytes",
			}),
		)

const encoder = new TextEncoder()

/** A captured payload cut to what the answer carries, true size alongside. */
export function clipPayload(text: string, chars: number): string {
	return text.length <= chars
		? text
		: `${clipText(text, chars)} (${encoder.encode(text).length} bytes total)`
}

/** Offset from a session's first span. */
export function offsetLabel(ms: number): string {
	if (ms < 1000) return `+${Math.round(ms)}ms`
	if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`
	const minutes = Math.floor(ms / 60_000)
	return `+${minutes}m${Math.round((ms % 60_000) / 1000)}s`
}

/** How a span reads: the four categories the session model classifies into. */
export function spanCategoryLabel(span: AiSessionSpan): string {
	const category = classifyAiSpan(span)
	return category === "other" ? "app" : category
}
