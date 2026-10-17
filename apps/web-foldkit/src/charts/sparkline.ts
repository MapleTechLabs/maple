import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Message, Model } from "./chart"
import { ChartSpec } from "./chart-spec"
import { plotFrame } from "./plot-frame"

// Port of `Sparkline` (packages/ui/src/components/ui/gradient-chart.tsx) over `PlotSparkline`: no
// axes, focus or tooltip, so the chart Model only satisfies the frame. Embed it with `h.submodel`.

export interface SparklineInputs {
	readonly chartId: string
	readonly values: ReadonlyArray<number>
	/** Already resolved to a literal (canvas cannot read `var()`). */
	readonly color: string
	readonly className?: string
	/** Changes with every fetched result, so the chart redraws like `useMemo` on new data. */
	readonly revision: number
}

export const view = Submodel.defineView<Model, Message, SparklineInputs>((_model, inputs, h) =>
	inputs.values.length === 0
		? h.div([h.Class(inputs.className ?? "")], [])
		: plotFrame(h, {
				chartId: inputs.chartId,
				className: inputs.className,
				ariaLabel: "Trend",
				spec: ChartSpec.Sparkline({
					values: inputs.values,
					color: inputs.color,
					gradientId: `spark-${inputs.chartId}`,
					fillStart: 0.5,
					fillEnd: 0.1,
					revision: inputs.revision,
				}),
				tooltipBody: () => Option.none(),
			}),
)
