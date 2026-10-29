import { ChartBlock } from "@maple/web/charts/chart"
import { ResolveThemeColors } from "@maple/web/charts/theme-colors"
import type { Block } from "foldkit"
import { ServiceDetailDefinition } from "./definition"

// Each chart on the page keeps its own hover and size state, as the old per-chartId record did.

export const LatencyChartBinding = ServiceDetailDefinition.makeBinding(ChartBlock, { field: "latencyChart" })
export const ThroughputChartBinding = ServiceDetailDefinition.makeBinding(ChartBlock, {
	field: "throughputChart",
})
export const ApdexChartBinding = ServiceDetailDefinition.makeBinding(ChartBlock, { field: "apdexChart" })
export const ErrorRateChartBinding = ServiceDetailDefinition.makeBinding(ChartBlock, {
	field: "errorRateChart",
})
export const OperationsChartBinding = ServiceDetailDefinition.makeBinding(ChartBlock, {
	field: "operationsChart",
})

export const ServiceDetailComposition = ServiceDetailDefinition.makeComposition({
	bindings: [
		LatencyChartBinding,
		ThroughputChartBinding,
		ApdexChartBinding,
		ErrorRateChartBinding,
		OperationsChartBinding,
	],
	mounts: [ResolveThemeColors],
})
export type ServiceDetailViewBuilder = Block.ViewBuilderFor<typeof ServiceDetailComposition>
