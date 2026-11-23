import { Array as Arr, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PlotGeometry } from "./chart"
import { pressable } from "../ui/pressable"
import { tooltipTrigger } from "../ui/tooltip-host"

// Exemplars over a time chart: one dot per sampled trace, at its time and value. A dot opens its
// trace; the app tooltip names the value, service and time.

/** One exemplar as the overlay draws it. `key` comes back in `onSelect`. */
export interface ExemplarDot {
	readonly key: string
	readonly atMs: number
	readonly value: number
	/** The tooltip title: the value in the chart's unit. */
	readonly title: string
	readonly rows: ReadonlyArray<{ readonly label: string; readonly value: string }>
}

const DOT = 9

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
	}>,
): Html =>
	h.div(
		[h.DataAttribute("exemplar-overlay", ""), h.Class("pointer-events-none absolute inset-0")],
		Arr.flatMap(options.dots, (dot) =>
			Option.match(dotPosition(options.plot, dot.atMs, dot.value), {
				onNone: () => [],
				onSome: ({ left, top }) => [
					pressable(
						h,
						{
							onClick: options.onSelect(dot.key),
							label: `Open the trace behind ${dot.title}`,
							className:
								"pointer-events-auto absolute rotate-45 rounded-2xs border border-background bg-primary transition-transform duration-100 hover:scale-150 active:scale-150",
							attributes: [
								h.Key(dot.key),
								h.DataAttribute("chart-overlay", ""),
								h.Style({
									left: `${left - DOT / 2}px`,
									top: `${top - DOT / 2}px`,
									width: `${DOT}px`,
									height: `${DOT}px`,
								}),
								...tooltipTrigger(h, "Exemplar", {
									title: dot.title,
									rows: dot.rows,
									footer: "Click to open the trace",
								}),
							],
						},
						[],
					),
				],
			}),
		),
	)
