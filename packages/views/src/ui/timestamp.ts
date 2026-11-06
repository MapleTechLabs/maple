import { Array as Arr, Option, String as Str } from "effect"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import {
	formatRelativeFrom,
	formatRelativeShortFrom,
	formatRelativeTimeOrDate,
	relativeParts,
	type TimeInput,
	toEpochMs,
} from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { getBrowserTimeZone, isValidIanaTimeZone } from "@maple/web-data/lib/timezone"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { typography } from "./typography"

// `Timestamp`: one instant as the page shows it (relative or absolute), with a hover card that
// gives the exact time in the page's zone, the viewer's local zone and UTC.

export type TimestampFormat = "absolute" | "relative" | "relativeShort" | "relativeOrDate"

/**
 * `format` is `absolute` by default (`Nov 6, 14:02:31` in `timeZone`). `nowMs` is the page's clock:
 * relative text needs it; without it an absolute time's card measures its distance on hover.
 */
type TimestampClock =
	| Readonly<{ format?: "absolute"; nowMs?: number }>
	| Readonly<{ format: Exclude<TimestampFormat, "absolute">; nowMs: number }>

export type TimestampOptions = TimestampClock &
	Readonly<{
		value: TimeInput
		/** The page's selected zone: absolute text and the card's first row read in it. */
		timeZone: string
		/** Text that replaces the formatted one (a page's own date style); the card still shows. */
		label?: string
		/** Text before the time: `last seen 3m ago`. */
		prefix?: string
		withYear?: boolean
		withMilliseconds?: boolean
		mono?: boolean
		/** A page's own tooltip trigger, which replaces the timezone card. */
		trigger?: ReadonlyArray<ChildAttribute>
		className?: string
	}>

const UTC = "UTC"

const resolveZone = (timeZone: string): string =>
	isValidIanaTimeZone(timeZone) ? timeZone : getBrowserTimeZone()

const offsetFormatters = new Map<string, Intl.DateTimeFormat>()

/** `UTC+1`, `UTC-5:30`; empty for UTC itself. */
const utcOffsetLabel = (epochMs: number, timeZone: string): string => {
	if (timeZone === UTC) return ""
	let formatter = offsetFormatters.get(timeZone)
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
		offsetFormatters.set(timeZone, formatter)
	}
	return Option.match(
		Arr.findFirst(formatter.formatToParts(epochMs), (part) => part.type === "timeZoneName"),
		{
			onNone: () => "",
			onSome: ({ value }) => (value === "GMT" ? "UTC+0" : Str.replace("GMT", "UTC")(value)),
		},
	)
}

/** `Europe/Berlin` reads as `Berlin`, `America/Argentina/Buenos_Aires` as `Buenos Aires`. */
const cityOf = (timeZone: string): string =>
	Str.replaceAll("_", " ")(Option.getOrElse(Arr.last(Str.split("/")(timeZone)), () => timeZone))

export type TimestampZoneRow = Readonly<{ label: string; time: string; offset: string }>

/**
 * The card's rows, the page's zone first: it, the viewer's local zone and UTC, each once.
 * The local zone reads `Local`; another zone by its city.
 */
export const timestampZoneRows = (
	epochMs: number,
	timeZone: string,
	localZone: string,
): ReadonlyArray<TimestampZoneRow> => {
	const zones = Arr.dedupe([resolveZone(timeZone), localZone, UTC])
	const withMilliseconds = epochMs % 1000 !== 0
	return Arr.map(zones, (zone) => ({
		label: zone === UTC ? UTC : zone === localZone ? "Local" : cityOf(zone),
		time: formatTimestampInTimezone(epochMs, { timeZone: zone, withYear: true, withMilliseconds }),
		offset: utcOffsetLabel(epochMs, zone),
	}))
}

const RELATIVE_UNIT = {
	s: "second",
	m: "minute",
	h: "hour",
	d: "day",
	mo: "month",
	y: "year",
} as const

const relativeFormatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" })

/** `3 minutes ago`, `in 2 hours`, `now`: the card's spelled-out distance. */
export const timestampDistance = (epochMs: number, nowMs: number): string => {
	const { value, unit, future } = relativeParts(epochMs, nowMs)
	if (unit === "s" && value < 5) return "now"
	return relativeFormatter.format(future ? value : -value, RELATIVE_UNIT[unit])
}

/** The hover card's body: the instant in each zone, then how long ago it was. */
export const timestampCard = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ epochMs: number; timeZone: string; nowMs: number }>,
): Html =>
	h.div(
		[h.Class("flex flex-col gap-1.5 py-1"), h.DataAttribute("slot", "timestamp-card")],
		[
			h.div(
				[h.Class("grid grid-cols-[auto_auto_auto] items-baseline gap-x-3 gap-y-1")],
				Arr.flatMap(
					timestampZoneRows(options.epochMs, options.timeZone, getBrowserTimeZone()),
					(row) => [
						typography(h, { size: "xs", tone: "muted", as: "span" }, [row.label]),
						typography(h, { size: "xs", mono: true, numeric: true, as: "span" }, [row.time]),
						typography(h, { size: "2xs", tone: "muted", mono: true, numeric: true, as: "span" }, [
							row.offset,
						]),
					],
				),
			),
			typography(h, { size: "xs", tone: "muted", as: "div" }, [
				timestampDistance(options.epochMs, options.nowMs),
			]),
		],
	)

/**
 * A trigger for the app tooltip (`tooltip-host`) that opens the timezone card for this instant.
 * `data-tooltip` keeps a plain reading for the host's text fallback.
 */
export const timestampTrigger = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ epochMs: number; timeZone: string; nowMs?: number }>,
): ReadonlyArray<Attribute<M>> => [
	h.DataAttribute(
		"tooltip",
		formatTimestampInTimezone(options.epochMs, { timeZone: options.timeZone, withYear: true }),
	),
	h.DataAttribute("tooltip-instant", String(options.epochMs)),
	h.DataAttribute("tooltip-zone", options.timeZone),
	...(options.nowMs === undefined ? [] : [h.DataAttribute("tooltip-now", String(options.nowMs))]),
]

const formatText = (epochMs: number, options: TimestampOptions): string => {
	if (options.format === undefined || options.format === "absolute")
		return formatTimestampInTimezone(epochMs, {
			timeZone: options.timeZone,
			withYear: options.withYear,
			withMilliseconds: options.withMilliseconds,
		})
	switch (options.format) {
		case "relative":
			return formatRelativeFrom(epochMs, options.nowMs)
		case "relativeShort":
			return formatRelativeShortFrom(epochMs, options.nowMs)
		case "relativeOrDate":
			return formatRelativeTimeOrDate(epochMs, options.nowMs, options.timeZone)
	}
}

/** `Timestamp`: an instant, relative or absolute, whose hover card shows it in every zone that matters. */
export const timestamp = <M>(h: HtmlBuilder<M>, options: TimestampOptions): Html => {
	const epochMs = toEpochMs(options.value)
	if (!Number.isFinite(epochMs))
		return h.span([h.Class(cn("text-muted-foreground", options.className))], [EMPTY_VALUE])
	const text = options.label ?? formatText(epochMs, options)
	const label = options.prefix === undefined ? text : `${options.prefix} ${text}`
	return h.time(
		[
			...(options.trigger ?? [
				h.DataAttribute("base-ui-tooltip-trigger", ""),
				...timestampTrigger(h, { epochMs, timeZone: options.timeZone, nowMs: options.nowMs }),
			]),
			h.Class(
				cn("cursor-default", options.mono === true && "font-mono tabular-nums", options.className),
			),
			h.Attribute("datetime", new Date(epochMs).toISOString()),
			h.DataAttribute("slot", "tooltip-trigger"),
		],
		[label],
	)
}
