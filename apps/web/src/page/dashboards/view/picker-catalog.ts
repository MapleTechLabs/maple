import { WIDGET_TYPES } from "@maple/domain/http"
import {
	funnelPresets,
	hbarPresets,
	heatmapPresets,
	histogramPresets,
	listPresets,
	markdownPresets,
	pathsPresets,
	piePresets,
	statPresets,
	tablePresets,
	type WidgetPresetDefinition,
} from "@maple/web-data/dashboards/widget-presets"

// The widget picker's catalog: the three chart styles,
// then one section per widget type that ships presets, in Type-picker order.

export type PreviewKind = "chart" | "stat" | "rows" | "markdown"

export type PickerSection = Readonly<{
	id: string
	label: string
	presets: ReadonlyArray<WidgetPresetDefinition>
	preview: PreviewKind
	/** The chart a `chart` preview draws when the preset names none. */
	defaultChartId: string
}>

/** "Pie" is "Pies", "Note" is "Notes"; a label already plural ("Paths") stays. */
const plural = (label: string) => (label.endsWith("s") ? label : `${label}s`)

const section = (
	panel: keyof typeof WIDGET_TYPES,
	presets: ReadonlyArray<WidgetPresetDefinition>,
	preview: PreviewKind,
): PickerSection => ({
	id: panel,
	label: plural(WIDGET_TYPES[panel].label),
	presets,
	preview,
	defaultChartId: `query-builder-${panel}`,
})

export const PICKER_SECTIONS: ReadonlyArray<PickerSection> = [
	section("hbar", hbarPresets, "chart"),
	section("pie", piePresets, "chart"),
	section("stat", statPresets, "stat"),
	section("table", tablePresets, "rows"),
	section("list", listPresets, "rows"),
	section("histogram", histogramPresets, "chart"),
	section("heatmap", heatmapPresets, "chart"),
	section("funnel", funnelPresets, "chart"),
	section("paths", pathsPresets, "chart"),
	section("markdown", markdownPresets, "markdown"),
]

export const CHART_STYLES = [
	{ chartId: "query-builder-bar", label: "Bar chart", description: "Compare values across categories" },
	{ chartId: "query-builder-area", label: "Area chart", description: "Visualize trends over time" },
	{ chartId: "query-builder-line", label: "Line chart", description: "Track metrics over time" },
] as const

export const PICKER_TABS: ReadonlyArray<Readonly<{ id: string; label: string }>> = [
	{ id: "all", label: "All" },
	{ id: "charts", label: "Charts" },
	...PICKER_SECTIONS.map(({ id, label }) => ({ id, label })),
]

export const presetById = (presetId: string): WidgetPresetDefinition | undefined =>
	PICKER_SECTIONS.flatMap((entry) => entry.presets).find((preset) => preset.id === presetId)
