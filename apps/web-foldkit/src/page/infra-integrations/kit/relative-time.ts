import { EMPTY_VALUE } from "@maple/ui/lib/format"
import {
	formatRelativeShort,
	formatRelativeTime,
	formatRelativeTimeOrDate,
	type TimeInput,
	toEpochMs,
} from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `RelativeTime tooltip="title"` (apps/web/src/components/common/relative-time.tsx): the relative
// label, the zone-aware absolute time as the native title.

/** `formatTimestampInTimezone(epochMs, { timeZone, withYear: true })`. */
export const formatAbsolute = (epochMs: number, timeZone: string): string =>
	new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(epochMs)

export type RelativeTimeOptions = Readonly<{
	value: TimeInput
	nowMs: number
	timeZone: string
	variant?: "long" | "short" | "orDate"
	prefix?: string
	mono?: boolean
	className?: string
	/** The Tooltip trigger attributes: renders the tooltip variant instead of a native title. */
	trigger?: ReadonlyArray<ChildAttribute>
}>

export const relativeTime = <M>(h: HtmlBuilder<M>, options: RelativeTimeOptions): Html => {
	const epochMs = toEpochMs(options.value)
	if (!Number.isFinite(epochMs)) {
		return h.span([h.Class(cn("text-muted-foreground", options.className))], [EMPTY_VALUE])
	}
	const relative =
		options.variant === "short"
			? formatRelativeShort(epochMs, options.nowMs)
			: options.variant === "orDate"
				? formatRelativeTimeOrDate(epochMs, options.nowMs, options.timeZone)
				: formatRelativeTime(epochMs, options.nowMs)
	const label = options.prefix === undefined ? relative : `${options.prefix} ${relative}`
	const classes = cn(options.mono === true && "font-mono tabular-nums", options.className)
	const datetime = h.Attribute("datetime", new Date(epochMs).toISOString())
	// `tooltip="tooltip"`: a Base UI trigger; the absolute time is the tooltip's content.
	if (options.trigger !== undefined) {
		return h.time(
			[
				...options.trigger,
				datetime,
				h.Class(cn("cursor-default", classes)),
				h.DataAttribute("slot", "tooltip-trigger"),
			],
			[label],
		)
	}
	return h.time([datetime, h.Title(formatAbsolute(epochMs, options.timeZone)), h.Class(classes)], [label])
}
