import { AiSessionSpanCursor } from "@maple/domain/http"
import { getAiSessionSpans, getAiSessionSummary } from "@maple/web-data/warehouse/ai-sessions"
import { snapTimestamp } from "@maple/web-data/lib/time-range"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { detectModels } from "../kit/detected-models"
import { writeClipboard } from "../../kit/clipboard"
import { readLocale } from "../../kit/locale"
import { Message, SpanScope } from "./message"
import { parseMarkdownTexts } from "../../kit/message-response"

export const SESSION_TOO_LARGE_TAG = "@maple/http/ai-sessions/AiSessionTooLargeError"

/** Spans a background page carries, and the floor a too-large page shrinks to. */
export const PAGE_SIZE = 2_000
export const MIN_PAGE_SIZE = 250

/**
 * The read's bounds, snapped to the 15s grid like the cache key; absent keys without
 * a window (an explicit undefined would encode as null).
 */
const sessionInput = (sessionId: string, window: TimeWindow | null) =>
	window === null
		? { sessionId }
		: { sessionId, startTime: snapTimestamp(window.startTime), endTime: snapTimestamp(window.endTime) }

/** The clock the header's relative times read, resolved once on entry. */
export const ResolveClock = Command.define("ResolveAgentSessionClock", {
	messages: [Message.CompletedResolveClock],
	execute: Effect.zipWith(Clock.currentTimeMillis, readLocale, (nowMs, locale) =>
		Message.CompletedResolveClock({ nowMs, locale }),
	),
})

/** The first page: the session's opening, bounded by the link's window when it carries one. */
export const FetchFirstPage = Command.define("FetchAgentSessionFirstPage", {
	args: { key: Schema.String, sessionId: Schema.String, window: Schema.NullOr(TimeWindow) },
	messages: [Message.CompletedFetchFirstPage],
	execute: ({ key, sessionId, window }) =>
		getAiSessionSpans({ data: sessionInput(sessionId, window) }).pipe(
			Effect.map((page) => ({ data: page.data, nextCursor: page.nextCursor ?? null })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFirstPage({ key, result })),
		),
})

/** A page past the first, after `cursor`, of one scope (`ai` first, then the app's own spans). */
export const FetchMorePage = Command.define("FetchAgentSessionMorePage", {
	args: {
		key: Schema.String,
		sessionId: Schema.String,
		window: Schema.NullOr(TimeWindow),
		scope: SpanScope,
		after: AiSessionSpanCursor,
		limit: Schema.Number,
		index: Schema.Number,
	},
	messages: [Message.CompletedFetchMorePage],
	execute: ({ key, sessionId, window, scope, after, limit, index }) =>
		getAiSessionSpans({ data: { ...sessionInput(sessionId, window), scope, after, limit } }).pipe(
			Effect.map((page) => ({ data: page.data, nextCursor: page.nextCursor ?? null })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) =>
				Message.CompletedFetchMorePage({
					key,
					index,
					scope,
					result,
					isTooLarge: result._tag === "Failure" && result.failure._tag === SESSION_TOO_LARGE_TAG,
				}),
			),
		),
})

/** The whole session's totals, read only for a session larger than one page. */
export const FetchTotals = Command.define("FetchAgentSessionTotals", {
	args: { key: Schema.String, sessionId: Schema.String, window: Schema.NullOr(TimeWindow) },
	messages: [Message.CompletedFetchTotals],
	execute: ({ key, sessionId, window }) =>
		getAiSessionSummary({ data: sessionInput(sessionId, window) }).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTotals({ key, result })),
		),
})

export const DetectModels = Command.define("DetectAgentSessionModels", {
	args: { key: Schema.String },
	messages: [Message.CompletedDetectModels],
	execute: ({ key }) =>
		Effect.map(detectModels(key), (models) => Message.CompletedDetectModels({ key, models })),
})

/** The transcript's markdown bodies, parsed by the parser this command loads on first use. */
export const ParseMarkdown = Command.define("ParseAgentSessionMarkdown", {
	args: { texts: Schema.Array(Schema.String) },
	messages: [Message.CompletedParseMarkdown],
	execute: ({ texts }) =>
		Effect.map(parseMarkdownTexts(texts), (parsed) => Message.CompletedParseMarkdown({ parsed })),
})

const DOWNLOAD_EXTENSIONS = new Map([
	["ts", "ts"],
	["typescript", "ts"],
	["js", "js"],
	["json", "json"],
	["py", "py"],
])

/** A code block's Copy (the clipboard) or Download (`file.<ext>`). */
export const RunCodeAction = Command.define("RunAgentSessionCodeAction", {
	args: { action: Schema.Literals(["copy", "download"]), code: Schema.String, language: Schema.String },
	messages: [Message.CompletedCodeAction],
	execute: ({ action, code, language }) =>
		(action === "copy"
			? writeClipboard(code)
			: Effect.sync(() => {
					const url = URL.createObjectURL(new Blob([code], { type: "text/plain" }))
					const anchor = document.createElement("a")
					anchor.href = url
					anchor.download = `file.${DOWNLOAD_EXTENSIONS.get(language) ?? "txt"}`
					anchor.click()
					URL.revokeObjectURL(url)
					return false
				})
		).pipe(Effect.map((isCopied) => Message.CompletedCodeAction({ code, isCopied }))),
})

/** Streamdown's `CodeBlockCopyButton` holds its check for `timeout` (2s), then shows Copy again. */
export const WaitCodeCopied = Command.define("WaitAgentSessionCodeCopied", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedCodeCopied],
	execute: ({ generation }) =>
		Effect.sleep(Duration.millis(2000)).pipe(Effect.as(Message.ElapsedCodeCopied({ generation }))),
})

/** "Check the Tools section": brings the Overview's ledger into view. */
export const ScrollToTools = Command.define("ScrollAgentSessionToTools", {
	messages: [Message.CompletedScroll],
	execute: Effect.sync(() => {
		document.querySelector("[data-session-tools]")?.scrollIntoView({ behavior: "smooth", block: "start" })
		return Message.CompletedScroll()
	}),
})
