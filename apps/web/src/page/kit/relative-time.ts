import { EMPTY_VALUE } from "@maple/ui/lib/format"
import {
	formatRelativeShortFrom,
	formatRelativeTime,
	formatRelativeTimeOrDate,
	type TimeInput,
	toEpochMs,
} from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `RelativeTime`. `nowMs` is the page's resolved clock.
// TODO(tooltip): without `trigger` the tooltip variant renders its trigger only; the absolute-time
// popup is the page Tooltip's to draw (the `title` variant carries it natively).

export type RelativeTimeOptions = Readonly<{
	value: TimeInput
	nowMs: number
	timeZone: string
	variant?: "long" | "short" | "orDate"
	prefix?: string
	mono?: boolean
	tooltip?: "tooltip" | "title"
	/** The page Tooltip's trigger attributes, for the tooltip variant. */
	trigger?: ReadonlyArray<ChildAttribute>
	className?: string
}>

/** The absolute time shown on hover: `formatTimestampInTimezone(epochMs, { withYear: true })`. */
export const formatAbsolute = (epochMs: number, timeZone: string): string =>
	formatTimestampInTimezone(epochMs, { timeZone, withYear: true })

export const relativeTime = <M>(h: HtmlBuilder<M>, options: RelativeTimeOptions): Html => {
	const epochMs = toEpochMs(options.value)
	if (!Number.isFinite(epochMs))
		return h.span([h.Class(cn("text-muted-foreground", options.className))], [EMPTY_VALUE])
	const relative =
		options.variant === "short"
			? formatRelativeShortFrom(epochMs, options.nowMs)
			: options.variant === "orDate"
				? formatRelativeTimeOrDate(epochMs, options.nowMs, options.timeZone)
				: formatRelativeTime(epochMs, options.nowMs)
	const label = options.prefix ? `${options.prefix} ${relative}` : relative
	const classes = cn(options.mono === true && "font-mono tabular-nums", options.className)
	const datetime = h.Attribute("datetime", new Date(epochMs).toISOString())
	if (options.tooltip === "title")
		return h.time(
			[
				datetime,
				h.Title(formatAbsolute(epochMs, options.timeZone)),
				...(classes === "" ? [] : [h.Class(classes)]),
			],
			[label],
		)
	return h.time(
		[
			...(options.trigger ?? [h.DataAttribute("base-ui-tooltip-trigger", "")]),
			h.Class(cn("cursor-default", classes)),
			datetime,
			h.DataAttribute("slot", "tooltip-trigger"),
		],
		[label],
	)
}

/** A list column's relative time, with the full timestamp as its title. `short` fits narrow columns. */
export const listRelativeTime = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		value: TimeInput
		nowMs: number
		timeZone: string
		variant?: "long" | "short"
		mono?: boolean
		className?: string
	}>,
): Html => relativeTime(h, { ...options, tooltip: "title" })
