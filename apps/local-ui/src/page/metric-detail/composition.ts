import { ChartBlock } from "@maple/web/charts/chart"
import { ResolveThemeColors } from "@maple/web/charts/theme-colors"
import type { Block } from "foldkit"
import { MetricDetailDefinition } from "./definition"

/** The series chart's hover, legend and tooltip state. */
export const ChartBinding = MetricDetailDefinition.makeBinding(ChartBlock, { field: "chart" })

export const MetricDetailComposition = MetricDetailDefinition.makeComposition({
	bindings: [ChartBinding],
	mounts: [ResolveThemeColors],
})
export type MetricDetailViewBuilder = Block.ViewBuilderFor<typeof MetricDetailComposition>
