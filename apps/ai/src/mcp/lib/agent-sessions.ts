// What the AI agent-session tools share: the window pair every session read
// takes, the paged span load the derivations run on, and the few primitives
// more than one tool prints. These are the `maple_ai.*` agent traces, not the
// browser session replays `search_sessions` serves.

import { Effect } from "effect"
import { type AiSessionSpan, type AiSessionTooLargeError } from "@maple/domain/http"
import { classifyAiSpan, padSessionWindow } from "@maple/agent-sessions"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import * as P from "./params"
import { McpInvalidInputError, McpQueryBudgetError } from "../tools/types"
import { formatNumber } from "./format"

export {
	AI_SESSION_LOAD_MAX_SPANS as MCP_AGENT_SESSION_MAX_SPANS,
	clipSpanContent,
	loadAiSessionSpans as loadAgentSessionSpans,
	type SessionWindow,
} from "@maple/backend/services/ai-sessions/load-session-spans"
import { clipText, type SessionWindow } from "@maple/backend/services/ai-sessions/load-session-spans"

/** The window pair, both bounds or neither: with it the read is a seek on both
 *  levels, without it the session's bounds cost a resolve round trip first. */
export const sessionWindowParams = {
	start_time: P.optionalTimestamp(
		"Start of the session's window. Copy start_time and end_time from the list_agent_sessions row (both or neither); it makes the read fast",
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
	const seconds = Math.round(ms / 1000)
	return `+${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** How a span reads: the four categories the session model classifies into. */
export function spanCategoryLabel(span: AiSessionSpan): string {
	const category = classifyAiSpan(span)
	return category === "other" ? "app" : category
}
