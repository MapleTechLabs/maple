import { Array as Arr, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PlotGeometry } from "./chart"
import { cn } from "@maple/ui/lib/utils"
import { pressable } from "../ui/pressable"
import { tooltipTrigger } from "../ui/tooltip-host"

// Exemplars over a time chart: one dot per sampled trace, at its time and value. A dot opens its
// trace; the app tooltip names the value, service and time. Only dots that stand clear of the line
// show at rest; the rest appear when the chart's cursor reaches their bucket.

/** One exemplar as the overlay draws it. `key` comes back in `onSelect`. */
export interface ExemplarDot {
	readonly key: string
	readonly atMs: number
	readonly value: number
	/** The tooltip title: the value in the chart's unit. */
	readonly title: string
	readonly rows: ReadonlyArray<{ readonly label: string; readonly value: string }>
	/** The line's value at this time; a dot that sits on it waits for the cursor. */
	readonly baseline?: number | undefined
}

/** The visible dot, and the larger box that takes the pointer around it. */
const DOT = 6
const HIT = 16
/** How far above the line, in px, a dot must sit to show at rest. */
const STANDOUT_PX = 12

/** Whether a dot stands clear of the line, so it shows without the cursor. */
export const standsOut = (plot: PlotGeometry, dot: ExemplarDot, top: number): boolean =>
	dot.baseline === undefined ||
	Option.match(dotPosition(plot, dot.atMs, dot.baseline), {
		onNone: () => true,
		onSome: (line) => line.top - top >= STANDOUT_PX,
	})

/**
 * The dot's centre on the plot, or none when the plot has no numeric y or the time is off the plot.
 * A value above the axis pins to the plot's top edge, where it still opens its trace.
 */
export const dotPosition = (
	plot: PlotGeometry,
	atMs: number,
	value: number,
): Option.Option<{ readonly left: number; readonly top: number }> => {
	const span = plot.domainEndMs - plot.domainStartMs
	const { valueStart, valueEnd, valueRangeStart, valueRangeEnd } = plot
	if (
		span <= 0 ||
		valueStart === undefined ||
		valueEnd === undefined ||
		valueRangeStart === undefined ||
		valueRangeEnd === undefined ||
		valueEnd === valueStart
	)
		return Option.none()
	const left = plot.rangeStart + ((atMs - plot.domainStartMs) / span) * (plot.rangeEnd - plot.rangeStart)
	const raw =
		valueRangeStart + ((value - valueStart) / (valueEnd - valueStart)) * (valueRangeEnd - valueRangeStart)
	const top = Math.min(Math.max(raw, plot.y), plot.y + plot.height)
	const inside = left >= plot.x - 0.5 && left <= plot.x + plot.width + 0.5
	return inside ? Option.some({ left, top }) : Option.none()
}

/** `ExemplarOverlay`: exemplar dots over a time chart's plot, each a button that opens its trace. */
export const exemplarOverlay = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		plot: PlotGeometry
		dots: ReadonlyArray<ExemplarDot>
		onSelect: (key: string) => M
		/** The time the chart's cursor is on, which reveals that bucket's quiet dot. */
		activeMs?: number | undefined
	}>,
): Html =>
	h.div(
		[h.DataAttribute("exemplar-overlay", ""), h.Class("pointer-events-none absolute inset-0")],
		Arr.flatMap(options.dots, (dot) =>
			Option.match(dotPosition(options.plot, dot.atMs, dot.value), {
				onNone: () => [],
				onSome: ({ left, top }) => {
					const active = dot.atMs === options.activeMs
					const shown = active || standsOut(options.plot, dot, top)
					return [
						pressable(
							h,
							{
								onClick: options.onSelect(dot.key),
								label: `Open the trace behind ${dot.title}`,
								className: "group pointer-events-auto absolute grid place-items-center",
								attributes: [
									h.Key(dot.key),
									h.DataAttribute("chart-overlay", ""),
									h.Style({
										left: `${left - HIT / 2}px`,
										top: `${top - HIT / 2}px`,
										width: `${HIT}px`,
										height: `${HIT}px`,
									}),
									...tooltipTrigger(h, "Exemplar", {
										title: dot.title,
										rows: dot.rows,
										footer: "Click to open the trace",
									}),
								],
							},
							[
								h.span([
									h.Class(
										cn(
											"block rounded-full ring-2 ring-background transition-[transform,opacity] duration-100 group-hover:scale-150 group-hover:bg-foreground group-hover:opacity-100 group-active:scale-150 group-active:bg-foreground group-active:opacity-100 group-focus-visible:opacity-100",
											active ? "scale-125 bg-foreground" : "bg-muted-foreground",
											shown ? "opacity-100" : "opacity-0",
										),
									),
									h.Style({ width: `${DOT}px`, height: `${DOT}px` }),
								]),
							],
						),
					]
				},
			}),
		),
	)
