import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import type { Message, Model } from "./chart"
import type { ChartSpec } from "./chart-spec"
import { bucketTooltipBody } from "./bucket-tooltip"
import { plotFrame } from "./plot-frame"

// The `PlotFrame` half of `ThroughputAreaChart`, `ErrorRateAreaChart` and `LatencyLineChart`, with
// `PlotTooltipBody` as the tooltip. Embed it with `h.submodel`; the definition is built in the Mount.
// TODO(tooltip-highlight): the series nearest the pointer is not emphasised (`resolveTooltipHighlight`).

export interface FixedMetricChartInputs {
	readonly chartId: string
	readonly ariaLabel: string
	readonly spec: Extract<ChartSpec, { readonly _tag: "FixedMetric" }>
	readonly className?: string
	/** `legend="visible"`: the series row under the plot (`TimeseriesLegend`). */
	readonly legend?: Html
}

export const view = Submodel.defineView<Model, Message, FixedMetricChartInputs>((model, inputs, h) =>
	plotFrame(h, {
		chartId: inputs.chartId,
		spec: inputs.spec,
		ariaLabel: inputs.ariaLabel,
		className: inputs.className,
		legend: inputs.legend,
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				tooltip._tag === "Bucket"
					? Option.some(bucketTooltipBody(h, tooltip, portal))
					: Option.none(),
			),
	}),
)
