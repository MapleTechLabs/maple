import type { DashboardDocument } from "@maple/domain/http"
import { makeQueryDataSource } from "@maple/widgets/dashboard"
import type { WidgetDataState as TileState } from "../../page/dashboards/kit/data-state"
import {
	chartScenarios,
	funnelDropoffScenarios,
	funnelScenarios,
	gaugeScenarios,
	hbarScenarios,
	heatmapScenarios,
	histogramScenarios,
	listScenarios,
	markdownScenarios,
	pathsScenarios,
	pieScenarios,
	sparklineSamples,
	statScenarios,
	statSparklineScenarios,
	stressScenarios,
	tableScenarios,
	type WidgetDataState,
	type WidgetScenario,
} from "./scenarios"

// The widget lab's sections, each cell a widget built
// from its scenario: the lab renders the dashboard tiles outside a dashboard.

type Widget = DashboardDocument["widgets"][number]
type Visualization = Widget["visualization"]

export type Cell = Readonly<{
	id: string
	label: string
	height: number
	widget: Widget
	state: TileState
	/** The stat's trend series, supplied instead of fetched (`SparklineSeriesScope`). */
	sparkline: TileState | null
	rowLimit?: number | undefined
}>

export type Section = Readonly<{
	id: string
	title: string
	description: string
	minColWidth: number
	cells: ReadonlyArray<Cell>
}>

const LAB_SOURCE = makeQueryDataSource({ resultShape: "timeseries", queries: [] })

/** A `WidgetDataState` as the tiles read it. */
export const toTileState = (state: WidgetDataState): TileState => {
	switch (state.status) {
		case "loading":
			return { _tag: "Loading" }
		case "error":
			return { _tag: "Error", title: state.title ?? null, message: state.message ?? null, kind: state.kind ?? null }
		case "ready":
			return {
				_tag: "Ready",
				data: Array.isArray(state.data)
					? { _tag: "Rows", rows: state.data.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null) }
					: { _tag: "Value", value: state.data },
			}
	}
}

const widgetOf = (
	id: string,
	visualization: Visualization,
	display: WidgetScenario["display"],
	rowLimit?: number,
): Widget => ({
	id,
	visualization,
	dataSource:
		rowLimit === undefined
			? LAB_SOURCE
			: makeQueryDataSource({ resultShape: "timeseries", queries: [], transform: { limit: rowLimit } }),
	display,
	layout: { x: 0, y: 0, w: 4, h: 4 },
})

const cellsOf = <S extends WidgetScenario>(
	prefix: string,
	visualization: Visualization,
	scenarios: ReadonlyArray<S>,
	height: number,
	label: (scenario: S) => string = (scenario) => scenario.label,
): ReadonlyArray<Cell> =>
	scenarios.map((scenario, index) => ({
		id: `${prefix}-${index}`,
		label: label(scenario),
		height,
		widget: widgetOf(`${prefix}-${index}`, visualization, scenario.display, scenario.rowLimit),
		state: toTileState(scenario.dataState),
		sparkline: null,
		rowLimit: scenario.rowLimit,
	}))

const statSparklineCells: ReadonlyArray<Cell> = statSparklineScenarios.map((scenario, index) => ({
	id: `stat-spark-${index}`,
	label: scenario.label,
	height: 220,
	widget: widgetOf(`stat-spark-${index}`, "stat", {
		...scenario.display,
		sparkline: { enabled: true, dataSource: LAB_SOURCE },
	}),
	state: toTileState({ status: "ready", data: scenario.value }),
	sparkline: toTileState({ status: "ready", data: scenario.sparklineData }),
}))

/** The standalone trend lines: a card with just the sparkline in it. */
export const SPARKLINE_SAMPLES = sparklineSamples.map((sample, index) => ({
	id: `spark-${index}`,
	label: sample.label,
	color: sample.color,
	state: toTileState({ status: "ready", data: sample.data }),
}))

export const SECTIONS: ReadonlyArray<Section> = [
	{
		id: "stat",
		title: "Stat",
		description: "Single aggregated value. Polish: threshold colors, prefix/suffix, long titles, edge values.",
		minColWidth: 240,
		cells: [...cellsOf("stat", "stat", statScenarios, 200), ...statSparklineCells],
	},
	{
		id: "gauge",
		title: "Gauge",
		description:
			"Single scalar on a radial arc. Polish: threshold arc coloring, tick marks, min/max range, edge values.",
		minColWidth: 320,
		cells: cellsOf("gauge", "gauge", gaugeScenarios, 320),
	},
]

/** Every section after the sparkline samples, in page order. */
export const LATER_SECTIONS: ReadonlyArray<Section> = [
	{
		id: "chart",
		title: "Chart",
		description:
			"Every entry from the chart registry rendered with its bundled sample data, plus threshold overlays, the stats legend, and loading/error/empty states.",
		minColWidth: 320,
		cells: cellsOf("chart", "chart", chartScenarios, 320, (s) => `${s.label} (${s.category})`,
		),
	},
	{
		id: "stress",
		title: "Stress / edge cases",
		description:
			"High-cardinality (10–50 series/slices), long series names, and null/zero data. Confirms distinct colors past series 5, scrollable legends that don't crush the plot, and pie/bar 'Other' bucketing.",
		minColWidth: 320,
		cells: cellsOf("stress", "chart", stressScenarios, 320, (s) => `${s.label} (${s.category})`,
		),
	},
	{
		id: "table",
		title: "Table",
		description: "Tabular data with configurable columns, units, alignment, and cell thresholds.",
		minColWidth: 320,
		cells: cellsOf("table", "table", tableScenarios, 320),
	},
	{
		id: "list",
		title: "List",
		description: "Traces and logs lists with linked traceId/spanName columns.",
		minColWidth: 320,
		cells: cellsOf("list", "list", listScenarios, 320),
	},
	{
		id: "pie",
		title: "Pie",
		description: "Categorical breakdown. Polish: legend placement, label overflow, donut + percent.",
		minColWidth: 320,
		cells: cellsOf("pie", "pie", pieScenarios, 320),
	},
	{
		id: "funnel",
		title: "Funnel",
		description:
			"Stage-by-stage drop-off as descending bars. Polish: % of first vs step conversion, long stage labels, single-stage and empty states.",
		minColWidth: 320,
		cells: cellsOf("funnel", "funnel", funnelScenarios, 320),
	},
	{
		id: "funnel-dropoff",
		title: "Funnel · Drop-off",
		description:
			"One column per step: the solid bar is who reached it, the hatched cap who left since the previous step. Connectors carry conversion and median time; hover a step for where its leavers went.",
		minColWidth: 320,
		cells: cellsOf("funnel-dropoff", "funnel", funnelDropoffScenarios, 320),
	},
	{
		id: "paths",
		title: "Paths",
		description:
			"What people do in the steps after (or before) one anchor. Top branches per step named, the rest folded into Other, sequence ends as neutral terminals. Hover a node to lift its flows.",
		minColWidth: 320,
		cells: cellsOf("paths", "paths", pathsScenarios, 320),
	},
	{
		id: "hbar",
		title: "Horizontal Bar",
		description:
			"Ranked categories, each a share of the total. Polish: long labels, value column alignment, overflow cap, near-identical top rows (the case a funnel mislabels as 100%).",
		minColWidth: 320,
		cells: cellsOf("hbar", "hbar", hbarScenarios, 320),
	},
	{
		id: "histogram",
		title: "Histogram",
		description: "Bucketed value distribution. Polish: log Y scale, narrow buckets, bell vs long-tail shapes.",
		minColWidth: 320,
		cells: cellsOf("histogram", "histogram", histogramScenarios, 320),
	},
	{
		id: "heatmap",
		title: "Heatmap",
		description: "2D density. Polish: all OKLCH color scales, dense vs sparse data, linear vs log.",
		minColWidth: 320,
		cells: cellsOf("heatmap", "heatmap", heatmapScenarios, 320),
	},
	{
		id: "markdown",
		title: "Markdown",
		description: "Static notes. Polish: heading/list rendering, inline code, sanitized links.",
		minColWidth: 320,
		cells: cellsOf("markdown", "markdown", markdownScenarios, 320),
	},
]

export const ALL_CELLS: ReadonlyArray<Cell> = [...SECTIONS, ...LATER_SECTIONS].flatMap((section) => section.cells)
