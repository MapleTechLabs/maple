import { cn } from "@maple/ui/lib/utils"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { hstack, vstack } from "./stack"
import { typography } from "./typography"
import { tooltipTrigger, type TriggerOptions } from "./tooltip-host"
import { Array as Arr, String as Str } from "effect"

// One cell per day, a column per week; levels on the amber heatmap ramp.

export type ContributionLevel = 0 | 1 | 2 | 3 | 4

export type ContributionDay = Readonly<{
	/** `YYYY-MM-DD`. */
	day: string
	level: ContributionLevel
	/** The cell's accessible name and native tooltip. */
	label: string
	/** Makes the day a link (e.g. to that day's data). */
	href?: string
	/** Outlined: the day is in the range the page shows. */
	isSelected?: boolean
	/** The app's tooltip on hover: `content` under an optional bold `title`. Without it, `label` is the native tooltip. */
	tooltip?: Readonly<{ content: string } & TriggerOptions>
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

const GAP_PX = 4

const partsOf = (day: string) => {
	const [year, month = 1, date = 1] = Arr.map(Str.split("-")(day), Number)
	return { year, month, date, weekday: new Date(Date.UTC(year, month - 1, date)).getUTCDay() }
}

/** The level of a count against the busiest day: four even steps, any activity at least the first. */
export const contributionLevel = (count: number, max: number): ContributionLevel =>
	count <= 0 || max <= 0 ? 0 : (Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as ContributionLevel)

/**
 * A GitHub-style contribution calendar: one square per day in a column per week (Sunday first),
 * stretched to the full width, with month labels above, weekday labels beside and a Less/More
 * legend below; the caller sets each cell's level and attributes (a hover card trigger, a label).
 */
export const contributionCalendar = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		/** Every day of the range, in order. */
		days: ReadonlyArray<ContributionDay>
		ariaLabel: string
		/** Left of the legend: a summary line. */
		summary?: Html | string
		/** A fixed square size in px for a short range; without it the weeks stretch to the full width. */
		cellSize?: number
		className?: string
	}>,
): Html => {
	const first = options.days[0]
	const lead = first === undefined ? 0 : partsOf(first.day).weekday
	const weeks = Math.ceil((lead + options.days.length) / 7)
	// A month's label sits over the first week that starts in it.
	const monthLabels = Arr.flatMap(options.days, (entry, index) => {
		const parts = partsOf(entry.day)
		const column = Math.floor((lead + index) / 7)
		return parts.date === 1 || index === 0
			? [{ column, label: MONTHS[parts.month - 1] ?? "", key: entry.day }]
			: []
	})
	// A label too close to the next one is dropped, as GitHub does for a partial first month.
	const months = Arr.filter(monthLabels, (label, index) => {
		const next = monthLabels[index + 1]
		// The last label needs two weeks of room, or it is cut off at the edge.
		return next === undefined ? weeks - label.column >= 2 : next.column - label.column >= 3
	})
	const size = options.cellSize
	const at = (column: number, row: number) =>
		h.Style({ "grid-column-start": String(column + 2), "grid-row-start": String(row + 2) })
	const cellClass = cn(
		"rounded-cell outline-offset-1 hover:outline hover:outline-2 hover:outline-foreground/50 active:outline active:outline-2 active:outline-foreground/50 data-[popup-open]:outline data-[popup-open]:outline-2 data-[popup-open]:outline-foreground/70 data-[selected]:outline data-[selected]:outline-1 data-[selected]:outline-foreground/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
		size === undefined && "aspect-square w-full",
	)
	return vstack(
		h,
		{ gap: "3", className: cn(size === undefined ? "w-full" : "w-fit max-w-full", options.className) },
		[
			h.div(
				// Padded by a day's outline reach (offset 1 + width 2), so the scroller does not clip it.
				[h.Class("-m-1 overflow-x-auto p-1")],
				[
					// One grid: weekday labels in the first column, a month strip in the first row.
					h.div(
						[
							h.Class(size === undefined ? "grid min-w-[44rem]" : "inline-grid"),
							h.Role("grid"),
							h.AriaLabel(options.ariaLabel),
							h.Style({
								"grid-template-columns": `auto repeat(${weeks}, ${size === undefined ? "minmax(0, 1fr)" : `${size}px`})`,
								...(size !== undefined && {
									"grid-template-rows": `auto repeat(7, ${size}px)`,
								}),
								gap: `${GAP_PX}px`,
							}),
						],
						[
							...Arr.map(months, (month) =>
								typography(
									h,
									{
										size: "xs",
										tone: "muted",
										className: "whitespace-nowrap pb-1 leading-none",
										attributes: [
											h.Key(`month-${month.key}`),
											h.AriaHidden(true),
											at(month.column, -1),
										],
									},
									[month.label],
								),
							),
							...Arr.map(WEEKDAYS, (label, row) =>
								typography(
									h,
									{
										size: "xs",
										tone: "muted",
										className: "self-center pr-2 leading-none",
										attributes: [
											h.Key(`weekday-${row}`),
											h.AriaHidden(true),
											at(-1, row),
										],
									},
									[label],
								),
							),
							...Arr.map(options.days, (entry, index) => {
								const attributes = [
									h.Key(entry.day),
									h.Role("gridcell"),
									h.AriaLabel(entry.label),
									// A caller with its own trigger (a hover card) gets no native tooltip on top.
									...(entry.tooltip !== undefined
										? // Days sit 4px apart: the open tooltip moves from day to day instead of closing.
											tooltipTrigger(h, entry.tooltip.content, {
												...entry.tooltip,
												isGrouped: true,
											})
										: entry.attributes === undefined
											? [h.Title(entry.label)]
											: []),
									h.DataAttribute("level", String(entry.level)),
									...(entry.isSelected === true ? [h.DataAttribute("selected", "")] : []),
									h.Class(cn(cellClass, entry.href !== undefined && "block")),
									h.Style({
										"grid-column-start": String(Math.floor((lead + index) / 7) + 2),
										"grid-row-start": String(((lead + index) % 7) + 2),
										"background-color": LEVEL_COLOR[entry.level],
									}),
									...(entry.attributes ?? []),
								]
								return entry.href === undefined
									? h.div(attributes, [])
									: h.a([...attributes, h.Href(entry.href)], [])
							}),
						],
					),
				],
			),
			hstack(h, { gap: "4", justify: "between", wrap: true }, [
				options.summary === undefined
					? h.span([], [])
					: typography(h, { size: "xs", tone: "muted" }, [options.summary]),
				hstack(h, { gap: "1", attributes: [h.AriaHidden(true)] }, [
					typography(h, { size: "xs", tone: "muted", className: "mr-1" }, ["Less"]),
					...Arr.map([0, 1, 2, 3, 4] as const, (level) =>
						h.div(
							[
								h.Key(`legend-${level}`),
								h.Class("size-3 rounded-cell"),
								h.Style({ "background-color": LEVEL_COLOR[level] }),
							],
							[],
						),
					),
					typography(h, { size: "xs", tone: "muted", className: "ml-1" }, ["More"]),
				]),
			]),
		],
	)
}
