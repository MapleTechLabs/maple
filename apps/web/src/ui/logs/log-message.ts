import { stripAnsi } from "@maple/ui/components/logs/strip-ansi"
import { formatBytes } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	capForDisplay,
	headLines,
	memoizeByText,
	PREVIEW_MAX_CHARS,
	prettyJson,
} from "../../lib/display-text"
import { highlightCode } from "../../lib/sugar-high"

// The log detail hero's message, shared by the dashboard and Maple Local. Collapsed it builds only
// the preview lines; expanded it scrolls inside a capped box, so a huge body never takes the sheet.

const LONG_CHARS = 280
/** Match `line-clamp-6` / `line-clamp-4`; one more line is built so the clamp draws its ellipsis. */
const JSON_PREVIEW_LINES = 6
const TEXT_PREVIEW_LINES = 4

export type LogMessage = Readonly<{
	/** ANSI stripped, JSON re-indented. */
	formatted: string
	isJson: boolean
	/** Long enough to collapse behind "Show full message". */
	isLong: boolean
	/** What a copy carries: pretty JSON only when it is the original bytes reformatted. */
	copyValue: string
}>

export const logMessageOf: (rawBody: string) => LogMessage = memoizeByText((rawBody) => {
	const body = stripAnsi(rawBody)
	const pretty = prettyJson(body)
	const formatted = Option.getOrElse(pretty, () => body)
	return {
		formatted,
		isJson: Option.isSome(pretty),
		isLong: formatted.length > LONG_CHARS || formatted.includes("\n"),
		copyValue: Option.isSome(pretty) && body === rawBody ? formatted : rawBody,
	}
})

/** Says how much of a capped value a view left out. */
export const truncationNote = <Message>(h: HtmlBuilder<Message>, shown: number, total: number): Html =>
	h.p(
		[h.Class("my-2 text-3xs text-muted-foreground")],
		[`Showing the first ${formatBytes(shown)} of ${formatBytes(total)}. Copy it to get all of it.`],
	)

/** Highlighted code in a `pre`, capped at `DISPLAY_MAX_CHARS` with a note saying what was left out. */
export const cappedCode = <Message>(
	h: HtmlBuilder<Message>,
	code: string,
	className: string,
): ReadonlyArray<Html> => {
	const { shown, omitted } = capForDisplay(code)
	// The note leads: below the code it would sit 200k characters down a scroll.
	return [
		...(omitted === 0 ? [] : [truncationNote(h, shown.length, code.length)]),
		h.pre([h.Class(className)], [h.code([h.InnerHTML(highlightCode(shown))], [])]),
	]
}

export const logMessageView = <Message>(
	h: HtmlBuilder<Message>,
	message: LogMessage,
	isExpanded: boolean,
): Html => {
	const isClamped = message.isLong && !isExpanded
	const { shown, omitted } = isClamped
		? capForDisplay(
				headLines(message.formatted, (message.isJson ? JSON_PREVIEW_LINES : TEXT_PREVIEW_LINES) + 1),
				PREVIEW_MAX_CHARS,
			)
		: capForDisplay(message.formatted)
	const text = message.isJson
		? h.pre(
				[
					h.Class(
						cn(
							"font-mono text-ui leading-relaxed whitespace-pre-wrap break-words",
							isClamped && "line-clamp-6",
						),
					),
				],
				[h.code([h.InnerHTML(highlightCode(shown))], [])],
			)
		: h.p(
				[
					h.Class(
						cn(
							"font-mono text-sm leading-relaxed whitespace-pre-wrap break-words",
							isClamped && "line-clamp-4",
						),
					),
				],
				[shown],
			)
	return h.div(
		[h.Class("min-w-0 flex-1")],
		[
			h.div(
				[
					h.Class(cn("select-text", isExpanded && message.isLong && "max-h-[45vh] overflow-auto")),
					h.DataAttribute("slot", "log-message"),
				],
				[text],
			),
			...(isClamped || omitted === 0
				? []
				: [truncationNote(h, shown.length, message.formatted.length)]),
		],
	)
}
