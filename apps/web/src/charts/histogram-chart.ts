import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html } from "foldkit/html"
import { type ChartAttribute, ChartBlock, type ChartViewBuilder } from "./chart"
import { type CategoricalBin, ChartSpec, ChartTooltip, type NumericBin } from "./chart-spec"
import { formatBound } from "./histogram-format"
import { plotFrame } from "./plot-frame"
import { resolveColor, type ThemeColors } from "./theme-colors"

// Port of `QueryBuilderHistogramChart` (packages/ui/src/components/charts/histogram/
// query-builder-histogram-chart.tsx), view half. Definitions are in ./definitions/histogram.ts.

export interface HistogramChartInputs {
	readonly chartId: string
	readonly data: ReadonlyArray<Record<string, unknown>>
	readonly theme: ThemeColors
	readonly className?: string
	readonly tooltip?: "visible" | "hidden"
	readonly unit?: string
	readonly logScale?: boolean
	readonly logScaleY?: boolean
	readonly bucketCount?: number
	readonly bucketWidth?: number
}

const DEFAULT_BIN_COUNT = 30
export const HISTOGRAM_BAR_TOKEN = "--chart-1"

const asFiniteNumber = (value: unknown): number => {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

const isPrebucketed = (rows: ReadonlyArray<Record<string, unknown>>): boolean =>
	rows.length > 0 &&
	rows.every((row) => typeof row.name === "string" && typeof row.value === "number") &&
	rows.length <= 200

const pickValueField = (rows: ReadonlyArray<Record<string, unknown>>): string => {
	const first = rows[0]
	if (first === undefined) return "value"
	return (
		Object.keys(first).find(
			(key) => key !== "name" && key !== "bucket" && typeof first[key] === "number",
		) ?? "value"
	)
}

/** The `numeric` memo: raw observations into `binCount` equal-width bins. */
const numericBins = (
	source: ReadonlyArray<Record<string, unknown>>,
	binCount: number,
	binWidth: number | undefined,
): ReadonlyArray<NumericBin> => {
	const valueField = pickValueField(source)
	const values = source
		.map((row) => row[valueField])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
	if (values.length === 0) return []
	const min = Math.min(...values)
	const max = Math.max(...values)
	const span = max - min
	const width = binWidth ?? (span > 0 ? span / binCount : 1)
	const safeWidth = width > 0 ? width : 1
	const counts = new Map<number, number>()
	for (const value of values) {
		const index = Math.min(Math.floor((value - min) / safeWidth), binCount - 1)
		counts.set(index, (counts.get(index) ?? 0) + 1)
	}
	return Array.from({ length: binCount }, (_, index) => {
		const lower = min + index * safeWidth
		return { x1: lower, x2: lower + safeWidth, value: counts.get(index) ?? 0 }
	})
}

/** `CountTooltipBody`. Shared with the histogram spike, whose body is the same markup. */
export const countTooltipBody = (
	h: ChartViewBuilder,
	heading: string,
	count: number,
	color: string,
	portal: ChartAttribute,
): Html =>
	h.div(
		[h.Class("grid min-w-[9rem] items-start gap-1.5"), portal],
		[
			h.div(
				[h.Class("border-border/50 border-b pb-1 font-medium text-muted-foreground tracking-tight")],
				[heading],
			),
			h.div(
				[h.Class("flex w-full items-center gap-2")],
				[
					h.span([h.Class("size-2.5 shrink-0 rounded-xs"), h.Style({ "background-color": color })]),
					h.div(
						[h.Class("flex flex-1 items-center justify-between gap-3 leading-none")],
						[
							h.span([h.Class("text-muted-foreground")], ["Count"]),
							h.span(
								[h.Class("font-mono font-semibold text-foreground tabular-nums")],
								[formatNumber(count)],
							),
						],
					),
				],
			),
		],
	)

const histogramTooltipBody = (
	h: ChartViewBuilder,
	tooltip: ChartTooltip,
	color: string,
	unit: string | undefined,
	portal: ChartAttribute,
): Option.Option<Html> =>
	ChartTooltip.match(tooltip, {
		NumericBin: (bin) =>
			Option.some(
				countTooltipBody(
					h,
					`${formatBound(bin.x1, unit ?? null)} – ${formatBound(bin.x2, unit ?? null)}`,
					bin.value,
					color,
					portal,
				),
			),
		CategoricalBin: (bin) => Option.some(countTooltipBody(h, bin.name, bin.value, color, portal)),
		HeatmapSlot: () => Option.none(),
		PieSlice: () => Option.none(),
		Bucket: () => Option.none(),
	})

export const view = ChartBlock.makeView.withInputs<HistogramChartInputs>((model, inputs, h) => {
	const source = inputs.data
	const binCount = inputs.bucketCount ?? DEFAULT_BIN_COUNT
	const useLogY = inputs.logScaleY ?? inputs.logScale ?? false
	const showTooltip = inputs.tooltip !== "hidden"
	const color = resolveColor(inputs.theme, HISTOGRAM_BAR_TOKEN)
	const frame = (spec: ChartSpec) =>
		plotFrame(h, {
			chartId: inputs.chartId,
			className: inputs.className,
			ariaLabel: "Value distribution",
			spec,
			tooltipBody: (portal) =>
				Option.flatMap(model.tooltip, (tooltip) =>
					histogramTooltipBody(h, tooltip, color, inputs.unit, portal),
				),
		})

	if (isPrebucketed(source)) {
		const bins: ReadonlyArray<CategoricalBin> = source.map((row) => ({
			name: String(row.name ?? EMPTY_VALUE),
			value: asFiniteNumber(row.value),
		}))
		return frame(ChartSpec.CategoricalHistogram({ bins, color, useLogY, showTooltip }))
	}

	const bins = numericBins(source, binCount, inputs.bucketWidth)
	if (bins.length > 0) {
		return frame(
			ChartSpec.NumericHistogram({ bins, color, unit: inputs.unit ?? null, useLogY, showTooltip }),
		)
	}

	return h.div(
		[h.Class(cn("relative grid h-full w-full place-items-center", inputs.className))],
		[h.span([h.Class("text-2xs text-muted-foreground")], ["No data"])],
	)
})
