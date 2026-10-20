import { Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../charts/chart"
import { INFRA_CHART_TOKENS } from "../../charts/infra-metric-series"
import { metricView } from "../../charts/infra-metric-chart"
import { LINKED_CURSOR_STYLE, MountLinkedCursor } from "../../charts/linked-cursor"
import { ResolveThemeColors } from "../../charts/theme-colors"
import { hostSeriesSummary } from "../../page/infra/hosts/detail/view-panels"
import { k8sChart } from "../../page/infra/kit/k8s-chart"
import type { SeriesSlot } from "../../page/infra/kit/series"
import { chartLoading } from "../../ui/chart-state"
import { isReady, Message, type Model, toChart } from "./chart-bench"

// `/lab/bench/infra`: the host and k8s detail
// ChartViews in one linked-cursor group, over synthetic rows.

const BUCKET_COUNT = 145
const BUCKET_MS = 60 * 1000
const END_TIME_MS = Date.UTC(2026, 6, 17, 18, 30)

/** `makeRows`: a phase-shifted sine per series, every bucket. */
const makeRows = (seriesNames: ReadonlyArray<string>, scale: number, offset: number) =>
	Arr.makeBy(BUCKET_COUNT, (index) => {
		const bucket = new Date(END_TIME_MS - (BUCKET_COUNT - 1 - index) * BUCKET_MS).toISOString()
		const phase = (index / (BUCKET_COUNT - 1)) * Math.PI * 6
		return seriesNames.map((attributeValue, s) => ({
			bucket,
			attributeValue,
			value: Math.max(0, (0.25 + 0.2 * Math.sin(phase + s * 1.3 + offset)) * scale),
		}))
	}).flat()

const HOST_CPU_ROWS = makeRows(["user", "system", "iowait"], 1, 0)
const HOST_LOAD_ROWS = makeRows(["value"], 8, 1.1)
const slotOf = (rows: ReturnType<typeof makeRows>, unit: string): SeriesSlot => ({
	key: null,
	data: AsyncData.succeed({ rows, unit }),
})
const POD_CPU = slotOf(makeRows(["api", "worker", "ingest"], 1, 2.2), "cores")
const POD_LIMIT = slotOf(makeRows(["value"], 1, 3.3), "percent")

type H = HtmlBuilder<Message>

/** `HostMetricChartView`: CPU stacks with the 80% rule, load is a line. */
const hostChart = (h: H, model: Model, metric: "cpu" | "load15", label: string): Html => {
	const theme = model.themeColors
	if (theme === null || !isReady(model)) return chartLoading(h, { variant: "area" })
	const isStacked = metric === "cpu"
	return h.submodel({
		slotId: `host-chart-${metric}`,
		model: model.charts[`host-${metric}`] ?? Chart.init(),
		view: metricView,
		toParentMessage: toChart(`host-${metric}`),
		viewInputs: {
			chartId: `host-${metric}`,
			rows: metric === "cpu" ? HOST_CPU_ROWS : HOST_LOAD_ROWS,
			unit: metric === "cpu" ? "percent" : "load",
			seriesLabel: label,
			stacked: isStacked,
			showThreshold: isStacked,
			linkedChartId: `host-${metric}`,
			header: hostSeriesSummary,
			theme,
			timeZone: model.timeZone,
		},
	})
}

const podChart = (
	h: H,
	model: Model,
	chartId: string,
	slot: SeriesSlot,
	label: string,
	isStacked: boolean,
): Html =>
	k8sChart(h, {
		slot,
		chart: model.charts[chartId],
		toChart: toChart(chartId),
		chartId,
		seriesLabel: label,
		stacked: isStacked,
		showThreshold: !isStacked,
		linkedChartId: chartId,
		theme: model.themeColors,
		runtime: model.chartRuntime,
		timeZone: model.timeZone,
	})

export const view = (model: Model, h: H): Html =>
	h.div(
		[
			h.DataAttribute("testid", "infra-chart-bench"),
			h.Class("min-h-screen bg-background p-6 text-foreground"),
			h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS })),
		],
		[
			h.div(
				[
					h.Class("grid grid-cols-1 gap-4 md:grid-cols-2"),
					h.Style(LINKED_CURSOR_STYLE),
					h.OnMount(MountLinkedCursor()),
				],
				[
					hostChart(h, model, "cpu", "CPU"),
					hostChart(h, model, "load15", "Load (15m)"),
					podChart(h, model, "pod-cpu_usage", POD_CPU, "CPU usage", true),
					podChart(h, model, "pod-cpu_limit", POD_LIMIT, "CPU / limit", false),
				],
			),
		],
	)
