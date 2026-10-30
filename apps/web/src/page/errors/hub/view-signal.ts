import { warehouseDateTimeToIso } from "@maple/query-engine"
import { zonedDateParts } from "@maple/query-engine/datetime"
import { countLabel, EMPTY_VALUE } from "@maple/ui/lib/format"
import { formatRelativeShortFrom } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { type ErrorSignal, densifySpark, surgeRatio } from "../../../lib/models/error-signal"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import { miniBars } from "../../../ui/mini-bars"
import { SEVERITY_TEXT } from "../kit/severity"
import { investigationChip } from "../kit/state-chip"
import { Message } from "./message"

// Row pieces of an error signal row and its spark.

type H = HtmlBuilder<Message>

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** A burst this far above the window's own average tail is worth calling out. */
export const SURGE_THRESHOLD = 2.5
/** Type names that say nothing on their own; the message makes a better row title. */
export const GENERIC_TYPES = new Set(["Error", "Exception", "TypeError", "RuntimeError", "Unknown error"])

export type SparkWindow = Readonly<{ startMs: number; endMs: number; bucketMs: number }>

export const epochOf = (iso: string): number => new Date(warehouseDateTimeToIso(iso)).getTime()

/** `formatLastSeen`: relative inside a week, a date beyond it; clock skew reads as "now". */
export const formatLastSeen = (iso: string, timeZone: string, nowMs: number): string => {
	const ms = epochOf(iso)
	if (Number.isNaN(ms)) return iso
	if (ms > nowMs) return "now"
	if (nowMs - ms < WEEK_MS) return formatRelativeShortFrom(ms, nowMs)
	const sameYear = zonedDateParts(ms, timeZone).year === zonedDateParts(nowMs, timeZone).year
	return new Date(ms).toLocaleDateString("en-US", {
		timeZone,
		month: "short",
		day: "numeric",
		year: sameYear ? undefined : "numeric",
	})
}

/** `formatTimestampInTimezone(input, { timeZone, withYear })` (lib/timezone-format.ts). */
export const formatTimestamp = (iso: string, timeZone: string, withYear: boolean): string => {
	const ms = epochOf(iso)
	if (Number.isNaN(ms)) return EMPTY_VALUE
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: withYear ? "numeric" : undefined,
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(ms)
}

/** `SignalSpark`: the trend in one static svg, coloured by severity (or surge). */
export const signalSpark = (
	h: H,
	values: ReadonlyArray<number>,
	signal: ErrorSignal,
	surging: boolean,
	label: string,
): Html => {
	if (values.length === 0) {
		return h.span(
			[h.Class("block h-5 w-full"), h.AriaHidden(true), h.Title("No occurrences in this window")],
			[],
		)
	}
	const tone = surging
		? "text-severity-error"
		: signal.severity === null
			? "text-muted-foreground"
			: SEVERITY_TEXT[signal.severity]
	return miniBars(h, {
		values,
		floor: Math.max(...values) > 0 ? 5 : 0,
		minHeight: 12.5,
		gap: 100 / (values.length * 3 - 1),
		tail: 0.2,
		className: cn("h-5 w-full overflow-visible", tone),
		label,
	})
}

/** `SignalActivity`: a live investigation, then comment and PR marks; nothing on an untouched row. */
// The message takes the free width; the chips follow it at their natural size.
export const signalActivity = (h: H, signal: ErrorSignal): Html | null => {
	const prCount = signal.openPullRequestCount + signal.mergedPullRequestCount
	if (signal.investigation === null && signal.commentCount === 0 && prCount === 0) return null
	return h.span(
		[h.Class("ml-auto flex shrink-0 items-center gap-2 pl-3")],
		[
			...(signal.investigation === null
				? []
				: [
						investigationChip(h, signal.investigation, {
							withConfidence: false,
							compact: true,
							onOpen: Message.ClickedInvestigation({ id: signal.investigation.id }),
						}),
					]),
			...(signal.commentCount > 0
				? [
						h.span(
							[
								h.Class(
									"flex items-center gap-1 text-2xs tabular-nums text-muted-foreground",
								),
								h.Title(`${countLabel(signal.commentCount, "comment")} on the timeline`),
							],
							[icon(h, "ChatBubbleIcon", { size: 12 }), String(signal.commentCount)],
						),
					]
				: []),
			...(prCount > 0
				? [
						h.span(
							[
								h.Class(
									cn(
										"flex items-center gap-1 text-2xs tabular-nums",
										signal.mergedPullRequestCount > 0
											? "text-foreground-soft"
											: "text-muted-foreground",
									),
								),
								h.Title(
									signal.mergedPullRequestCount > 0
										? `${countLabel(prCount, "pull request")} · ${signal.mergedPullRequestCount} merged`
										: countLabel(prCount, "open pull request"),
								),
							],
							[icon(h, "PullRequestIcon", { size: 12 }), String(prCount)],
						),
					]
				: []),
		],
	)
}

/** The dense trend, whether it surges, and the spark's accessible name. */
export const sparkOf = (signal: ErrorSignal, window: SparkWindow) => {
	const dense = densifySpark(signal.spark, window)
	const surge = surgeRatio(dense)
	const isSurging = surge !== null && surge >= SURGE_THRESHOLD
	const occurrences = countLabel(signal.windowCount ?? 0, "occurrence")
	const label = isSurging
		? `Surging — ${occurrences} in the last 24 hours, concentrated at the end`
		: `${occurrences} in the last 24 hours`
	return { dense, isSurging, label }
}
