import type { Html, HtmlBuilder } from "foldkit/html"
import * as BarChart from "../../charts/bar-chart"
import * as Chart from "../../charts/chart"
import { ChartSpec } from "../../charts/chart-spec"
import * as FixedMetricChart from "../../charts/fixed-metric-chart"
import { LATENCY_SERIES } from "../../charts/fixed-metric-series"
import { resolveColor, type ThemeColors } from "../../charts/theme-colors"
import { Message } from "./message"
import type { DbSummary, Model } from "./model"

// `DbQueryActivityChart`'s two plots: query volume (`QueryBuilderBarChart`) over latency
// (`LatencyLineChart`), joined by the linked cursor.
// TODO(linked-cursor): the shared pointer tracking (`useLinkedCursor`) is not ported; the cursor stays hidden.

type H = HtmlBuilder<Message>

/** The colour tokens the two plots and their chrome read off the theme. */
export const DB_CHART_TOKENS = [
	...LATENCY_SERIES.map((entry) => entry.token),
	"--border",
	"--background",
	...BarChart.BAR_CHART_TOKENS,
]

const VOLUME_ID = "db-query-volume"
const LATENCY_ID = "db-query-latency"

/** `LinkedCursorOverlay`: hidden until a sibling chart is hovered. */
const linkedCursorOverlay = (h: H, id: string): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.Class("pointer-events-none absolute"),
			h.DataAttribute("linked-cursor-overlay", id),
			h.Style({ "container-type": "inline-size", opacity: "var(--linked-cursor-visible)" }),
		],
		[
			h.div([
				h.Class("absolute inset-y-0 left-0 w-px bg-muted-foreground/45 will-change-transform"),
				h.Style({ transform: "translateX(calc(var(--linked-cursor-ratio) * (100cqw - 1px)))" }),
			]),
		],
	)

/** `LatencyLineChart legend="visible"`: the percentile swatches under the plot. */
const latencyLegend = (h: H, theme: ThemeColors): Html =>
	h.div(
		[h.Class("flex flex-wrap gap-x-3 gap-y-0.5 pt-2 text-xs")],
		LATENCY_SERIES.map((entry) =>
			h.span(
				[h.Class("flex items-center gap-1.5 px-1 py-0.5")],
				[
					h.span([
						h.Class("size-2 shrink-0 rounded-xs"),
						h.Style({ "background-color": resolveColor(theme, entry.token) }),
					]),
					h.span([h.Class("truncate")], [entry.label]),
				],
			),
		),
	)

const plotBox = (h: H, id: string, children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("relative h-32 w-full"), h.DataAttribute("linked-cursor-chart", id)],
		[...children, linkedCursorOverlay(h, id)],
	)

/** The two plots; empty frames until the chart runtime and theme colours are in. */
export const queryActivityCharts = (
	h: H,
	model: Model,
	response: DbSummary["value"],
	timeZone: string,
): Html => {
	const theme = model.chartRuntime._tag === "Ready" ? model.themeColors : null
	// One series named for what the bars are, so the tooltip reads "Queries".
	const volumeRows = response.timeseries.map((point) => ({
		bucket: point.bucket,
		Queries: Math.round(point.estimatedQueryCount || point.queryCount),
	}))
	const latencyRows = response.timeseries.map((point) => ({
		bucket: point.bucket,
		p50LatencyMs: point.p50DurationMs,
		p95LatencyMs: point.p95DurationMs,
	}))
	return h.div(
		[h.Class("space-y-2"), h.Style({ "--linked-cursor-ratio": "0", "--linked-cursor-visible": "0" })],
		[
			plotBox(
				h,
				VOLUME_ID,
				theme === null
					? []
					: [
							h.submodel({
								slotId: VOLUME_ID,
								model: model.dbCharts.volume,
								view: BarChart.view,
								viewInputs: {
									chartId: VOLUME_ID,
									data: volumeRows,
									theme,
									timeZone,
									nowMs: model.nowMs,
									className: "h-full w-full",
								},
								toParentMessage: (message: Chart.Message) =>
									Message.GotChartMessage({ chart: "volume", message }),
							}),
						],
			),
			plotBox(
				h,
				LATENCY_ID,
				theme === null
					? []
					: [
							h.submodel({
								slotId: LATENCY_ID,
								model: model.dbCharts.latency,
								view: FixedMetricChart.view,
								viewInputs: {
									chartId: LATENCY_ID,
									ariaLabel: "Latency percentiles",
									className: "h-full w-full",
									legend: latencyLegend(h, theme),
									spec: ChartSpec.FixedMetric({
										chart: "Latency",
										rows: latencyRows,
										colors: {
											...Object.fromEntries(
												LATENCY_SERIES.map((entry) => [
													entry.key,
													resolveColor(theme, entry.token),
												]),
											),
											border: resolveColor(theme, "--border"),
											background: resolveColor(theme, "--background"),
										},
										perSecond: false,
										timeZone,
										nowMs: model.nowMs,
										gradientPrefix: LATENCY_ID,
										showTooltip: true,
									}),
								},
								toParentMessage: (message: Chart.Message) =>
									Message.GotChartMessage({ chart: "latency", message }),
							}),
						],
			),
		],
	)
}
