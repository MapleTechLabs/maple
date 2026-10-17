import type { ChartPoint, ChartValue, DomChartDefinition } from "@tanstack/charts"
import type { Option } from "effect"
import type { ChartTooltip } from "../chart-spec"

/** A definition plus the two readings the Mount turns into Messages: focus key and tooltip datum. */
export interface BuiltChart<TDatum, TXValue extends ChartValue, TYValue extends ChartValue> {
	readonly definition: DomChartDefinition<TDatum, TXValue, TYValue>
	readonly focusKeyOf: (point: ChartPoint<TDatum, TXValue, TYValue>) => string
	readonly tooltipOf: (
		points: ReadonlyArray<ChartPoint<TDatum, TXValue, TYValue>>,
	) => Option.Option<ChartTooltip>
}
