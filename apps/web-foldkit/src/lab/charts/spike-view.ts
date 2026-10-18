import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import type { Message, Model } from "../../charts/chart"
import { ChartSpec, ChartTooltip } from "../../charts/chart-spec"
import { bucketTooltipBody } from "../../charts/bucket-tooltip"
import { plotFrame } from "../../charts/plot-frame"
import { legendRow, type PlotLegendSeries } from "../../charts/plot-legend"
import { resolveColor, type ThemeColors } from "../../charts/theme-colors"

// A `/lab/charts` prototype in its `PlotFrame`: the lab host draws it from `ChartSpec.LabSpike`,
// the frame carries its DOM legend (`PlotSeriesLegend`) and the tooltip body.

export interface SpikeInputs {
	readonly chartId: string
	readonly arm: string
	readonly theme: ThemeColors
	/** The tokens the arm's definition reads, resolved here (canvas cannot read `var()`). */
	readonly tokens: ReadonlyArray<string>
	readonly ariaLabel: string
	readonly className?: string
	/** `PlotSeriesLegend`: pinned emphasis by click, nothing on hover. */
	readonly legend?: Readonly<{ label: string; series: ReadonlyArray<PlotLegendSeries> }>
}

export const spikeView = Submodel.defineView<Model, Message, SpikeInputs>((model, inputs, h): Html => {
	const legend = inputs.legend
	return plotFrame(h, {
		chartId: inputs.chartId,
		className: inputs.className,
		ariaLabel: inputs.ariaLabel,
		host: "lab",
		spec: ChartSpec.LabSpike({
			arm: inputs.arm,
			colors: Object.fromEntries(inputs.tokens.map((token) => [token, resolveColor(inputs.theme, token)])),
			highlighted: legend === undefined ? null : Option.getOrNull(model.highlightedKey),
			active: null,
			hidden: [],
		}),
		legend:
			legend === undefined
				? undefined
				: legendRow(h, {
						series: legend.series,
						highlighted: model.highlightedKey,
						active: Option.none(),
						label: legend.label,
					}),
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				ChartTooltip.match(tooltip, {
					Bucket: (bucket) => Option.some(bucketTooltipBody(h, bucket, portal)),
					PieSlice: () => Option.none(),
					NumericBin: () => Option.none(),
					CategoricalBin: () => Option.none(),
					HeatmapSlot: () => Option.none(),
				}),
			),
	})
})
