import { Option } from "effect"
import { Submodel } from "foldkit"
import { bucketTooltipBody } from "./bucket-tooltip"
import type { Message, Model } from "./chart"
import type { ChartSpec } from "./chart-spec"
import { plotFrame } from "./plot-frame"

// `CursorPlot` with a `height`: the plot frame in a fixed-height box, the bucket tooltip as its body.
// Embed with `h.submodel`; the card around it is the page's.

export interface PlotBoxChartInputs {
	readonly chartId: string
	readonly spec: ChartSpec
	readonly ariaLabel: string
	readonly height: number
}

export const view = Submodel.defineView<Model, Message, PlotBoxChartInputs>((model, inputs, h) =>
	h.div(
		[h.Class("w-full"), h.Style({ height: `${inputs.height}px` })],
		[
			plotFrame(h, {
				chartId: inputs.chartId,
				spec: inputs.spec,
				ariaLabel: inputs.ariaLabel,
				className: "h-full w-full",
				tooltipBody: (portal) =>
					Option.flatMap(model.tooltip, (tooltip) =>
						tooltip._tag === "Bucket"
							? Option.some(bucketTooltipBody(h, tooltip, portal))
							: Option.none(),
					),
			}),
		],
	),
)
