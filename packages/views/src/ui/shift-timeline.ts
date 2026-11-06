import { zonedDateParts, zonedPartsToEpochMs } from "@maple/query-engine/datetime"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { pressable } from "./pressable"
import { hstack, vstack } from "./stack"
import { toneBoxClass } from "./tone-box"
import { tooltipTrigger } from "./tooltip-host"
import { typography } from "./typography"

// `ShiftTimeline`: rows of time bars over a day-ruled axis in one time zone, with a now line (an
// on-call schedule's layers and its final row). Days follow the zone's wall clock, so a DST day is
// 23 or 25 hours wide.

/** A bar's look: a layer's shift, the effective shift, or an override over it. */
export type TimelineBarTone = "neutral" | "primary" | "info"

export type TimelineBar<M> = Readonly<{
	key: string
	startMs: number
	endMs: number
	label: string
	/** The tooltip and accessible name: who, and from when to when. */
	title: string
	tone: TimelineBarTone
	onClick?: M
}>

export type TimelineRow<M> = Readonly<{
	key: string
	label: string
	detail?: string
	bars: ReadonlyArray<TimelineBar<M>>
	/** What an empty row says, for a row with no bars in the range. */
	emptyText?: string
}>

/** One wall-clock day of the axis, as a share of the range. */
export type TimelineDay = Readonly<{
	startMs: number
	endMs: number
	weekday: string
	dayOfMonth: number
	leftPct: number
	widthPct: number
}>

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>()
const weekdayOf = (ms: number, timeZone: string): string => {
	const cached = weekdayFormatters.get(timeZone)
	const formatter = cached ?? new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
	if (cached === undefined) weekdayFormatters.set(timeZone, formatter)
	return formatter.format(ms)
}

/** The instant the wall-clock day containing `ms` starts in `timeZone`, `offsetDays` later. */
export const zonedDayStart = (ms: number, timeZone: string, offsetDays = 0): number => {
	const parts = zonedDateParts(ms, timeZone)
	return zonedPartsToEpochMs(
		{ ...parts, day: parts.day + offsetDays, hour: 0, minute: 0, second: 0 },
		timeZone,
	)
}

/** Where `[startMs, endMs)` sits in the range, clipped to it; none when it falls outside. */
export const placeBar = (
	fromMs: number,
	toMs: number,
	startMs: number,
	endMs: number,
): Option.Option<Readonly<{ leftPct: number; widthPct: number }>> => {
	const span = toMs - fromMs
	const start = Math.max(startMs, fromMs)
	const end = Math.min(endMs, toMs)
	return span <= 0 || end <= start
		? Option.none()
		: Option.some({ leftPct: ((start - fromMs) / span) * 100, widthPct: ((end - start) / span) * 100 })
}

/** The wall-clock days the range covers in `timeZone`, each clipped to the range. */
export const timelineDays = (fromMs: number, toMs: number, timeZone: string): ReadonlyArray<TimelineDay> => {
	const count = Math.ceil((toMs - fromMs) / 82_800_000) + 1
	return Arr.flatMap(Arr.range(0, count), (offset): ReadonlyArray<TimelineDay> => {
		const startMs = zonedDayStart(fromMs, timeZone, offset)
		const endMs = zonedDayStart(fromMs, timeZone, offset + 1)
		return Option.match(placeBar(fromMs, toMs, startMs, endMs), {
			onNone: () => [],
			onSome: (place) => [
				{
					startMs,
					endMs,
					weekday: weekdayOf(Math.max(startMs, fromMs), timeZone),
					dayOfMonth: zonedDateParts(Math.max(startMs, fromMs), timeZone).day,
					...place,
				},
			],
		})
	})
}

const BAR_TONE = {
	neutral: "bg-surface-strong border-border text-foreground",
	primary: toneBoxClass("primary"),
	info: toneBoxClass("info"),
} as const satisfies Record<TimelineBarTone, string>

const BAR_CLASS = "absolute inset-y-1 overflow-hidden rounded-sm border px-1.5 text-left"

const barView = <M>(
	h: HtmlBuilder<M>,
	fromMs: number,
	toMs: number,
	bar: TimelineBar<M>,
): ReadonlyArray<Html> =>
	Option.match(placeBar(fromMs, toMs, bar.startMs, bar.endMs), {
		onNone: () => [],
		onSome: ({ leftPct, widthPct }) => {
			// A 2px gutter keeps back-to-back shifts apart.
			const style = h.Style({ left: `${leftPct}%`, width: `calc(${widthPct}% - 2px)` })
			const text = typography(h, { size: "xs", truncate: true, className: "block leading-6" }, [
				bar.label,
			])
			const attributes = [h.Key(bar.key), style, ...tooltipTrigger(h, bar.title)]
			return [
				bar.onClick === undefined
					? h.div(
							[
								...attributes,
								h.Class(cn(BAR_CLASS, BAR_TONE[bar.tone])),
								h.AriaLabel(bar.title),
							],
							[text],
						)
					: pressable(
							h,
							{
								onClick: bar.onClick,
								label: bar.title,
								className: cn(
									BAR_CLASS,
									BAR_TONE[bar.tone],
									"hover:border-ring active:border-ring",
								),
								attributes,
							},
							[text],
						),
			]
		},
	})

const LABEL_COLUMN = "sticky left-0 z-10 w-32 shrink-0 border-r bg-background px-3 sm:w-40"

/**
 * The timeline: a header of days, then one row per lane (label column, bars track), ruled by day,
 * with a now line when `nowMs` is inside the range. Scrolls sideways under a phone's width.
 */
export const shiftTimeline = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		fromMs: number
		toMs: number
		timeZone: string
		nowMs: number
		rows: ReadonlyArray<TimelineRow<M>>
		ariaLabel: string
		/** A key under the timeline for the bar tones it uses. */
		legend?: ReadonlyArray<Readonly<{ tone: TimelineBarTone; label: string }>>
	}>,
): Html => {
	const { fromMs, toMs } = options
	const days = timelineDays(fromMs, toMs, options.timeZone)
	const now = placeBar(fromMs, toMs, options.nowMs, options.nowMs + 1)
	const rules = h.div(
		[h.AriaHidden(true), h.Class("pointer-events-none absolute inset-0")],
		Arr.map(days, (day) =>
			h.div(
				[
					h.Key(`rule-${day.startMs}`),
					h.Class("absolute inset-y-0 border-l border-border-subtle"),
					h.Style({ left: `${day.leftPct}%` }),
				],
				[],
			),
		),
	)
	const nowLine = Option.match(now, {
		onNone: () => [],
		onSome: ({ leftPct }) => [
			h.div(
				[
					h.Key("now"),
					h.DataAttribute("slot", "timeline-now"),
					h.AriaLabel("Now"),
					h.Class("pointer-events-none absolute inset-y-0 w-px bg-primary"),
					h.Style({ left: `${leftPct}%` }),
				],
				[],
			),
		],
	})
	const header = h.div(
		[h.Class("flex border-b")],
		[
			h.div([h.Class(LABEL_COLUMN)], []),
			h.div(
				[h.Class("relative h-8 grow")],
				Arr.map(days, (day) =>
					h.div(
						[
							h.Key(`day-${day.startMs}`),
							h.Class(
								"absolute inset-y-0 overflow-hidden border-l border-border-subtle px-1.5 py-1.5",
							),
							h.Style({ left: `${day.leftPct}%`, width: `${day.widthPct}%` }),
						],
						[
							typography(
								h,
								{
									size: "xs",
									tone: "muted",
									numeric: true,
									truncate: true,
									className: "block",
								},
								[`${day.weekday} ${day.dayOfMonth}`],
							),
						],
					),
				),
			),
		],
	)
	const rowView = (row: TimelineRow<M>): Html =>
		h.div(
			[h.Key(row.key), h.Class("flex border-b last:border-b-0"), h.Role("row")],
			[
				vstack(
					h,
					{
						gap: "0",
						justify: "center",
						className: cn(LABEL_COLUMN, "py-1.5"),
						attributes: [h.Role("rowheader")],
					},
					[
						typography(h, { size: "xs", weight: "medium", truncate: true }, [row.label]),
						...(row.detail === undefined
							? []
							: [typography(h, { size: "2xs", tone: "muted", truncate: true }, [row.detail])]),
					],
				),
				h.div(
					[h.Class("relative h-8 grow"), h.Role("cell")],
					row.bars.length === 0 && row.emptyText !== undefined
						? [
								typography(
									h,
									{ size: "xs", tone: "faint", className: "block px-2 leading-8" },
									[row.emptyText],
								),
							]
						: Arr.flatMap(row.bars, (bar) => barView(h, fromMs, toMs, bar)),
				),
			],
		)
	const legend = Arr.map(options.legend ?? [], (entry) =>
		hstack(h, { gap: "1.5", as: "span", attributes: [h.Key(entry.label)] }, [
			h.span([h.AriaHidden(true), h.Class(cn("size-3 rounded-xs border", BAR_TONE[entry.tone]))], []),
			typography(h, { size: "xs", tone: "muted" }, [entry.label]),
		]),
	)
	const frame = h.div(
		[h.Class("overflow-x-auto rounded-md border"), h.DataAttribute("slot", "shift-timeline")],
		[
			h.div(
				[h.Class("relative min-w-[720px]"), h.Role("table"), h.AriaLabel(options.ariaLabel)],
				[
					header,
					h.div(
						[h.Class("relative")],
						[
							h.div(
								[
									h.Class(
										"pointer-events-none absolute inset-y-0 right-0 left-32 sm:left-40",
									),
								],
								[rules, ...nowLine],
							),
							...Arr.map(options.rows, rowView),
						],
					),
				],
			),
		],
	)
	return legend.length === 0
		? frame
		: vstack(h, { gap: "2" }, [frame, hstack(h, { gap: "4", wrap: true }, legend)])
}
