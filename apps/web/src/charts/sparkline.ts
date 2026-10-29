import { Option } from "effect"
import { ChartBlock } from "./chart"
import { ChartSpec } from "./chart-spec"
import { plotFrame } from "./plot-frame"

// Port of `Sparkline` (packages/ui/src/components/ui/gradient-chart.tsx) over `PlotSparkline`: no
// axes, focus or tooltip, so the chart Model only satisfies the frame. Embed it as `view` of a `ChartBlock` Binding.

export interface SparklineInputs {
	readonly chartId: string
	readonly values: ReadonlyArray<number>
	/** Already resolved to a literal (canvas cannot read `var()`). */
	readonly color: string
	readonly className?: string
	/** Changes with every fetched result, so the chart redraws like `useMemo` on new data. */
	readonly revision: number
	/** `PlotSparkline`'s `curve` and `fillOpacity` (the stat widget's monotone, `[0.35, 0]`). */
	readonly curve?: "linear" | "monotone"
	readonly fillOpacity?: readonly [start: number, end: number]
	/** `PlotSparkline` frames an empty series too (the gradient `Sparkline` draws nothing). */
	readonly isFramedWhenEmpty?: boolean
}

export const view = ChartBlock.makeView.withInputs<SparklineInputs>((_model, inputs, h) =>
	inputs.values.length === 0 && inputs.isFramedWhenEmpty !== true
		? h.div([h.Class(inputs.className ?? "")], [])
		: plotFrame(h, {
				chartId: inputs.chartId,
				className: inputs.className,
				ariaLabel: "Trend",
				spec: ChartSpec.Sparkline({
					values: inputs.values,
					color: inputs.color,
					gradientId: `spark-${inputs.chartId}`,
					fillStart: inputs.fillOpacity?.[0] ?? 0.5,
					fillEnd: inputs.fillOpacity?.[1] ?? 0.1,
					revision: inputs.revision,
					curve: inputs.curve ?? "linear",
				}),
				tooltipBody: () => Option.none(),
			}),
)
