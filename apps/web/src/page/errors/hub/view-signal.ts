import { zonedDateParts } from "@maple/query-engine/datetime"
import { countLabel } from "@maple/ui/lib/format"
import { formatRelativeShortFrom, toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { type ErrorSignal, densifySpark, surgeRatio } from "../kit/error-signal"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { miniBars } from "@maple/views/ui/mini-bars"
import { SEVERITY_TOKEN } from "../../kit/issue-severity"
import { investigationChip } from "../kit/state-chip"
import { Message } from "./message"
import { hstack } from "@maple/views/ui/stack"
import { tooltipTrigger } from "@maple/views/ui/tooltip-host"
import type { Tone } from "@maple/ui/lib/tone"

// Row pieces of an error signal row and its spark.

type H = HtmlBuilder<Message>

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** A burst this far above the window's own average tail is worth calling out. */
export const SURGE_THRESHOLD = 2.5
/** Type names that say nothing on their own; the message makes a better row title. */
export const GENERIC_TYPES = new Set(["Error", "Exception", "TypeError", "RuntimeError", "Unknown error"])

export type SparkWindow = Readonly<{ startMs: number; endMs: number; bucketMs: number }>

/** `formatLastSeen`: relative inside a week, a date beyond it; clock skew reads as "now". */
export const formatLastSeen = (iso: string, timeZone: string, nowMs: number): string => {
	const ms = toEpochMs(iso)
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
	// Bars are marks, so they take the tone itself, not the ink a `text-severity-*` class gives.
	const color = surging
		? "var(--severity-error)"
		: signal.severity === null
			? "var(--muted-foreground)"
			: `var(${SEVERITY_TOKEN[signal.severity]})`
	return miniBars(h, {
		values,
		floor: Math.max(...values) > 0 ? 5 : 0,
		minHeight: 12.5,
		gap: 100 / (values.length * 3 - 1),
		tail: 0.2,
		className: "h-5 w-full overflow-visible",
		color,
		label,
	})
}

/** Fixed slots of the activity lane, so each kind of mark sits in the same column on every row. */
export const ACTIVITY_SLOT = {
	investigation: "w-3 shrink-0 min-w-0 @5xl/page:w-24",
	comments: "w-8 shrink-0",
	prs: "w-8 shrink-0",
} as const

const countMark = (
	h: H,
	iconName: "ChatBubbleIcon" | "PullRequestIcon",
	count: number,
	tooltip: Readonly<{ title: string; description: string; tone: Tone }>,
	isStrong: boolean,
): Html =>
	hstack(
		h,
		{
			gap: "1",
			align: "center",
			as: "span",
			className: cn(
				"text-2xs tabular-nums",
				isStrong ? "text-foreground-soft" : "text-muted-foreground",
			),
			attributes: tooltipTrigger(h, tooltip.description, {
				title: tooltip.title,
				icon: iconName,
				tone: tooltip.tone,
			}),
		},
		[icon(h, iconName, { size: 12 }), String(count)],
	)

/** `SignalActivity`: the investigation, comment and PR slots; an empty slot keeps its width. */
export const signalActivity = (h: H, signal: ErrorSignal, className: string): Html => {
	const prCount = signal.openPullRequestCount + signal.mergedPullRequestCount
	return h.span(
		[h.Class(className)],
		[
			h.span(
				[h.Class(ACTIVITY_SLOT.investigation)],
				signal.investigation === null
					? []
					: [
							investigationChip(h, signal.investigation, {
								withConfidence: false,
								// The dot alone until the page is wide enough for the label.
								compact: true,
								onOpen: Message.ClickedInvestigation({ id: signal.investigation.id }),
							}),
						],
			),
			h.span(
				[h.Class(ACTIVITY_SLOT.comments)],
				signal.commentCount > 0
					? [
							countMark(
								h,
								"ChatBubbleIcon",
								signal.commentCount,
								{
									title: countLabel(signal.commentCount, "comment"),
									description: "Notes from your team on this issue's timeline.",
									tone: "info",
								},
								false,
							),
						]
					: [],
			),
			h.span(
				[h.Class(ACTIVITY_SLOT.prs)],
				prCount > 0
					? [
							countMark(
								h,
								"PullRequestIcon",
								prCount,
								{
									title:
										signal.mergedPullRequestCount > 0
											? `${countLabel(prCount, "pull request")} · ${signal.mergedPullRequestCount} merged`
											: countLabel(prCount, "open pull request"),
									description:
										signal.mergedPullRequestCount > 0
											? "Pull requests linked to this issue as fixes. A merged one should ship the fix."
											: "Pull requests linked to this issue as fixes, still open.",
									tone: signal.mergedPullRequestCount > 0 ? "done" : "live",
								},
								signal.mergedPullRequestCount > 0,
							),
						]
					: [],
			),
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
		? `Surging: ${occurrences} in the last 24 hours, concentrated at the end`
		: `${occurrences} in the last 24 hours`
	return { dense, isSurging, label }
}
