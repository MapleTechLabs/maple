import { PANEL_TYPES, WIDGET_UNITS } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import { fieldLabelStyles, fieldStyles } from "@maple/ui/styles/ui/field"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Checkbox from "../../../ui/checkbox"
import { separator } from "../../../ui/display"
import { field, fieldLabel, type FieldState, input } from "../../../ui/field"
import { segmentedSelect } from "../../../ui/segmented-select"
import { textarea } from "../../../ui/textarea"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { toPanelType } from "../kit/chart-registry"
import { widgetTimeRangeLabel } from "../kit/time-range-label"
import type { EditorState } from "./editor-state"
import { Message } from "./message"
import type { Model } from "./model"
import { thresholds } from "./view-rail-thresholds"
import { pageSelect } from "./view-select"
import { typeSettings } from "./view-rail-types"

// `WidgetSettingsBar` and the `WidgetSettings` fields the timeseries panels compose.

type H = HtmlBuilder<Message>

/** The eyebrow caption, restated at `sm:` because FieldLabel sets its own size there. */
const RAIL_LABEL_CLASS = cn(eyebrowVariants({ variant: "label" }), "sm:text-2xs sm:leading-normal")

const stateOf = (isFilled: boolean): FieldState => ({
	isDirty: false,
	isFilled,
	isFocused: false,
	isTouched: false,
	isInvalid: false,
})

const idsOf = (name: string) => ({
	control: `widget-editor-${name}`,
	label: `widget-editor-${name}-label`,
	error: `widget-editor-${name}-error`,
})

/** `RailSetting`: an eyebrow caption over its control. */
export const railSetting = (
	h: H,
	name: string,
	label: string,
	isFilled: boolean,
	children: ReadonlyArray<Html>,
): Html =>
	field(h, { className: "items-stretch gap-1.5", state: stateOf(isFilled) }, [
		fieldLabel(h, { ids: idsOf(name), className: RAIL_LABEL_CLASS, state: stateOf(isFilled) }, label),
		...children,
	])

export const divider = (h: H): Html => separator(h, "horizontal", undefined)

/** `Segments`: the rail's full-width segmented control. */
export const segments = <T extends string>(
	h: H,
	value: T,
	options: ReadonlyArray<{ value: T; label: string }>,
	onChange: (value: T) => Message,
): Html =>
	segmentedSelect(h, { options, value, onChange, size: "sm", className: "w-full *:flex-1 *:text-xs" })

/** `CheckboxRow`. */
export const checkboxRow = (
	h: H,
	id: string,
	label: string,
	isChecked: boolean,
	onToggle: Message,
	isDisabled = false,
): Html =>
	h.div(
		[
			h.Class(cn(fieldStyles, "flex-row items-center gap-2")),
			h.DataAttribute("slot", "field"),
			...(isChecked ? [h.DataAttribute("filled", "")] : []),
		],
		[
			...Checkbox.view(h, {
				model: { isChecked },
				toParentMessage: () => onToggle,
				id: `${id}-root`,
				inputId: id,
				isDisabled,
				className: "shrink-0",
			}),
			h.label(
				[
					h.Id(Checkbox.labelId(id)),
					h.For(id),
					h.Class(cn(fieldLabelStyles, "font-normal text-xs text-muted-foreground sm:text-xs")),
					h.DataAttribute("slot", "field-label"),
					...(isChecked ? [h.DataAttribute("filled", "")] : []),
				],
				[label],
			),
		],
	)

const nameField = (h: H, state: EditorState): Html =>
	railSetting(h, "name", "Name", state.title !== "", [
		input(h, {
			ids: idsOf("name"),
			state: stateOf(state.title !== ""),
			attributes: [
				h.Value(state.title),
				h.Placeholder("Untitled widget"),
				h.OnInput((value) => Message.ChangedTitle({ value })),
			],
		}),
	])

const descriptionField = (h: H, state: EditorState): Html =>
	railSetting(h, "description", "Description", state.description !== "", [
		textarea(h, {
			id: idsOf("description").control,
			defaultValue: state.description,
			attributes: [
				h.AriaLabelledBy(idsOf("description").label),
				h.Placeholder("Add a description…"),
				h.Rows(2),
				h.OnInput((value) => Message.ChangedDescription({ value })),
			],
		}),
	])

/**
 * `WidgetTimeRange`: Dashboard or Custom, and under Custom the override's own picker.
 * TODO(picker): the picker's custom-range tab (an absolute window) is not built yet.
 */
const timeRangeField = (h: H, model: Model, state: EditorState, timeZone: string): Html =>
	railSetting(h, "time-range", "Time range", false, [
		h.div(
			[h.Class("space-y-1.5")],
			[
				segments(
					h,
					state.timeRange === null ? "dashboard" : "custom",
					[
						{ value: "dashboard", label: "Dashboard" },
						{ value: "custom", label: "Custom" },
					],
					(mode) => Message.ChangedTimeRangeMode({ mode }),
				),
				...(state.timeRange === null
					? []
					: [
							h.submodel({
								slotId: "widget-editor-range-picker",
								model: model.rangePicker,
								view: TimeRangePicker.view,
								viewInputs: {
									label: widgetTimeRangeLabel(state.timeRange, timeZone, model.nowMs ?? 0),
									selectedPreset:
										state.timeRange.type === "relative"
											? state.timeRange.value
											: undefined,
									presets: TimeRangePicker.PRESET_VALUES,
									timeZone,
									hasHotkey: false,
								},
								toParentMessage: (message) => Message.GotRangePickerMessage({ message }),
							}),
						]),
			],
		),
	])

const typePicker = (h: H, state: EditorState): Html =>
	railSetting(h, "type", "Type", false, [
		segmentedSelect(h, {
			options: PANEL_TYPES.map((meta) => ({ value: meta.panelType, label: meta.label })),
			value: toPanelType(state.visualization, state.chartId),
			onChange: (panel) => Message.ClickedPanelType({ panel }),
			size: "sm",
			ariaLabel: "Panel type",
			className: "grid w-full grid-cols-3 *:text-xs",
		}),
	])

const UNIT_OPTIONS = [
	...WIDGET_UNITS.filter((unit) => !unit.token.startsWith("duration_")).map((unit) => ({
		value: unit.token,
		label: unit.label,
	})),
	{ value: "duration", label: "Duration" },
]

const DURATION_SCALES = [
	{ value: "duration_ns", label: "ns" },
	{ value: "duration_us", label: "us" },
	{ value: "duration_ms", label: "ms" },
	{ value: "duration_s", label: "s" },
]

/** `Unit`: the duration tokens collapse into one entry with a scale under it. */
export const unitField = (h: H, model: Model, state: EditorState, label = "Y-Axis Unit"): Html => {
	const isDuration = state.unit.startsWith("duration_")
	return pageSelect(h, model, "unit", isDuration ? "duration" : state.unit, UNIT_OPTIONS, {
		className: "w-full",
		ariaLabel: label,
		toView: (parts) =>
			railSetting(h, "unit", label, true, [
				...parts,
				...(isDuration
					? [segments(h, state.unit, DURATION_SCALES, (unit) => Message.ChangedUnit({ unit }))]
					: []),
			]),
	})
}

/** `Legend`, with the Min/Max/Mean/Last table under it. */
export const legendField = (h: H, state: EditorState, hasSeriesStats = true): Html =>
	railSetting(h, "legend", "Legend", false, [
		segments(
			h,
			state.legendPosition,
			[
				{ value: "bottom", label: "Bottom" },
				{ value: "right", label: "Right" },
				{ value: "hidden", label: "Hidden" },
			],
			(legendPosition) => Message.ChangedLegend({ legendPosition }),
		),
		...(hasSeriesStats ? [seriesStats(h, state)] : []),
	])

const seriesStats = (h: H, state: EditorState): Html =>
	h.div(
		[h.Class("pt-0.5")],
		[
			checkboxRow(
				h,
				"qb-series-stats",
				"Show Min/Max/Mean/Last stats",
				state.seriesStatsEnabled,
				Message.ToggledSeriesStats(),
			),
		],
	)

/** `QueryOptions`: comparison and its % change. */
export const queryOptions = (h: H, model: Model, state: EditorState): ReadonlyArray<Html> => [
	divider(h),
	pageSelect(
		h,
		model,
		"comparison",
		state.comparisonMode,
		[
			{ value: "none", label: "None" },
			{ value: "previous_period", label: "Previous period" },
		],
		{
			className: "w-full",
			ariaLabel: "Comparison",
			toView: (parts) => railSetting(h, "comparison", "Comparison", true, parts),
		},
	),
	divider(h),
	h.div(
		[h.Class("flex flex-col gap-3")],
		[
			checkboxRow(
				h,
				"qb-percent-change",
				"% change",
				state.includePercentChange,
				Message.ToggledPercentChange(),
				state.comparisonMode === "none",
			),
		],
	),
]

/** `TimeSeriesSettings`: stacking on bar and area, curve and points on line and area. */
const timeseriesSettings = (h: H, model: Model, state: EditorState): ReadonlyArray<Html> => {
	const panel = toPanelType(state.visualization, state.chartId)
	const isStackable = panel === "bar" || panel === "area"
	const isCurved = panel === "line" || panel === "area"
	return [
		...(isStackable
			? [
					railSetting(h, "layout", "Layout", false, [
						segments(
							h,
							state.stacked ? "stacked" : "separate",
							[
								{ value: "separate", label: panel === "bar" ? "Grouped" : "Overlapping" },
								{ value: "stacked", label: "Stacked" },
							],
							(value) => Message.ChangedStacked({ isStacked: value === "stacked" }),
						),
					]),
				]
			: []),
		...(isCurved
			? [
					railSetting(h, "curve", "Curve", false, [
						segments(
							h,
							state.curveType,
							[
								{ value: "linear", label: "Linear" },
								{ value: "monotone", label: "Smooth" },
							],
							(curveType) => Message.ChangedCurve({ curveType }),
						),
					]),
					railSetting(h, "points", "Points", false, [
						segments(
							h,
							state.pointsMode,
							[
								{ value: "auto", label: "Auto" },
								{ value: "always", label: "Always" },
								{ value: "never", label: "Never" },
							],
							(pointsMode) => Message.ChangedPoints({ pointsMode }),
						),
					]),
				]
			: []),
		divider(h),
		unitField(h, model, state),
		legendField(h, state),
		thresholds(h, state),
		...queryOptions(h, model, state),
	]
}

/** The "Panel options" rail: the shared fields, then the panel type's own (`ConfigPanel`). */
export const settingsRail = (h: H, model: Model, timeZone: string): Html => {
	const state = model.state
	if (state === null) return h.empty
	const panel = toPanelType(state.visualization, state.chartId)
	return h.div(
		[h.Class("flex flex-col gap-5")],
		[
			h.p(
				[h.Class(eyebrowVariants({ variant: "label" })), h.DataAttribute("slot", "eyebrow")],
				["Panel options"],
			),
			nameField(h, state),
			descriptionField(h, state),
			// A note never queries, so it has no window of its own.
			...(panel === "markdown" ? [] : [timeRangeField(h, model, state, timeZone)]),
			divider(h),
			typePicker(h, state),
			...(panel === "line" || panel === "bar" || panel === "area"
				? timeseriesSettings(h, model, state)
				: typeSettings(h, model, state, panel)),
		],
	)
}
