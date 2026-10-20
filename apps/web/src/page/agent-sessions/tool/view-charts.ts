import { formatWarehouseDateTime } from "@maple/query-engine"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { errorRate } from "@maple/web-data/lib/tool-analytics"
import { Option, Record } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import type { ThemeColors } from "../../../charts/theme-colors"
import { chartEmpty } from "../../../ui/chart-state"
import { panelHeader } from "../../../ui/panel"
import { seriesLegend } from "../../kit/series-legend"
import type { ToolSeriesPoint } from "../tools-kit/model"
import { type ToolPlotInputs, toolPlotView } from "../tools-kit/series-chart"
import { Message } from "./message"

// The tool detail charts: four readings of one tool.

type H = HtmlBuilder<Message>

const PLOT_HEIGHT = 160
const CHART_EMPTY_MESSAGE = "No data for this metric in the selected window."

type CellSpec = Readonly<{
	id: string
	title: string
	series: ToolPlotInputs["series"]
	format: ToolPlotInputs["format"]
}>

const CELLS: ReadonlyArray<CellSpec> = [
	{
		id: "calls",
		title: "Tool calls",
		series: [{ key: "calls", label: "Calls", token: "--primary" }],
		format: "number",
	},
	{
		id: "error-rate",
		title: "Error rate",
		series: [{ key: "errorRate", label: "Error rate", token: "--color-severity-error" }],
		format: "errorRate",
	},
	{
		id: "duration",
		title: "Duration",
		series: [
			{ key: "p50", label: "P50", token: "--muted-foreground" },
			{ key: "p90", label: "P90", token: "--primary" },
			{ key: "p95", label: "P95", token: "--color-severity-error" },
		],
		format: "durationNs",
	},
	{
		id: "calls-per-session",
		title: "Calls per session",
		series: [{ key: "callsPerSession", label: "Calls per session", token: "--chart-2" }],
		format: "oneDecimal",
	},
]

/** The tokens the grid reads off the theme. */
export const GRID_TOKENS = [
	"--primary",
	"--color-severity-error",
	"--muted-foreground",
	"--chart-2",
	"--border",
	"--background",
]

const rowsOf = (series: ReadonlyArray<ToolSeriesPoint>) =>
	series
		.toSorted((a, b) => a.bucket - b.bucket)
		.map((bucket) => ({
			bucket: formatWarehouseDateTime(bucket.bucket),
			calls: bucket.calls,
			errorRate: errorRate(bucket),
			p50: bucket.p50,
			p90: bucket.p90,
			p95: bucket.p95,
			callsPerSession: bucket.sessions > 0 ? bucket.calls / bucket.sessions : 0,
		}))

const cell = (
	h: H,
	spec: CellSpec,
	rows: ReturnType<typeof rowsOf>,
	charts: Readonly<Record<string, Chart.Model>>,
	theme: ThemeColors,
	timeZone: string,
): Html => {
	const chartId = `agent-tool-${spec.id}`
	return h.section(
		[
			h.Class(
				cn(
					"flex min-w-0 flex-col",
					"gap-3.5 border-b border-border px-6 pt-[22px] pb-5 @min-[900px]/page:[&:nth-child(odd)]:border-r",
				),
			),
		],
		[
			panelHeader(h, {
				title: spec.title,
				action:
					spec.series.length > 1
						? seriesLegend(h, {
								items: spec.series.map((entry) => ({
									key: entry.key,
									label: entry.label,
									color: `var(${entry.token})`,
								})),
								swatch: "square",
							})
						: undefined,
				divided: false,
				className: cn("px-3 pt-2.5", "px-0 pt-0"),
			}),
			rows.length === 0
				? chartEmpty(h, { height: PLOT_HEIGHT }, [CHART_EMPTY_MESSAGE])
				: h.submodel({
						slotId: chartId,
						model: Option.getOrElse(Record.get(charts, chartId), () => Chart.init()),
						view: toolPlotView,
						toParentMessage: (message) => Message.GotChartMessage({ chartId, message }),
						viewInputs: {
							chartId,
							ariaLabel: spec.title,
							height: PLOT_HEIGHT,
							rows,
							series: spec.series,
							format: spec.format,
							tickCount: 3,
							marginTop: 6,
							theme,
							timeZone,
						},
					}),
		],
	)
}

export const detailCharts = (
	h: H,
	options: Readonly<{
		series: ReadonlyArray<ToolSeriesPoint>
		charts: Readonly<Record<string, Chart.Model>>
		theme: ThemeColors
		timeZone: string
		isWaiting: boolean
	}>,
): Html => {
	const rows = rowsOf(options.series)
	return h.div(
		[
			h.Class(cn("grid @min-[900px]/page:grid-cols-2", refreshingClass(options.isWaiting))),
			...(options.isWaiting ? [h.AriaBusy(true)] : []),
		],
		CELLS.map((spec) => cell(h, spec, rows, options.charts, options.theme, options.timeZone)),
	)
}
