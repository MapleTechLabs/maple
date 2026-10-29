import type { Block } from "foldkit"
import { ChartBlock } from "../../../charts/chart"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { InfraCorrelationDefinition } from "./definition"
import { MountInfraCorrelation } from "./window"

/** One chart per `<kind>-<metric>` chart id, inserted when the panel requests that chart's series. */
export const ChartsBinding = InfraCorrelationDefinition.makeMapBinding(ChartBlock, { field: "charts" })

export const InfraCorrelationComposition = InfraCorrelationDefinition.makeComposition({
	bindings: [ChartsBinding],
	mounts: [ResolveThemeColors, MountInfraCorrelation],
})
export type InfraCorrelationViewBuilder = Block.ViewBuilderFor<typeof InfraCorrelationComposition>
