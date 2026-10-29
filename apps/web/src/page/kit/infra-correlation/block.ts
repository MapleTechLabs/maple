import { Layer } from "effect"
import { Block } from "foldkit"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { FetchCorrelationSeries } from "./command"
import { InfraCorrelationComposition } from "./composition"
import type { Model } from "./model"
import { initPanel, update } from "./update"
import { view } from "./view"
import { MountInfraCorrelation } from "./window"

/** The panel's series reads and mount, plus the shared chart runtime and theme effects it starts. */
const EffectsLayer = Layer.mergeAll(
	FetchCorrelationSeries.layer,
	MountInfraCorrelation.layer,
	LoadChartRuntime.layer,
	ResolveThemeColors.layer,
)

const prepare = () =>
	InfraCorrelationComposition.prepareBlock({ init: initPanel, update, view, EffectsLayer })
export const InfraCorrelationBlock: Block.FromAssemblyWithView<typeof Model, typeof prepare> =
	Block.assemble(prepare)
