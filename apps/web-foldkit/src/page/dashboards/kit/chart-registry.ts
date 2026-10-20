import { type PanelType, WIDGET_TYPES, type WidgetVisualization } from "@maple/domain/http"
import {
	apdexTimeSeriesData,
	errorRateTimeSeriesData,
	funnelSampleData,
	hbarSampleData,
	heatmapSampleData,
	histogramSampleData,
	latencyTimeSeriesData,
	pathsSampleData,
	pieSampleData,
	throughputTimeSeriesData,
} from "@maple/ui/components/charts/_shared/sample-data"

// The id-to-category half of `chartRegistry` (packages/ui/src/components/charts/registry.ts), which
// also lazily imports every React chart. Also `toPanelType`.

export type ChartCategory =
	| "bar"
	| "hbar"
	| "area"
	| "line"
	| "pie"
	| "histogram"
	| "heatmap"
	| "funnel"
	| "paths"

const CATEGORY_BY_ID = new Map<string, ChartCategory>([
	["query-builder-bar", "bar"],
	["query-builder-hbar", "hbar"],
	["query-builder-area", "area"],
	["query-builder-line", "line"],
	["latency-line", "line"],
	["throughput-area", "area"],
	["apdex-area", "area"],
	["error-rate-area", "area"],
	["query-builder-pie", "pie"],
	["query-builder-histogram", "histogram"],
	["query-builder-heatmap", "heatmap"],
	["query-builder-funnel", "funnel"],
	["query-builder-paths", "paths"],
])

/** `chartRegistry`'s entries without their components: id, name, category and bundled sample rows. */
export const CHART_GALLERY: ReadonlyArray<
	Readonly<{
		id: string
		name: string
		category: ChartCategory
		sampleData: ReadonlyArray<Record<string, unknown>>
	}>
> = [
	{ id: "query-builder-bar", name: "Bar", category: "bar", sampleData: latencyTimeSeriesData },
	{ id: "query-builder-hbar", name: "Horizontal Bar", category: "hbar", sampleData: hbarSampleData },
	{ id: "query-builder-area", name: "Area", category: "area", sampleData: latencyTimeSeriesData },
	{ id: "query-builder-line", name: "Line", category: "line", sampleData: latencyTimeSeriesData },
	{ id: "latency-line", name: "Latency Line", category: "line", sampleData: latencyTimeSeriesData },
	{
		id: "throughput-area",
		name: "Throughput Area",
		category: "area",
		sampleData: throughputTimeSeriesData,
	},
	{ id: "apdex-area", name: "Apdex Area", category: "area", sampleData: apdexTimeSeriesData },
	{ id: "error-rate-area", name: "Error Rate Area", category: "area", sampleData: errorRateTimeSeriesData },
	{ id: "query-builder-pie", name: "Pie", category: "pie", sampleData: pieSampleData },
	{
		id: "query-builder-histogram",
		name: "Histogram",
		category: "histogram",
		sampleData: histogramSampleData,
	},
	{ id: "query-builder-heatmap", name: "Heatmap", category: "heatmap", sampleData: heatmapSampleData },
	{ id: "query-builder-funnel", name: "Funnel", category: "funnel", sampleData: funnelSampleData },
	{ id: "query-builder-paths", name: "Paths", category: "paths", sampleData: pathsSampleData },
]

/** `getChartById(id)?.sampleData`. */
export const sampleDataOf = (chartId: string): ReadonlyArray<Record<string, unknown>> =>
	CHART_GALLERY.find((entry) => entry.id === chartId)?.sampleData ?? []

/** `REMOVED_CHART_IDS`: retired styles redirect to the chart that replaced them. */
const REMOVED_CHART_IDS = new Map([
	["default-bar", "query-builder-bar"],
	["gradient-area", "query-builder-area"],
	["dotted-line", "query-builder-line"],
])

export const chartCategoryOf = (id: string): ChartCategory | undefined =>
	CATEGORY_BY_ID.get(REMOVED_CHART_IDS.get(id) ?? id)

const PANEL_TYPES = new Set<string>([
	"line",
	"bar",
	"hbar",
	"area",
	"stat",
	"gauge",
	"table",
	"list",
	"pie",
	"histogram",
	"heatmap",
	"funnel",
	"paths",
	"markdown",
])

const isPanelType = (value: string): value is PanelType => PANEL_TYPES.has(value)

/** `toPanelType`: a `chart` widget reads its chart's category. */
export const toPanelType = (visualization: string, chartId?: string): PanelType => {
	if (visualization === "chart") {
		const category = chartCategoryOf(chartId ?? "query-builder-line")
		return category !== undefined && isPanelType(category) ? category : "line"
	}
	return isPanelType(visualization) ? visualization : "line"
}

/**
 * `fromPanelType`: the persisted pair for a panel type. A chart id already of that panel's
 * category is kept, so re-picking the current type never rewrites a non-canonical style.
 */
export const fromPanelType = (
	panel: PanelType,
	currentChartId?: string,
): { visualization: WidgetVisualization; chartId: string | undefined } => {
	const meta = WIDGET_TYPES[panel]
	return currentChartId !== undefined && currentChartId !== "" && chartCategoryOf(currentChartId) === panel
		? { visualization: meta.visualization, chartId: currentChartId }
		: { visualization: meta.visualization, chartId: meta.chartId }
}

/** `maxDataPointsForWidth`: one point per pixel, or per 6 px bar. */
export const maxDataPointsForWidth = (widthPx: number, panelType: PanelType): number =>
	Math.max(1, Math.floor(panelType === "bar" ? widthPx / 6 : widthPx))

/** `DEFAULT_WIDGET_WIDTH_PX`: the width assumed before a tile is measured. */
export const DEFAULT_WIDGET_WIDTH_PX = 800
