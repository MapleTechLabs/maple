import { formatErrorRate } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type {
	ErrorPathPart,
	ErrorTextToken,
	FailureStatus,
} from "../../../lib/agent-sessions/tool-error-display"
import { formatToolCount } from "@maple/web-data/lib/tool-analytics"
import { formatDateInTimezone, formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { inlineCodeClassName } from "../../../ui/inline-code"
import { statusDot } from "../../../ui/status-dot"

// The pieces the Errors table (and the error modal) draw a failure with.

/** `MaskChip`: a span the grouping ignores, drawn as the kind of value it is; the raw text is its title. */
export const maskChip = <M>(h: HtmlBuilder<M>, label: string, raw: string, className?: string): Html =>
	h.code(
		[
			h.Class(
				inlineCodeClassName(
					"chip",
					cn(
						"mx-px inline-block rounded-[3px] px-[3px] py-0 align-baseline text-2xs leading-3.75 font-normal text-muted-foreground",
						className,
					),
				),
			),
			h.DataAttribute("slot", "inline-code"),
			...(raw === "" ? [] : [h.Title(raw)]),
		],
		[label],
	)

const pathParts = <M>(
	h: HtmlBuilder<M>,
	parts: ReadonlyArray<ErrorPathPart>,
	keyClassName: string,
	maskClassName?: string,
): Html[] =>
	parts.map((part) =>
		part.kind === "key"
			? h.span([h.Class(keyClassName)], [part.text])
			: maskChip(h, part.label, part.raw, maskClassName),
	)

const HEADING_MASK = "border border-border bg-transparent text-title leading-5"

const headingToken = <M>(h: HtmlBuilder<M>, token: ErrorTextToken): ReadonlyArray<Html | string> => {
	switch (token.kind) {
		case "text":
		case "value":
			return [token.text]
		case "mask":
			return [maskChip(h, token.label, token.raw, HEADING_MASK)]
		case "at":
			return [h.span([h.Class("font-normal text-muted-foreground")], [" at "])]
		case "break":
			return [h.br([])]
		case "path":
			return pathParts(h, token.parts, "")
	}
}

const headingTokens = <M>(h: HtmlBuilder<M>, tokens: ReadonlyArray<ErrorTextToken>) =>
	tokens.flatMap((token) => headingToken(h, token))

const HEADING = "font-mono text-lg leading-6.5 font-semibold tracking-[-0.01em] text-foreground"

/** `ErrorTextHeading`: the message whole, its path on a line of its own in the error colour. */
export const errorTextHeading = <M>(h: HtmlBuilder<M>, tokens: ReadonlyArray<ErrorTextToken>): Html => {
	const pathIndex = tokens.findIndex((token) => token.kind === "path")
	if (pathIndex < 0)
		return h.h2([h.Class(cn(HEADING, "line-clamp-3 break-words"))], headingTokens(h, tokens))
	const path = tokens[pathIndex]
	const atIndex = tokens[pathIndex - 1]?.kind === "at" ? pathIndex - 1 : pathIndex
	const tail = tokens.slice(pathIndex + 1)
	return h.h2(
		[h.Class("flex min-w-0 flex-col gap-0.5")],
		[
			h.span(
				[h.Class(cn(HEADING, "line-clamp-2 break-words"))],
				headingTokens(h, tokens.slice(0, atIndex)),
			),
			h.span(
				[h.Class("flex min-w-0 flex-wrap items-baseline gap-3 pl-6 font-mono text-lg leading-6.5")],
				[
					h.span([h.Class("text-muted-foreground")], ["at"]),
					h.span(
						[h.Class(cn("break-all font-semibold tracking-[-0.01em]", TONE_TEXT.crit))],
						path?.kind === "path" ? pathParts(h, path.parts, "", HEADING_MASK) : [],
					),
				],
			),
			...(tail.length > 0
				? [
						h.span(
							[
								h.Class(
									"line-clamp-2 break-words pl-6 font-mono text-ui leading-4.5 text-foreground/80",
								),
							],
							headingTokens(h, tail),
						),
					]
				: []),
		],
	)
}

const lineToken = <M>(h: HtmlBuilder<M>, token: ErrorTextToken): Html[] => {
	switch (token.kind) {
		case "text":
			return [h.span([h.Class("text-foreground/80")], [token.text])]
		case "value":
			return [h.span([h.Class("font-medium text-foreground")], [token.text])]
		case "mask":
			return [maskChip(h, token.label, token.raw)]
		case "at":
			return [h.span([h.Class("text-muted-foreground/60")], [" at "])]
		case "break":
			return [h.span([h.Class("text-muted-foreground/60")], [" ⏎ "])]
		case "path":
			return pathParts(h, token.parts, "font-medium text-foreground")
	}
}

const lineTokens = <M>(h: HtmlBuilder<M>, tokens: ReadonlyArray<ErrorTextToken>): Html[] =>
	tokens.flatMap((token) => lineToken(h, token))

/** `ErrorTextLine`: a message on one line; the error path never shrinks. */
export const errorTextLine = <M>(
	h: HtmlBuilder<M>,
	tokens: ReadonlyArray<ErrorTextToken>,
	className?: string,
): Html => {
	const pathIndex = tokens.findIndex((token) => token.kind === "path")
	if (pathIndex < 0)
		return h.span([h.Class(cn("min-w-0 truncate whitespace-pre", className))], lineTokens(h, tokens))
	const atIndex = tokens[pathIndex - 1]?.kind === "at" ? pathIndex - 1 : pathIndex
	const tail = tokens.slice(pathIndex + 1)
	return h.span(
		[h.Class(cn("flex min-w-0 items-baseline", className))],
		[
			h.span([h.Class("min-w-0 truncate whitespace-pre")], lineTokens(h, tokens.slice(0, atIndex))),
			h.span([h.Class("shrink-0 whitespace-pre")], lineTokens(h, tokens.slice(atIndex, pathIndex + 1))),
			...(tail.length > 0
				? [h.span([h.Class("min-w-0 flex-[1_1_0] truncate whitespace-pre")], lineTokens(h, tail))]
				: []),
		],
	)
}

/** "Sep 4 – 11": the window as the trend column's head names it. */
export const windowRangeLabel = (startMs: number, endMs: number, timeZone: string): string => {
	const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone })
	const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone })
	const day = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone })
	const start = monthDay.format(startMs)
	if (start === monthDay.format(endMs)) return start
	return month.format(startMs) === month.format(endMs)
		? `${start} – ${day.format(endMs)}`
		: `${start} – ${monthDay.format(endMs)}`
}

const STATUS_TONE = { stopped: "ok", ongoing: "crit", quiet: "neutral" } as const

/** `FailureStatusLine`: whether failing has stopped, in one line. */
export const failureStatusLine = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		status: FailureStatus
		scope: "tool" | "group"
		timeZone: string
		nowMs: number
		calls: number
		failures: number
		activeBuckets?: Readonly<{ active: number; total: number; unit: string }>
		className?: string
	}>,
): Html => {
	const { status, scope, timeZone } = options
	const shortDate = (ms: number) => formatDateInTimezone(ms, { timeZone, withYear: false })
	const dateTime = (ms: number) => formatTimestampInTimezone(ms, { timeZone, style: "range" })
	const [lead, detail] =
		status.kind === "stopped"
			? [
					scope === "tool"
						? `No failures since ${dateTime(status.since)}`
						: `None since ${shortDate(status.since)}`,
					`· ${formatToolCount(status.callsSince)} call${status.callsSince === 1 ? "" : "s"} since`,
				]
			: status.kind === "quiet"
				? [
						`No calls since ${scope === "tool" ? dateTime(status.since) : shortDate(status.since)}`,
						undefined,
					]
				: scope === "tool"
					? [
							`Last failure ${formatRelativeTimeOrDate(status.lastSeen, options.nowMs, timeZone)}`,
							options.calls > 0
								? `· ${formatErrorRate(options.failures / options.calls)} of ${formatToolCount(options.calls)} calls`
								: undefined,
						]
					: [
							"Still happening",
							options.activeBuckets === undefined
								? undefined
								: `· failed in ${options.activeBuckets.active} of ${options.activeBuckets.total} ${options.activeBuckets.unit === "day" ? "days" : `${options.activeBuckets.unit} buckets`}`,
						]
	return h.span(
		[h.Class(cn("flex items-center gap-2 font-mono text-2xs leading-3.5", options.className))],
		[
			statusDot(h, { tone: STATUS_TONE[status.kind] }),
			h.span([h.Class("text-foreground")], [lead]),
			...(detail === undefined ? [] : [h.span([h.Class("text-muted-foreground/70")], [detail])]),
		],
	)
}
