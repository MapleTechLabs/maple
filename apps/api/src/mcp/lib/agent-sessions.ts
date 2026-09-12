// What the AI agent-session tools share: the window pair every session read
// takes, the paged span load the derivations run on, and the few rendering
// primitives more than one tool prints.
//
// Everything here is about the `maple_ai.*` agent traces — not the browser
// session replays `search_sessions` serves.

import { Effect } from "effect"
import {
	AI_SESSION_SPANS_MAX_SPANS,
	GetAiSessionSpansRequest,
	type AiSessionSpan,
	type AiSessionSpanScope,
	type AiSessionTooLargeError,
} from "@maple/domain/http"
import { classifyAiSpan, jsonText } from "@maple/agent-sessions"
import type { MutableAiGenAiValues } from "@maple/domain/gen-ai"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { readAiSessionSpans, resolveAiSessionWindow } from "@/services/ai-sessions/ai-session-reads"
import type { TenantContext } from "@/services/auth/AuthService"
import { optionalTimeParam, validationError, type McpToolError, type McpToolResult } from "@/mcp/tools/types"

/**
 * Spans one tool call will load for a session. Five pages: an agent session
 * that runs for hours is tens of thousands of spans, and a summary derived
 * from the first two pages of one describes its beginning.
 *
 * What makes the cap affordable is {@link clipSpanContent}. A page is bounded
 * at `MAX_AI_SESSION_SPANS_RESPONSE_BYTES` (10 MB) of raw rows, so five pages
 * are up to 50 MB arriving through a 128 MB Worker isolate — but only one page
 * is raw at a time, and what is RETAINED is the clipped span: the scalars plus
 * roughly 3 KB of captured content, which is ~30 MB at the cap.
 */
export const MCP_AGENT_SESSION_MAX_SPANS = 5 * AI_SESSION_SPANS_MAX_SPANS

/** Characters kept per string inside a retained message. */
const MESSAGE_TEXT_CHARS = 500

/** Characters kept per retained tool payload, as `jsonText` renders it. */
const PAYLOAD_TEXT_CHARS = 1_000

/**
 * Message-array fields. Only the LAST message survives: the readers that run
 * over a whole loaded session want the turn label, which is the newest user
 * message the turn captured — the history before it is the same conversation
 * re-sent on every call, and it is what makes a 10 000-span session tens of
 * megabytes of one turn's prompt.
 */
const MESSAGE_FIELDS = ["inputMessages", "outputMessages", "systemInstructions"] as const

/**
 * Captured payload fields, kept as clipped text rather than as structure: the
 * findings read the first prose line of a failed tool's result, and
 * `firstProse` reads a string as readily as an object.
 */
const PAYLOAD_FIELDS = [
	"toolCallArguments",
	"toolCallResult",
	"toolDefinitions",
	"retrievalDocuments",
	"memoryRecords",
] as const

/** A captured value after the clip: the JSON it already was, with every string
 *  cut. Captured fields are decoded JSON by the time they reach a span, so this
 *  is the whole vocabulary. */
type ClippedCapture =
	| string
	| number
	| boolean
	| null
	| undefined
	| ReadonlyArray<ClippedCapture>
	| { readonly [key: string]: ClippedCapture }

/** Every string inside a captured value, cut to `chars`. The shape belongs to
 *  the vendor, so this walks it instead of assuming `{ role, parts }`: what the
 *  readers need is the structure, and what costs the isolate its memory is the
 *  text inside it. */
const clipStrings = (value: unknown, chars: number): ClippedCapture => {
	if (typeof value === "string") return value.length <= chars ? value : `${value.slice(0, chars)}…`
	if (Array.isArray(value)) return value.map((entry) => clipStrings(entry, chars))
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, clipStrings(entry, chars)]),
		)
	}
	// A number, a boolean or a value the emitter left null — nothing to cut.
	return value as ClippedCapture
}

/**
 * A span with its captured content cut to what a whole-session read retains.
 *
 * Applied per page as it is mapped, so the raw rows of a page are collectable
 * before the next one is read. A tool that needs a span's content in full
 * reads that span on its own — `inspect_span` decodes it from its own trace.
 */
const clipSpanContent = (span: AiSessionSpan): AiSessionSpan => {
	const genAi: MutableAiGenAiValues = { ...span.genAi }
	for (const field of MESSAGE_FIELDS) {
		const value = genAi[field]
		if (value === undefined) continue
		// A non-array capture is one message already.
		genAi[field] = Array.isArray(value)
			? value.slice(-1).map((message) => clipStrings(message, MESSAGE_TEXT_CHARS))
			: clipStrings(value, MESSAGE_TEXT_CHARS)
	}
	for (const field of PAYLOAD_FIELDS) {
		const value = genAi[field]
		if (value === undefined) continue
		const text = jsonText(value)
		genAi[field] = text.length <= PAYLOAD_TEXT_CHARS ? text : `${text.slice(0, PAYLOAD_TEXT_CHARS)}…`
	}
	return { ...span, genAi }
}

/** The bounds a session read is pruned by, exactly as the request classes take
 *  them — including the sub-second precision a resolved window carries. */
export interface SessionWindow {
	readonly startTime: NonNullable<GetAiSessionSpansRequest["startTime"]>
	readonly endTime: NonNullable<GetAiSessionSpansRequest["endTime"]>
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

/** Derived from the parameters themselves: both bounds are the decoded brand,
 *  so a tool cannot hand this an unvalidated string. */
export type SessionWindowParams = {
	readonly [K in keyof typeof sessionWindowParams]?: (typeof sessionWindowParams)[K]["Type"]
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
 * A required id as the request classes take it, or the answer for a blank one.
 *
 * `Schema.Class` constructors THROW on a refused field, so an id an LLM sent as
 * `""` would surface as a defect rather than as something the caller can fix.
 */
export function requiredIdOf(
	raw: string,
	param: string,
	example: string,
):
	| { readonly _tag: "id"; readonly id: string }
	| { readonly _tag: "invalid"; readonly result: McpToolResult } {
	const id = raw.trim()
	if (id === "") {
		return {
			_tag: "invalid",
			result: validationError(`${param} is required and cannot be blank.`, example),
		}
	}
	return { _tag: "id", id }
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
	/** The window the spans were read under, or `undefined` for a session the
	 *  warehouse knows nothing about. */
	readonly window: SessionWindow | undefined
}

/**
 * Every span of a session the derivations can be run on, up to
 * {@link MCP_AGENT_SESSION_MAX_SPANS}.
 *
 * The window is resolved once, not per page: a page read with no window pays
 * its own resolve round trip, and the second page's bounds must still cover the
 * whole session rather than the first page's extent. It is returned as read,
 * so a truncated session's next steps and its exact-totals read still describe
 * the whole session rather than the beginning the spans cover.
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
	let pages = 0
	while (spans.length < MCP_AGENT_SESSION_MAX_SPANS) {
		const page = yield* readAiSessionSpans(
			tenant,
			new GetAiSessionSpansRequest({
				sessionId: opts.sessionId,
				scope: opts.scope,
				// The last page asks only for what is left of the budget, so a
				// short page cannot carry the load past it.
				limit: Math.min(AI_SESSION_SPANS_MAX_SPANS, MCP_AGENT_SESSION_MAX_SPANS - spans.length),
				...window,
				...(after !== undefined && { after }),
			}),
		).pipe(
			// A 413 after the first page is what `truncated` already describes:
			// the pages in hand are the session's beginning. Only a first page
			// that cannot be read at all fails the call.
			Effect.catchTag("@maple/http/ai-sessions/AiSessionTooLargeError", (error) =>
				spans.length === 0 ? Effect.fail(error) : Effect.succeed(undefined),
			),
		)
		pages += 1
		if (page === undefined) {
			yield* Effect.annotateCurrentSpan("maple.ai.too_large", true)
			yield* Effect.logWarning("agent session span page exceeded the response limit").pipe(
				Effect.annotateLogs({ sessionId: opts.sessionId, page: pages, loaded: spans.length }),
			)
			truncated = true
			break
		}
		spans.push(...page.data.map(clipSpanContent))
		after = page.nextCursor
		if (after === undefined) break
		truncated = spans.length >= MCP_AGENT_SESSION_MAX_SPANS
	}
	if (truncated) {
		yield* Effect.logWarning("agent session loaded only its first spans").pipe(
			Effect.annotateLogs({
				sessionId: opts.sessionId,
				loaded: spans.length,
				cap: MCP_AGENT_SESSION_MAX_SPANS,
			}),
		)
	}
	yield* Effect.annotateCurrentSpan({
		"maple.ai.pages": pages,
		"maple.ai.loaded_spans": spans.length,
		"maple.ai.truncated": truncated,
		"maple.ai.scope": opts.scope,
	})

	return { spans, truncated, window } satisfies LoadedAgentSessionSpans
})

/**
 * The tool's answer to a 413 — the one failure a narrower request fixes.
 *
 * Applied to the handler body rather than to the read, so the recovery text is
 * the tool's own and the read keeps its typed failure all the way out.
 */
export const catchSessionTooLarge =
	(recovery: string) =>
	<A, R>(
		self: Effect.Effect<A, McpToolError | AiSessionTooLargeError, R>,
	): Effect.Effect<A | McpToolResult, McpToolError, R> =>
		Effect.catchTag(self, "@maple/http/ai-sessions/AiSessionTooLargeError", (error) =>
			Effect.succeed<McpToolResult>({
				isError: true,
				content: [{ type: "text", text: `${error.message} ${recovery}` }],
			}),
		)

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
