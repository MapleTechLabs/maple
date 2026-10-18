import type { PanelType } from "@maple/domain/http"

// The id-to-category half of `chartRegistry` (packages/ui/src/components/charts/registry.ts), which
// also lazily imports every React chart. `toPanelType` (apps/web/src/lib/query-builder/panel-types.ts).

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

/** `REMOVED_CHART_IDS`: retired styles redirect to the chart that replaced them. */
const REMOVED_CHART_IDS = new Map([
	["default-bar", "query-builder-bar"],
	["gradient-area", "query-builder-area"],
	["dotted-line", "query-builder-line"],
])

/** The chart id a stored `chartId` resolves to, or `undefined` for an unknown one. */
export const resolveChartId = (id: string): string | undefined => {
	const resolved = REMOVED_CHART_IDS.get(id) ?? id
	return CATEGORY_BY_ID.has(resolved) ? resolved : undefined
}

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

/** `maxDataPointsForWidth`: one point per pixel, or per 6 px bar. */
export const maxDataPointsForWidth = (widthPx: number, panelType: PanelType): number =>
	Math.max(1, Math.floor(panelType === "bar" ? widthPx / 6 : widthPx))

/** `DEFAULT_WIDGET_WIDTH_PX`: the width assumed before a tile is measured. */
export const DEFAULT_WIDGET_WIDTH_PX = 800
