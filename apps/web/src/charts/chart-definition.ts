import { Schema } from "effect"
import { Block } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
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

/** The chart Block's contracts; `chart-mounts` and `chart` author against it. */
export const ChartDefinition = Block.makeDefinition("Chart", { Model, Message })
