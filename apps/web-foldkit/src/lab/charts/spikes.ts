import { histogramSampleData } from "@maple/ui/components/charts/_shared/sample-data"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { Message, Model } from "../../charts/chart"
import { ChartSpec, ChartTooltip } from "../../charts/chart-spec"
import { countTooltipBody } from "../../charts/histogram-chart"
import { formatInterval } from "../../charts/histogram-format"
import { plotFrame } from "../../charts/plot-frame"
import { resolveColor, type ThemeColors } from "../../charts/theme-colors"

// Ports of `PieSpike` (apps/web/src/lab/charts/pie-spike.tsx) and `HistogramSpike`
// (apps/web/src/lab/charts/histogram-spike.tsx), canvas arm.

export interface PieSpikeRow {
	readonly name: string
	readonly value: number
}

const SLICE_TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"] as const
export const SPIKE_TOKENS: ReadonlyArray<string> = [...SLICE_TOKENS]

/** `useSliceColor`: a slice's colour by its row's position in the full list. */
const sliceColorFor = (theme: ThemeColors, rows: ReadonlyArray<PieSpikeRow>) => {
	const palette = SLICE_TOKENS.map((token) => resolveColor(theme, token))
	const order = new Map<string, number>()
	for (const row of rows) {
		if (!order.has(row.name)) order.set(row.name, order.size)
	}
	return (name: string): string => palette[(order.get(name) ?? 0) % palette.length] ?? palette[0] ?? ""
}

export interface PieSpikeInputs {
	readonly chartId: string
	readonly rows: ReadonlyArray<PieSpikeRow>
	readonly theme: ThemeColors
	readonly donut?: boolean
	readonly className?: string
}

const pieSpikeTooltip = (
	h: HtmlBuilder<Message>,
	tooltip: ChartTooltip,
	portal: Attribute<Message>,
): Option.Option<Html> =>
	ChartTooltip.match(tooltip, {
		PieSlice: (slice) =>
			Option.some(
				h.div(
					[h.Class("flex items-center gap-2"), portal],
					[
						h.span([
							h.Class("size-2.5 shrink-0 rounded-xs"),
							h.Style({ "background-color": slice.color }),
						]),
						h.span([h.Class("text-muted-foreground")], [slice.name]),
						h.span(
							[h.Class("font-mono font-semibold tabular-nums")],
							[`${Math.round(slice.fraction * 1000) / 10}%`],
						),
					],
				),
			),
		NumericBin: () => Option.none(),
		CategoricalBin: () => Option.none(),
		HeatmapSlot: () => Option.none(),
		Bucket: () => Option.none(),
	})

/** `PieSpike` = `PieFigure` with no legend, so `activeName` is never wired. */
export const pieSpikeView = Submodel.defineView<Model, Message, PieSpikeInputs>((model, inputs, h) => {
	const colorFor = sliceColorFor(inputs.theme, inputs.rows)
	return plotFrame(h, {
		chartId: inputs.chartId,
		className: inputs.className,
		ariaLabel: "Share by category",
		spec: ChartSpec.PieSpike({
			rows: inputs.rows.map((row) => ({ name: row.name, value: row.value, color: colorFor(row.name) })),
			donut: inputs.donut ?? true,
		}),
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) => pieSpikeTooltip(h, tooltip, portal)),
	})
})

/** `expandSampleData`: the pre-bucketed fixture spread back into evenly spaced raw observations. */
const expandSampleData = (): ReadonlyArray<number> => {
	const values: number[] = []
	let previousWidth = 50
	for (const bucket of histogramSampleData) {
		const [rawLower, rawUpper] = bucket.name.split("-")
		const lower = Number.parseFloat(rawLower ?? "")
		if (!Number.isFinite(lower)) continue
		const parsedUpper = Number.parseFloat(rawUpper ?? "")
		const upper = Number.isFinite(parsedUpper) ? parsedUpper : lower + previousWidth
		previousWidth = upper - lower
		for (let index = 0; index < bucket.value; index++) {
			values.push(lower + ((index + 0.5) / bucket.value) * (upper - lower))
		}
	}
	return values
}

/** `histogramSpikeRows`, as the plain numbers they wrap. */
export const histogramSpikeValues: ReadonlyArray<number> = expandSampleData()

export interface HistogramSpikeInputs {
	readonly chartId: string
	readonly values: ReadonlyArray<number>
	readonly theme: ThemeColors
	readonly logScaleY?: boolean
	readonly className?: string
}

export const histogramSpikeView = Submodel.defineView<Model, Message, HistogramSpikeInputs>(
	(model, inputs, h) => {
		const color = resolveColor(inputs.theme, "--chart-1")
		if (inputs.values.length === 0) {
			return h.div(inputs.className === undefined ? [] : [h.Class(inputs.className)], [
				h.div(
					[h.Class("grid h-full w-full place-items-center")],
					[h.span([h.Class("text-2xs text-muted-foreground")], ["No data"])],
				),
			])
		}
		return plotFrame(h, {
			chartId: inputs.chartId,
			className: inputs.className,
			ariaLabel: "Value distribution",
			spec: ChartSpec.BinnedHistogram({
				values: inputs.values,
				color,
				logScaleY: inputs.logScaleY ?? false,
			}),
			tooltipBody: (portal) =>
				Option.flatMap(model.tooltip, (tooltip) =>
					ChartTooltip.match(tooltip, {
						NumericBin: (bin) =>
							Option.some(
								countTooltipBody(h, formatInterval(bin.x1, bin.x2), bin.value, color, portal),
							),
						CategoricalBin: () => Option.none(),
						HeatmapSlot: () => Option.none(),
						PieSlice: () => Option.none(),
						Bucket: () => Option.none(),
					}),
				),
		})
	},
)
