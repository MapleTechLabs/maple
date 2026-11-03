import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `AvgPeak`: avg → peak in one cell, the breakdown as its tooltip body.

export type AvgPeakOptions = Readonly<{
	avg: number
	peak: number
	format: (n: number) => string
	/** Extra tooltip line, e.g. how the source aggregates replicas. */
	note?: string
}>

/** The `avg → peak` tooltip trigger; its body is `avgPeakContent`. */
export const avgPeak = <M>(
	h: HtmlBuilder<M>,
	options: AvgPeakOptions,
	/** The page Tooltip's trigger attributes; without them only the trigger renders. */
	trigger?: ReadonlyArray<ChildAttribute>,
): Html =>
	h.span(
		[
			...(trigger ?? [h.DataAttribute("base-ui-tooltip-trigger", "")]),
			h.Class("cursor-default font-mono text-2xs tabular-nums text-foreground"),
			h.DataAttribute("slot", "tooltip-trigger"),
		],
		[
			h.span([h.Class("text-muted-foreground")], [options.format(options.avg)]),
			h.span([h.Class("mx-1 text-foreground-faint")], ["→"]),
			options.format(options.peak),
		],
	)

export const avgPeakContent = <M>(h: HtmlBuilder<M>, options: AvgPeakOptions): Html =>
	h.div(
		[h.Class("flex flex-col gap-1.5 py-0.5")],
		[
			h.div(
				[h.Class("grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 font-mono tabular-nums")],
				[
					h.span([h.Class("text-muted-foreground")], ["Average"]),
					h.span([h.Class("text-right")], [options.format(options.avg)]),
					h.span([h.Class("text-muted-foreground")], ["Peak"]),
					h.span([h.Class("text-right")], [options.format(options.peak)]),
				],
			),
			h.div(
				[h.Class("text-muted-foreground")],
				[
					h.div([], ["Over the selected time range."]),
					...(options.note === undefined ? [] : [h.div([], [options.note])]),
				],
			),
		],
	)
