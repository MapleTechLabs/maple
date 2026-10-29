import { Layer, Option } from "effect"
import { Block } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { Attribute, HtmlBuilder } from "foldkit/html"
import { ChartDefinition, type Message, Model } from "./chart-definition"
import { MeasureChartContainer, MountChart, PortalTooltipBody } from "./chart-mounts"

export { Message, Model, PlotGeometry } from "./chart-definition"

// One chart's interaction state as a completed Block. It has no primary view: each chart kind
// (`area-chart`, `sparkline`, ...) is an alternate view from `ChartBlock.makeView`.

const ChartComposition = ChartDefinition.makeComposition({
	mounts: [MountChart, PortalTooltipBody, MeasureChartContainer],
})
/** The builder every chart view and the frame's Mount-bearing helpers render with. */
export type ChartViewBuilder = Block.ViewBuilderFor<typeof ChartComposition>
type ChartMountRequirements =
	ChartViewBuilder extends HtmlBuilder<Message, infer Requirements> ? Requirements : never
/** An Attribute a chart view may carry, including its registered Mounts (the tooltip portal). */
export type ChartAttribute = Attribute<Message, ChartMountRequirements>

/** The resting chart Model, for a parent that constructs or resets a chart directly. */
export const initialModel = (): Model => ({
	plot: Option.none(),
	activeKey: Option.none(),
	highlightedKey: Option.none(),
	tooltip: Option.none(),
	containerWidth: 0,
	containerHeight: 0,
	hiddenKeys: [],
	activeGroup: Option.none(),
})

const init = ChartComposition.makeInit(() => ({ model: initialModel() }))

// UPDATE

/** `useSeriesVisibility`'s toggle: unhide, or hide unless it is the last series left. */
const toggledHidden = (
	hidden: ReadonlyArray<string>,
	key: string,
	keys: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	if (hidden.includes(key)) return hidden.filter((candidate) => candidate !== key)
	const remaining = keys.filter((candidate) => candidate !== key && !hidden.includes(candidate)).length
	return remaining === 0 ? hidden : [...hidden, key]
}

const toggled = (current: Option.Option<string>, key: string): Option.Option<string> =>
	Option.isSome(current) && current.value === key ? Option.none() : Option.some(key)

const update = ChartComposition.makeUpdate({
	CompletedMountChart: (model) => ({ model }),
	FailedMountChart: (model) => ({ model }),
	RenderedPlot: (model, { plot }) => ({ model: modifyFields(model, { plot: () => Option.some(plot) }) }),
	ChangedChartFocus: (model, { maybeKey }) => ({
		model: modifyFields(model, { activeKey: () => maybeKey }),
	}),
	ChangedChartTooltip: (model, { maybeTooltip }) => ({
		model: modifyFields(model, { tooltip: () => maybeTooltip }),
	}),
	CompletedPortalTooltipBody: (model) => ({ model }),
	ResizedChartContainer: (model, { width, height }) => ({
		model: modifyFields(model, { containerWidth: () => width, containerHeight: () => height }),
	}),
	EnteredLegendItem: (model, { key }) => ({
		model: modifyFields(model, { activeKey: () => Option.some(key) }),
	}),
	LeftLegend: (model) => ({ model: modifyFields(model, { activeKey: () => Option.none() }) }),
	ClickedLegendItem: (model, { key }) => ({
		model: modifyFields(model, { highlightedKey: (current) => toggled(current, key) }),
	}),
	ChangedActiveGroup: (model, { maybeGroup }) => ({
		model: modifyFields(model, { activeGroup: () => maybeGroup }),
	}),
	LeftChart: (model) => ({
		model: modifyFields(model, { activeKey: () => Option.none(), activeGroup: () => Option.none() }),
	}),
	ToggledLegendSeries: (model, { key, keys }) => ({
		model: modifyFields(model, { hiddenKeys: (current) => toggledHidden(current, key, keys) }),
	}),
})

const prepare = () =>
	ChartComposition.prepareBlock({
		init,
		update,
		EffectsLayer: Layer.mergeAll(MountChart.layer, PortalTooltipBody.layer, MeasureChartContainer.layer),
	})
export const ChartBlock: Block.FromAssemblyWithoutViewOrOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
