import { ChartBlock } from "@maple/web/charts/chart"
import { ResolveThemeColors } from "@maple/web/charts/theme-colors"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import type { Block } from "foldkit"
import { MeasureGrid } from "./command"
import { MetricsDefinition } from "./definition"

/** One chart Model every sparkline card embeds: the sparkline view reads none of it. */
export const SparklineBinding = MetricsDefinition.makeBinding(ChartBlock, { field: "sparkline" })

/** The filter rail's open, search and "show more" state per section. */
export const FilterSectionsBinding = MetricsDefinition.makeBinding(FilterSections.FilterSectionsBlock, {
	field: "sections",
})

export const MetricsComposition = MetricsDefinition.makeComposition({
	bindings: [SparklineBinding, FilterSectionsBinding],
	mounts: [MeasureGrid, ResolveThemeColors],
})
export type MetricsViewBuilder = Block.ViewBuilderFor<typeof MetricsComposition>
