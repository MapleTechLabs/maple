import { BAR_FILL, BAR_VALUE_TONE } from "@maple/web/components/infra/severity-tokens"
import { EMPTY_VALUE, formatPercent } from "@maple/ui/lib/format"
import { utilizationLevel } from "@maple/ui/lib/utilization"
import { cn } from "@maple/ui/lib/utils"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { meter } from "../../../ui/meter"

// `MeterRows` (components/infra/primitives/meter-rows.tsx) and `AvgPeak` (primitives/avg-peak.tsx).

export interface MeterRow {
	/** Short, upper-case: CPU, MEM. */
	readonly label: string
	/** 0..1; clamped, non-finite renders a dash. */
	readonly fraction: number
}

const LABEL_CLASS = cn("w-8", "shrink-0 font-mono text-3xs tracking-[0.06em] text-muted-foreground/70")

const meterRow = <M>(h: HtmlBuilder<M>, row: MeterRow, hideLabel: boolean): Html => {
	const finite = Number.isFinite(row.fraction)
	const clamped = finite ? Math.max(0, Math.min(1, row.fraction)) : 0
	const level = utilizationLevel(clamped)
	return h.div(
		[h.Class("flex items-center gap-2 leading-none")],
		[
			...(hideLabel ? [] : [h.span([h.Class(LABEL_CLASS)], [row.label])]),
			meter(h, {
				value: clamped,
				className: "h-[3px] flex-1 rounded-[1px]",
				fillClassName: BAR_FILL[level],
			}),
			h.span(
				[h.Class(cn("w-9", "shrink-0 text-right font-mono text-2xs tabular-nums", BAR_VALUE_TONE[level]))],
				[finite ? formatPercent(row.fraction) : EMPTY_VALUE],
			),
		],
	)
}

export const meterRows = <M>(
	h: HtmlBuilder<M>,
	rows: ReadonlyArray<MeterRow>,
	options: Readonly<{ hideLabels?: boolean; className?: string }> = {},
): Html =>
	h.div(
		[h.Class(cn("flex flex-col gap-1", options.className))],
		rows.map((row) => meterRow(h, row, options.hideLabels === true)),
	)

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
	trigger: ReadonlyArray<ChildAttribute>,
): Html =>
	h.span(
		[
			...trigger,
			h.Class("cursor-default font-mono text-2xs tabular-nums text-foreground"),
			h.DataAttribute("slot", "tooltip-trigger"),
		],
		[
			h.span([h.Class("text-muted-foreground")], [options.format(options.avg)]),
			h.span([h.Class("mx-1 text-foreground/30")], ["→"]),
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
