// A whole Agent Session's spans, paged and clipped, for code that derives from all of them: the
// MCP session tools and the session-check scores tick.
import { Effect, Option, Array as Arr, Record as Rec, String as Str } from "effect"
import {
	AI_SESSION_SPANS_MAX_SPANS,
	GetAiSessionSpansRequest,
	type AiSessionSpan,
	type TenantContext,
} from "@maple/domain/http"
import type { AiGenAiField, MutableAiGenAiValues } from "@maple/domain/gen-ai"
import { lastUserMessageText } from "@maple/agent-sessions"
import { AiSessionReadService } from "@maple/backend/services/ai-sessions/AiSessionReadService"

/** Spans one call loads; past it the answer covers the session's beginning. */
export const AI_SESSION_LOAD_MAX_SPANS = 5 * AI_SESSION_SPANS_MAX_SPANS

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

/** `value` cut to `chars` characters, marked with an ellipsis when cut. */
export const clipText = (value: string, chars: number): string =>
	value.length <= chars ? value : `${Str.slice(0, chars)(value)}…`

/** BOUNDARY: every string inside a captured value, cut. The shape is the
 *  vendor's own JSON, which this walks rather than parses. */
const clipStrings = (value: unknown, chars: number): unknown => {
	if (typeof value === "string") return clipText(value, chars)
	if (Arr.isArray(value)) return Arr.map(value, (entry) => clipStrings(entry, chars))
	if (typeof value === "object" && value !== null) {
		return Rec.fromEntries(
			Arr.map(Rec.toEntries(value), ([key, entry]) => [key, clipStrings(entry, chars)]),
		)
	}
	return value
}

/** The first user message, the newest one and the last message — the turn label
 *  the derivations read is the newest, found by the reader `turnLabel` itself
 *  uses, and `turnLabel` checks an agent root's prompt against the first. */
const keptMessages = (messages: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
	const hasUserText = (message: unknown) => lastUserMessageText([message]) !== undefined
	const last = messages.length - 1
	let newest = -1
	for (let i = last - 1; i >= 0; i--) {
		if (hasUserText(messages[i])) {
			newest = i
			break
		}
	}
	const first = Arr.findFirstIndex(messages, hasUserText)
	return Arr.filter(messages, (_, i) => Option.contains(first, i) || i === newest || i === last)
}

/** A span's content cut to what a whole-session read retains; a tool needing
 *  one span in full reads it on its own (`inspect_span`). */
export function clipSpanContent(span: AiSessionSpan): AiSessionSpan {
	const genAi: MutableAiGenAiValues = { ...span.genAi }
	for (const field of MESSAGE_FIELDS) {
		const value = genAi[field]
		if (value === undefined) continue
		genAi[field] = Arr.isArray(value)
			? Arr.map(keptMessages(value), (message) => clipStrings(message, MESSAGE_TEXT_CHARS))
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

/** The sentinel a caught 413 hands back: retry this page smaller. */
const HALVE = "halve" as const

type ReadSpansPage = ReturnType<(typeof AiSessionReadService)["Service"]["spans"]>

interface SpanLoadState {
	readonly spans: ReadonlyArray<AiSessionSpan>
	readonly after: GetAiSessionSpansRequest["after"]
	readonly limit: number
	readonly truncated: "cap" | "too_large" | false
}

/**
 * Every span of a session the derivations run on, up to
 * {@link AI_SESSION_LOAD_MAX_SPANS} and clipped page by page; `truncated`
 * says the END of the session is missing, and which ceiling stopped the read.
 * The window is resolved once, not per page: every page's bounds must cover
 * the session, not the first page.
 */
export const loadAiSessionSpans = Effect.fn("AiSessionSpans.load")(function* (
	tenant: TenantContext,
	opts: { readonly sessionId: string; readonly window: SessionWindow | undefined },
) {
	const reads = yield* AiSessionReadService
	yield* Effect.annotateCurrentSpan("maple.ai.window_source", opts.window ? "client" : "resolved")
	const window = opts.window ?? (yield* reads.resolveWindow(tenant, opts.sessionId)).window
	if (window === undefined) {
		yield* Effect.annotateCurrentSpan("maple.ai.found", false)
		return { spans: [], truncated: false as const, window: undefined }
	}

	const readPage = (state: SpanLoadState): Effect.Effect<SpanLoadState, Effect.Error<ReadSpansPage>> =>
		state.spans.length >= AI_SESSION_LOAD_MAX_SPANS
			? Effect.succeed(state)
			: reads
					.spans(
						tenant,
						new GetAiSessionSpansRequest({
							sessionId: opts.sessionId,
							limit: Math.min(state.limit, AI_SESSION_LOAD_MAX_SPANS - state.spans.length),
							...window,
							...(state.after !== undefined && { after: state.after }),
						}),
					)
					.pipe(
						// A 413 is the BYTE cap, and the sessions this tool exists for are
						// exactly the ones whose heavy spans trip it on page one — so the same
						// page is retried at half the rows, down to the floor. Past that the
						// pages in hand are the session's beginning, and a first page that
						// cannot be read even at the floor fails the call.
						Effect.catchTag("@maple/http/ai-sessions/AiSessionTooLargeError", (error) =>
							state.limit > MIN_PAGE_SPANS
								? Effect.succeed(HALVE)
								: state.spans.length === 0
									? Effect.fail(error)
									: Effect.undefined,
						),
						Effect.flatMap((page) => {
							if (page === HALVE) {
								return readPage({
									...state,
									limit: Math.max(MIN_PAGE_SPANS, Math.floor(state.limit / 2)),
								})
							}
							if (page === undefined)
								return Effect.succeed({ ...state, truncated: "too_large" as const })
							const spans = [...state.spans, ...Arr.map(page.data, clipSpanContent)]
							if (page.nextCursor === undefined)
								return Effect.succeed({ ...state, spans, after: undefined })
							return readPage({
								spans,
								after: page.nextCursor,
								limit: state.limit,
								truncated: spans.length >= AI_SESSION_LOAD_MAX_SPANS ? "cap" : false,
							})
						}),
					)

	const { spans, limit, truncated } = yield* readPage({
		spans: [],
		after: undefined,
		limit: AI_SESSION_SPANS_MAX_SPANS,
		truncated: false,
	})
	yield* Effect.annotateCurrentSpan({
		"maple.ai.span_count": spans.length,
		"maple.ai.page_limit": limit,
		"maple.ai.truncated": truncated,
	})

	return { spans, truncated, window }
})
