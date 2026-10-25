import { DEFAULT_HEATMAP_COLOR_SCALE, HEATMAP_COLOR_SCALES, type PanelType, STAT_AGGREGATES } from "@maple/domain/http"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { input } from "../../../ui/input"
import { toSeriesFieldOptions } from "./drafts"
import type { EditorState } from "./editor-state"
import { Message } from "./message"
import { ProductEdit } from "./product-edit"
import type { Model } from "./model"
import { checkboxRow, divider, legendField, queryOptions, railSetting, segments, unitField } from "./view-rail"
import { thresholds } from "./view-rail-thresholds"
import { pageSelect } from "./view-select"

// Each non-timeseries panel type's `ConfigPanel` over the `WidgetSettings` fields.

type H = HtmlBuilder<Message>

const titleCase = (value: string): string => `${value.charAt(0).toUpperCase()}${value.slice(1)}`

/** `ScalarReduction`: the aggregate, and the series it reduces (the first while unset or gone). */
const scalarReduction = (h: H, model: Model, state: EditorState): ReadonlyArray<Html> => {
	const fields = toSeriesFieldOptions(state)
	const valueField =
		fields.length > 0 && (state.statValueField === "" || !fields.includes(state.statValueField))
			? (fields[0] ?? "")
			: state.statValueField
	return [
		pageSelect(
			h,
			model,
			"stat-aggregate",
			state.statAggregate,
			STAT_AGGREGATES.map((value) => ({ value, label: value })),
			{
				className: "w-full",
				toView: (parts) => railSetting(h, "stat-aggregate", "Aggregate", true, parts),
			},
		),
		pageSelect(
			h,
			model,
			"stat-value-field",
			valueField,
			fields.map((field) => ({ value: field, label: field })),
			{
				className: "w-full",
				toView: (parts) => railSetting(h, "stat-value-field", "Value field", true, parts),
			},
		),
	]
}

const numberInput = (
	h: H,
	name: string,
	value: string,
	placeholder: string,
	onInput: (value: string) => Message,
	extra: ReadonlyArray<Attribute<Message>> = [],
): Html =>
	input(h, {
		id: `widget-editor-${name}`,
		type: "number",
		attributes: [h.Value(value), h.Placeholder(placeholder), h.OnInput(onInput), ...extra],
	})

/** `GaugeRange`: the arc's sweep. */
const gaugeRange = (h: H, state: EditorState): Html =>
	h.div(
		[h.Class("grid grid-cols-2 gap-2")],
		[
			railSetting(h, "gauge-min", "Min", state.gaugeMin !== "", [
				numberInput(h, "gauge-min", state.gaugeMin, "0", (value) => Message.ChangedGaugeBound({ bound: "min", value })),
			]),
			railSetting(h, "gauge-max", "Max", state.gaugeMax !== "", [
				numberInput(h, "gauge-max", state.gaugeMax, "100", (value) => Message.ChangedGaugeBound({ bound: "max", value })),
			]),
		],
	)

/** `Sparkline`: only in builder mode, since it re-runs the builder's queries. */
const sparkline = (h: H, model: Model, state: EditorState): ReadonlyArray<Html> =>
	model.sourceMode === "builder"
		? [checkboxRow(h, "qb-sparkline", "Show sparkline", state.sparklineEnabled, Message.ToggledSparkline())]
		: []

/** `RowLimit`. */
const rowLimit = (h: H, state: EditorState): Html =>
	railSetting(h, "row-limit", "Row limit", state.tableLimit !== "", [
		numberInput(h, "row-limit", state.tableLimit, "50", (value) => Message.ChangedTableLimit({ value }), [
			h.Min("1"),
			h.Max("1000"),
		]),
	])

/** `RampSwatch`: the palette's five stops. */
const rampSwatch = (h: H, scale: string): Html =>
	h.span(
		[h.Class("flex shrink-0 gap-px")],
		[0, 1, 2, 3, 4].map((stop) =>
			h.span([h.Class("size-2 rounded-xs"), h.Style({ backgroundColor: `var(--heatmap-${scale}-${stop})` })]),
		),
	)

const swatchLabel = (h: H, scale: string): ReadonlyArray<Html | string> => [
	h.span([h.Class("flex items-center gap-2")], [rampSwatch(h, scale), titleCase(scale)]),
]

/** `HeatmapColors`: an unset palette shows the ramp the chart already renders. */
const heatmapColors = (h: H, model: Model, state: EditorState): ReadonlyArray<Html> => [
	pageSelect(
		h,
		model,
		"heatmap-colors",
		state.heatmapColorScale ?? DEFAULT_HEATMAP_COLOR_SCALE,
		HEATMAP_COLOR_SCALES.map((scale) => ({ value: scale, label: titleCase(scale) })),
		{
			className: "w-full",
			renderValue: (value) => swatchLabel(h, value),
			renderItem: (option) => swatchLabel(h, option.value),
			toView: (parts) => railSetting(h, "heatmap-colors", "Color scale", true, parts),
		},
	),
	railSetting(h, "heatmap-scaling", "Color scaling", false, [
		segments(
			h,
			state.heatmapScaleType,
			[
				{ value: "linear", label: "Linear" },
				{ value: "log", label: "Log" },
			],
			(scaleType) => Message.ChangedHeatmapScaleType({ scaleType }),
		),
	]),
]

const product = (edit: ProductEdit): Message => Message.ChangedProduct({ edit })

/** `FunnelVariant`: bars, or the step-by-step drop-off view. */
const funnelVariant = (h: H, state: EditorState): Html =>
	railSetting(h, "funnel-variant", "View", false, [
		segments(
			h,
			state.funnel.variant,
			[
				{ value: "bars", label: "Bars" },
				{ value: "dropoff", label: "Drop-off" },
			],
			(variant) => product(ProductEdit.SetFunnelVariant({ variant })),
		),
	])

/** `FunnelStepPercent`: the chart's tri-state label mode. */
const funnelStepPercent = (h: H, state: EditorState): Html => {
	const value = state.funnel.showStepPercent
	return railSetting(h, "funnel-step-percent", "Step labels", false, [
		segments(
			h,
			value === null ? "auto" : value ? "conversion" : "off",
			[
				{ value: "auto", label: "Auto" },
				{ value: "conversion", label: "Conversion" },
				{ value: "off", label: "Off" },
			],
			(next) => product(ProductEdit.SetFunnelStepPercent({ value: next })),
		),
	])
}

/** The `ConfigPanel` of a panel type other than line, bar and area. */
export const typeSettings = (h: H, model: Model, state: EditorState, panel: PanelType): ReadonlyArray<Html> => {
	switch (panel) {
		case "stat":
			return [
				divider(h),
				unitField(h, model, state, "Unit"),
				...scalarReduction(h, model, state),
				...sparkline(h, model, state),
				thresholds(h, state),
				...queryOptions(h, model, state),
			]
		case "gauge":
			return [
				divider(h),
				unitField(h, model, state, "Unit"),
				...scalarReduction(h, model, state),
				gaugeRange(h, state),
				thresholds(h, state),
				...queryOptions(h, model, state),
			]
		case "table":
			return [rowLimit(h, state), ...queryOptions(h, model, state)]
		case "pie":
			return [divider(h), legendField(h, state, false), ...queryOptions(h, model, state)]
		case "heatmap":
			return [divider(h), ...heatmapColors(h, model, state), ...queryOptions(h, model, state)]
		case "hbar":
		case "histogram":
			return queryOptions(h, model, state)
		case "funnel":
			return [divider(h), funnelVariant(h, state), funnelStepPercent(h, state), ...queryOptions(h, model, state)]
		case "paths":
			return [divider(h), ...queryOptions(h, model, state)]
		default:
			return []
	}
}
