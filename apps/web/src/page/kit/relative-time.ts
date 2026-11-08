import type { TimeInput } from "@maple/ui/lib/time-format"
import { timestamp, type TimestampFormat } from "@maple/views/ui/timestamp"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `RelativeTime`: `timestamp` with relative text. `nowMs` is the page's resolved clock.

export type RelativeTimeOptions = Readonly<{
	value: TimeInput
	nowMs: number
	timeZone: string
	variant?: "long" | "short" | "orDate"
	prefix?: string
	mono?: boolean
	/** A page Tooltip's trigger attributes; without them the timezone card shows. */
	trigger?: ReadonlyArray<ChildAttribute>
	className?: string
}>

/** The absolute time a page's own tooltip shows: `formatTimestampInTimezone(epochMs, { withYear: true })`. */
export const formatAbsolute = (epochMs: number, timeZone: string): string =>
	formatTimestampInTimezone(epochMs, { timeZone, withYear: true })

const FORMAT = {
	long: "relative",
	short: "relativeShort",
	orDate: "relativeOrDate",
} as const satisfies Record<NonNullable<RelativeTimeOptions["variant"]>, TimestampFormat>

export const relativeTime = <M>(h: HtmlBuilder<M>, options: RelativeTimeOptions): Html =>
	timestamp(h, { ...options, format: FORMAT[options.variant ?? "long"] })

/** A list column's relative time. `short` fits narrow columns. */
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
): Html => relativeTime(h, options)
