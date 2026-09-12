// What the AI agent-session tools share: the window pair every session read
// takes, the paged span load the derivations run on, and the few rendering
// primitives more than one tool prints.
//
// Everything here is about the `maple_ai.*` agent traces — not the browser
// session replays `search_sessions` serves.

import { Effect } from "effect"
import { GetAiSessionSpansRequest, type AiSessionSpan, type AiSessionSpanScope } from "@maple/domain/http"
import { classifyAiSpan, spanEndMs, spanStartMs } from "@maple/agent-sessions"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { readAiSessionSpans, resolveAiSessionWindow } from "@/services/ai-sessions/ai-session-reads"
import type { TenantContext } from "@/services/auth/AuthService"
import { toMcpQueryError, warehouseReadHandlers } from "@/mcp/lib/map-warehouse-error"
import { optionalTimeParam, type McpToolResult } from "@/mcp/tools/types"

/**
 * Warehouse failures from the AI-session reads, as MCP query errors.
 *
 * The READ handlers rather than the full warehouse set: these reads resolve the
 * org's saved settings but never mint a raw-SQL token, so a handler for a tag
 * their channel cannot carry does not typecheck.
 */
export const agentSessionWarehouseHandlers = (tool: string) =>
	warehouseReadHandlers((error) => Effect.fail(toMcpQueryError(tool)(error)))

/** The sentinel a 413 is caught into — `Effect.catchTag` needs a value, and a
 *  literal narrows where a shape union does not. */
export const SESSION_TOO_LARGE = "session-too-large" as const

/** One page of a session's spans — the ceiling the `/spans` read enforces. */
const AGENT_SESSION_PAGE_SPANS = 2_000

/**
 * Spans one tool call will load for a session. Two pages: past that, the
 * derivations are summarising a session the answer cannot claim to describe,
 * so the tools say so and point at the paged span list instead.
 */
export const MCP_AGENT_SESSION_MAX_SPANS = 4_000

/** The bounds a session read is pruned by, as the request classes take them. */
export interface SessionWindow {
	readonly startTime: string
	readonly endTime: string
}

/**
 * The window pair, shared by every session-scoped tool.
 *
 * Both bounds or neither: a lone bound would pin one end of the read to
 * whatever the other end resolved to. With the pair the read is a seek on both
 * levels (detection and fan-out), which is why the list hands the row's own
 * bounds to its next steps; without it the session's bounds are resolved from
 * the id first, at the cost of a round trip.
 */
export const sessionWindowParams = {
	start_time: optionalTimeParam(
		"Start of the session's own window, from a `list_agent_sessions` row. Pass with end_time (both or neither) — it makes the read a seek instead of a lookup.",
	),
	end_time: optionalTimeParam("End of the session's own window, from a `list_agent_sessions` row."),
}

export type SessionWindowParams = {
	readonly start_time?: string | undefined
	readonly end_time?: string | undefined
}

export type SessionWindowInput =
	| { readonly _tag: "window"; readonly window: SessionWindow | undefined }
	| { readonly _tag: "invalid"; readonly result: McpToolResult }

/** Read the window pair off a tool's params, rejecting a lone bound. */
export function sessionWindowOf(params: SessionWindowParams): SessionWindowInput {
	const { start_time, end_time } = params
	if (start_time !== undefined && end_time !== undefined) {
		return { _tag: "window", window: { startTime: start_time, endTime: end_time } }
	}
	if (start_time === undefined && end_time === undefined) return { _tag: "window", window: undefined }
	return {
		_tag: "invalid",
		result: {
			isError: true,
			content: [
				{
					type: "text",
					text: "start_time and end_time are a pair — pass both (the session's own bounds, as `list_agent_sessions` reports them) or neither.",
				},
			],
		},
	}
}

/**
 * A window as a next-step hint, with the end rounded up to the whole second.
 *
 * Time parameters decode through `WarehouseTimeInput`, which truncates to
 * seconds — so handing back a session's own end verbatim would cut the last
 * fraction of a second, and with it the session's final spans.
 */
export function windowHint(window: SessionWindow): string {
	const endMs = parseWarehouseDateTime(window.endTime)
	const start = formatWarehouseDateTime(parseWarehouseDateTime(window.startTime))
	const end = formatWarehouseDateTime(Math.ceil(endMs / 1000) * 1000)
	return `start_time="${start}" end_time="${end}"`
}

export interface LoadedAgentSessionSpans {
	readonly spans: readonly AiSessionSpan[]
	/** The session has spans past what was loaded — the END of it is missing. */
	readonly truncated: boolean
	/** The spans' own extent, or the caller's window for an empty session. */
	readonly window: SessionWindow | undefined
}

/**
 * Every span of a session the derivations can be run on, up to
 * {@link MCP_AGENT_SESSION_MAX_SPANS}.
 *
 * The window is resolved once, not per page: a page read with no window pays
 * its own resolve round trip, and the second page's bounds must still cover the
 * whole session rather than the first page's extent.
 */
export const loadAgentSessionSpans = Effect.fn("mcp.loadAgentSessionSpans")(function* (
	tenant: TenantContext,
	opts: {
		readonly sessionId: string
		readonly window: SessionWindow | undefined
		readonly scope: AiSessionSpanScope
	},
) {
	const window = opts.window ?? (yield* resolveAiSessionWindow(tenant, opts.sessionId)).window
	if (window === undefined) {
		return { spans: [], truncated: false, window: undefined } satisfies LoadedAgentSessionSpans
	}

	const spans: AiSessionSpan[] = []
	let after = undefined as GetAiSessionSpansRequest["after"]
	let truncated = false
	while (spans.length < MCP_AGENT_SESSION_MAX_SPANS) {
		const page = yield* readAiSessionSpans(
			tenant,
			new GetAiSessionSpansRequest({
				sessionId: opts.sessionId,
				scope: opts.scope,
				limit: AGENT_SESSION_PAGE_SPANS,
				...window,
				...(after !== undefined && { after }),
			}),
		)
		spans.push(...page.data)
		after = page.nextCursor
		if (after === undefined) break
		truncated = spans.length >= MCP_AGENT_SESSION_MAX_SPANS
	}

	return {
		spans,
		truncated,
		// The spans' own extent, so a next step built from it reads the session
		// rather than the padded bounds the id resolved to.
		window: spans.length === 0 ? window : extentOf(spans),
	} satisfies LoadedAgentSessionSpans
})

function extentOf(spans: readonly AiSessionSpan[]): SessionWindow {
	const startMs = spans.reduce((min, span) => Math.min(min, spanStartMs(span)), Number.POSITIVE_INFINITY)
	const endMs = spans.reduce((max, span) => Math.max(max, spanEndMs(span)), Number.NEGATIVE_INFINITY)
	return { startTime: formatWarehouseDateTime(startMs), endTime: formatWarehouseDateTime(endMs) }
}

/**
 * A captured payload, cut to what the answer can carry. The true size rides
 * along so the reader knows what it is not seeing.
 */
export function clipPayload(text: string, chars: number): string {
	if (text.length <= chars) return text
	const bytes = new TextEncoder().encode(text).length
	return `${text.slice(0, chars)}… (${bytes} bytes total)`
}

/** Offset from a session's (or a page's) first span. */
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

/** The tool's answer to a 413 — the one failure a narrower request fixes. */
export function sessionTooLargeResult(sessionId: string): McpToolResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: `Session ${sessionId} is too large to load in one response. Pass the session's own start_time/end_time to narrow the read, or page its spans with \`list_agent_session_spans\` instead.`,
			},
		],
	}
}
