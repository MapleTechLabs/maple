import { Option, Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { ChartTooltip } from "./chart-spec"

/**
 * One chart's interaction state beside the chart: the hovered
 * datum (from the plot's focus or a legend row), the legend's pinned emphasis, the tooltip datum
 * and the measured container width. The library owns the canvas; this owns what the view reads.
 */

// MODEL

/** The plot rect and the x scale's domain-to-pixel mapping of the last render (`usePlotRect`, `usePlotScales`). */
export const PlotGeometry = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number,
	width: Schema.Number,
	height: Schema.Number,
	domainStartMs: Schema.Number,
	domainEndMs: Schema.Number,
	rangeStart: Schema.Number,
	rangeEnd: Schema.Number,
})
export type PlotGeometry = typeof PlotGeometry.Type

export const Model = Schema.Struct({
	/** Set once the chart rendered a time x scale; overlays (deploy markers) position against it. */
	plot: Schema.Option(PlotGeometry),
	/** `activeName`: the focused datum's key, shared by plot focus and legend hover. */
	activeKey: Schema.Option(Schema.String),
	/** `usePlotLegendHighlight`: a legend click pins one key until clicked again. */
	highlightedKey: Schema.Option(Schema.String),
	/** What the tooltip shell's body shows; `None` while the library hides it. */
	tooltip: Schema.Option(ChartTooltip),
	/** `useContainerSize(containerRef).width`, rounded; 0 before the first measurement. */
	containerWidth: Schema.Number,
	/** `useContainerSize(containerRef).height`: a side legend's height cap; 0 before measured. */
	containerHeight: Schema.Number,
	/** `useSeriesVisibility`: series keys a time-series legend has hidden. */
	hiddenKeys: Schema.Array(Schema.String),
	/** A grouped DOM chart's hovered group (a funnel breakdown), beside the hovered row. */
	activeGroup: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	plot: Option.none(),
	activeKey: Option.none(),
	highlightedKey: Option.none(),
	tooltip: Option.none(),
	containerWidth: 0,
	containerHeight: 0,
	hiddenKeys: [],
	activeGroup: Option.none(),
})

// MESSAGE

export const Message = defineMessageUnion({
	CompletedMountChart: {},
	FailedMountChart: { reason: Schema.String },
	RenderedPlot: { plot: PlotGeometry },
	ChangedChartFocus: { maybeKey: Schema.Option(Schema.String) },
	ChangedChartTooltip: { maybeTooltip: Schema.Option(ChartTooltip) },
	CompletedPortalTooltipBody: {},
	ResizedChartContainer: { width: Schema.Number, height: Schema.Number },
	EnteredLegendItem: { key: Schema.String },
	LeftLegend: {},
	ClickedLegendItem: { key: Schema.String },
	/** A hiding legend's row: `keys` are every series, so the last visible one cannot be hidden. */
	ToggledLegendSeries: { key: Schema.String, keys: Schema.Array(Schema.String) },
	ChangedActiveGroup: { maybeGroup: Schema.Option(Schema.String) },
	/** The pointer left a DOM chart: no row and no group is hovered. */
	LeftChart: {},
})
export type Message = typeof Message.Type

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

export const update = (model: Model, message: Message) =>
	Message.match<Update.Return<Model, Message>>(message, {
		CompletedMountChart: () => ({ model }),
		FailedMountChart: () => ({ model }),
		RenderedPlot: ({ plot }) => ({ model: modifyFields(model, { plot: () => Option.some(plot) }) }),
		ChangedChartFocus: ({ maybeKey }) => ({ model: modifyFields(model, { activeKey: () => maybeKey }) }),
		ChangedChartTooltip: ({ maybeTooltip }) => ({
			model: modifyFields(model, { tooltip: () => maybeTooltip }),
		}),
		CompletedPortalTooltipBody: () => ({ model }),
		ResizedChartContainer: ({ width, height }) => ({
			model: modifyFields(model, { containerWidth: () => width, containerHeight: () => height }),
		}),
		EnteredLegendItem: ({ key }) => ({
			model: modifyFields(model, { activeKey: () => Option.some(key) }),
		}),
		LeftLegend: () => ({ model: modifyFields(model, { activeKey: () => Option.none() }) }),
		ClickedLegendItem: ({ key }) => ({
			model: modifyFields(model, { highlightedKey: (current) => toggled(current, key) }),
		}),
		ChangedActiveGroup: ({ maybeGroup }) => ({
			model: modifyFields(model, { activeGroup: () => maybeGroup }),
		}),
		LeftChart: () => ({
			model: modifyFields(model, { activeKey: () => Option.none(), activeGroup: () => Option.none() }),
		}),
		ToggledLegendSeries: ({ key, keys }) => ({
			model: modifyFields(model, { hiddenKeys: (current) => toggledHidden(current, key, keys) }),
		}),
	})
