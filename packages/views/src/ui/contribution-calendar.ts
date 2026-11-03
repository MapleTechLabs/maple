import { cn } from "@maple/ui/lib/utils"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { hstack, vstack } from "./stack"
import { typography } from "./typography"

// One cell per day, a column per week; levels on the amber heatmap ramp.

export type ContributionLevel = 0 | 1 | 2 | 3 | 4

export type ContributionDay = Readonly<{
	/** `YYYY-MM-DD`. */
	day: string
	level: ContributionLevel
	/** The cell's accessible name and native tooltip. */
	label: string
	attributes?: ReadonlyArray<ChildAttribute>
}>

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""]

/** The amber heatmap ramp; an empty day is a faint wash of the foreground. */
const LEVEL_COLOR = {
	0: "color-mix(in oklch, var(--foreground) 8%, transparent)",
	1: "var(--heatmap-amber-1)",
	2: "var(--heatmap-amber-2)",
	3: "var(--heatmap-amber-3)",
	4: "var(--heatmap-amber-4)",
} as const satisfies Readonly<Record<ContributionLevel, string>>

/** A short window gets bigger cells, so a month does not read as a smudge. */
const cellSizeOf = (weeks: number) => (weeks <= 10 ? 20 : weeks <= 27 ? 16 : 12)
const GAP_PX = 3

const partsOf = (day: string) => {
	const [year = 0, month = 1, date = 1] = day.split("-").map(Number)
	return { year, month, date, weekday: new Date(Date.UTC(year, month - 1, date)).getUTCDay() }
}

/** The level of a count against the busiest day: four even steps, any activity at least the first. */
export const contributionLevel = (count: number, max: number): ContributionLevel =>
	count <= 0 || max <= 0 ? 0 : (Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as ContributionLevel)

/**
 * A GitHub-style contribution calendar: one cell per day in a column per week (Sunday first),
 * month labels above, weekday labels beside and a Less/More legend below; the caller sets each
 * cell's level and attributes (a hover card trigger, a label).
 */
export const contributionCalendar = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		/** Every day of the range, in order. */
		days: ReadonlyArray<ContributionDay>
		ariaLabel: string
		className?: string
	}>,
): Html => {
	const first = options.days[0]
	const lead = first === undefined ? 0 : partsOf(first.day).weekday
	const weeks = Math.ceil((lead + options.days.length) / 7)
	const size = cellSizeOf(weeks)
	const columns = { "grid-template-columns": `repeat(${weeks}, ${size}px)`, gap: `${GAP_PX}px` }
	// A month's label sits over the first week that starts in it.
	const monthLabels = options.days.flatMap((entry, index) => {
		const parts = partsOf(entry.day)
		const column = Math.floor((lead + index) / 7)
		const isFirstLabel = index === 0
		return parts.date === 1 || isFirstLabel
			? [{ column, label: MONTHS[parts.month - 1] ?? "", key: entry.day }]
			: []
	})
	// A label too close to the next one is dropped, as GitHub does for a partial first month.
	const months = monthLabels.filter((label, index) => {
		const next = monthLabels[index + 1]
		return next === undefined || next.column - label.column >= 3
	})
	const cells: ReadonlyArray<Html> = [
		...Array.from({ length: lead }, (_, index) =>
			h.div([h.Key(`lead-${index}`), h.AriaHidden(true)], []),
		),
		...options.days.map((entry) =>
			h.div(
				[
					h.Key(entry.day),
					h.Role("gridcell"),
					h.AriaLabel(entry.label),
					h.DataAttribute("level", String(entry.level)),
					h.Class(
						"rounded-xs outline-offset-1 hover:outline hover:outline-1 hover:outline-foreground/50 active:outline active:outline-1 active:outline-foreground/50 data-[popup-open]:outline data-[popup-open]:outline-1 data-[popup-open]:outline-foreground/70",
					),
					h.Style({
						width: `${size}px`,
						height: `${size}px`,
						"background-color": LEVEL_COLOR[entry.level],
					}),
					...(entry.attributes ?? []),
				],
				[],
			),
		),
	]
	return vstack(
		h,
		{ gap: "2", align: "start", className: cn("w-fit max-w-full overflow-x-auto", options.className) },
		[
			hstack(h, { gap: "2", align: "start" }, [
				// Weekday labels, lined up with the rows under the month strip.
				h.div(
					[
						h.Class("grid shrink-0"),
						h.Style({
							"grid-template-rows": `14px repeat(7, ${size}px)`,
							"row-gap": `${GAP_PX}px`,
						}),
					],
					["", ...WEEKDAYS].map((label, index) =>
						typography(
							h,
							{
								size: "2xs",
								tone: "muted",
								className: "leading-none self-center",
								attributes: [h.Key(`weekday-${index}`)],
							},
							[label],
						),
					),
				),
				vstack(
					h,
					{
						gap: "0",
						align: "start",
						attributes: [h.Role("grid"), h.AriaLabel(options.ariaLabel)],
					},
					[
						h.div(
							[h.Class("grid h-[14px]"), h.Style(columns), h.AriaHidden(true)],
							months.map((month) =>
								typography(
									h,
									{
										size: "2xs",
										tone: "muted",
										className: "leading-none whitespace-nowrap",
										attributes: [
											h.Key(month.key),
											h.Style({ "grid-column-start": String(month.column + 1) }),
										],
									},
									[month.label],
								),
							),
						),
						h.div(
							[
								h.Class("grid grid-flow-col"),
								h.Style({
									...columns,
									"grid-template-rows": `repeat(7, ${size}px)`,
									"margin-top": `${GAP_PX}px`,
								}),
							],
							cells,
						),
					],
				),
			]),
			hstack(h, { gap: "1", className: "self-end", attributes: [h.AriaHidden(true)] }, [
				typography(h, { size: "2xs", tone: "muted", className: "mr-1" }, ["Less"]),
				...([0, 1, 2, 3, 4] as const).map((level) =>
					h.div(
						[
							h.Key(`legend-${level}`),
							h.Class("size-2.5 rounded-xs"),
							h.Style({ "background-color": LEVEL_COLOR[level] }),
						],
						[],
					),
				),
				typography(h, { size: "2xs", tone: "muted", className: "ml-1" }, ["More"]),
			]),
		],
	)
}
