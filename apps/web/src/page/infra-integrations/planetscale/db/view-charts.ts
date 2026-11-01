import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import type { ChartEventMarker } from "../../../../charts/event-marker-spec"
import { CHART_EMPTY_MESSAGE } from "../../../../charts/infra-metric-chart"
import * as PlotBoxChart from "../../../../charts/plot-box-chart"
import { METRIC_LABELS, type PlanetScaleMetric } from "../../../../charts/planetscale-metric-series"
import { resolveColor, type ThemeColors } from "../../../../charts/theme-colors"
import { chartLoading } from "../../../../ui/chart-state"
import { errorState } from "../../../../ui/error-state"
import { CHART_HEIGHT, chartCard, chartCardMessage } from "../../kit/chart-card"
import { scopeChip } from "../../kit/scope-chip"
import type { TimeseriesRow } from "../data"
import { Message, type Model } from "./model"

// `PlanetScaleChart` cards and the chart section of `PlanetScaleDatabaseData`.

type H = HtmlBuilder<Message>
export type Trigger = (id: string) => ReadonlyArray<ChildAttribute>

const METRIC_COLORS = {
	connectionsAvg: "--chart-1",
	cpuMaxPercent: "--chart-2",
	memMaxPercent: "--chart-3",
	storageUsedPercent: "--chart-5",
	replicaLagMaxSeconds: "--chart-4",
} as const satisfies Record<PlanetScaleMetric, string>

export const CHART_TOKENS = [
	"--border",
	"--background",
	"--muted-foreground",
	"--severity-warn",
	"--severity-error",
	...Object.values(METRIC_COLORS),
]

const LEAD: PlanetScaleMetric = "storageUsedPercent"
const GRID: ReadonlyArray<PlanetScaleMetric> = [
	"connectionsAvg",
	"cpuMaxPercent",
	"memMaxPercent",
	"replicaLagMaxSeconds",
]

export const CHART_SCOPE_EXPLANATION = "Every branch in this database, combined."
export const FALLBACK_EXPLANATION = {
	chart: "PlanetScale reports these gauges per branch, but the history endpoint answers one branch or the whole database, so this shows every branch combined.",
	insights:
		"PlanetScale's Query Insights API answers one branch at a time, so this shows the resolved branch only.",
} as const

/** `PlanetScaleBranchScope`: the trigger ids are `${idPrefix}-all` and `${idPrefix}-fallback`. */
export const branchScope = (
	h: H,
	options: Readonly<{
		selected: ReadonlyArray<string>
		resolved?: string | null
		surface: "chart" | "insights"
		idPrefix: string
		trigger: Trigger
	}>,
): Html => {
	if (options.selected.length === 0) {
		return scopeChip(h, { tone: "muted", trigger: options.trigger(`${options.idPrefix}-all`) }, [
			"all branches",
		])
	}
	if (options.selected.length === 1) return scopeChip(h, {}, [options.selected[0] ?? ""])
	const extra = options.selected.length - 2
	return h.span(
		[h.Class("flex flex-wrap items-center gap-1")],
		[
			scopeChip(h, {}, [options.selected.slice(0, 2).join(", "), ...(extra > 0 ? [` +${extra}`] : [])]),
			scopeChip(h, { tone: "muted", trigger: options.trigger(`${options.idPrefix}-fallback`) }, [
				options.surface === "chart"
					? "showing all branches"
					: `showing ${options.resolved ?? "the default branch"}`,
			]),
		],
	)
}

const loadingCard = (h: H, metric: PlanetScaleMetric): Html =>
	chartCard(h, { title: METRIC_LABELS[metric] }, [
		chartLoading(h, { variant: "line", height: CHART_HEIGHT, className: "px-3 pt-2 pb-3" }),
	])

export type ChartsContext = Readonly<{
	theme: ThemeColors
	timeZone: string
	markers: ReadonlyArray<ChartEventMarker>
	emptyMessage: string | undefined
	selected: ReadonlyArray<string>
	trigger: Trigger
}>

const metricCard = (
	h: H,
	model: Model,
	metric: PlanetScaleMetric,
	buckets: ReadonlyArray<TimeseriesRow>,
	isWaiting: boolean,
	context: ChartsContext,
): Html => {
	const points = buckets.map((row) => ({ bucket: row.bucket, value: row[metric] }))
	const hasValues = points.some((point) => point.value !== null)
	return chartCard(
		h,
		{
			title: METRIC_LABELS[metric],
			scope: branchScope(h, {
				selected: context.selected,
				surface: "chart",
				idPrefix: `ps-chart-${metric}`,
				trigger: context.trigger,
			}),
			className: cn(refreshingClass(isWaiting)),
		},
		[
			hasValues
				? h.submodel({
						slotId: `planetscale-chart-${metric}`,
						model: model.charts[metric] ?? Chart.init(),
						view: PlotBoxChart.view,
						toParentMessage: (message: Chart.Message) =>
							Message.GotChartMessage({ chartId: metric, message }),
						viewInputs: {
							chartId: `planetscale-${metric}`,
							ariaLabel: METRIC_LABELS[metric],
							height: CHART_HEIGHT,
							spec: {
								_tag: "PlanetScaleMetric",
								metric,
								points,
								colors: {
									[metric]: resolveColor(context.theme, METRIC_COLORS[metric]),
									border: resolveColor(context.theme, "--border"),
									background: resolveColor(context.theme, "--background"),
								},
								markers: context.markers,
								markerColors: {
									neutral: resolveColor(context.theme, "--muted-foreground"),
									warn: resolveColor(context.theme, "--severity-warn"),
									crit: resolveColor(context.theme, "--severity-error"),
									label: resolveColor(context.theme, "--muted-foreground"),
								},
								timeZone: context.timeZone,
							},
						},
					})
				: chartCardMessage(h, context.emptyMessage ?? CHART_EMPTY_MESSAGE),
		],
	)
}

const grid = (h: H, children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("space-y-4")],
		[
			children[0] ?? h.empty,
			h.div([h.Class("grid grid-cols-1 gap-4 lg:grid-cols-2")], children.slice(1)),
		],
	)

const loadingCharts = (h: H): Html =>
	grid(
		h,
		[LEAD, ...GRID].map((metric) => loadingCard(h, metric)),
	)

/** The chart section: skeletons until the series and the chart runtime are in, then the five cards. */
export const chartsSection = (
	h: H,
	model: Model,
	context: Omit<ChartsContext, "theme"> & { theme: ThemeColors | null },
): Html => {
	const theme = context.theme
	const isReady = theme !== null && model.chartRuntime._tag !== "Loading"
	const cards = (buckets: ReadonlyArray<TimeseriesRow>, isWaiting: boolean) =>
		!isReady || theme === null
			? loadingCharts(h)
			: grid(
					h,
					[LEAD, ...GRID].map((metric) =>
						metricCard(h, model, metric, buckets, isWaiting, { ...context, theme }),
					),
				)
	const failed = (failure: Parameters<typeof errorState>[1]["failure"]) =>
		errorState(h, {
			failure,
			title: "Couldn't load database metrics",
			onRetry: Message.ClickedRetryTimeseries(),
		})
	return AsyncData.match(model.timeseries.data, {
		onIdle: () => loadingCharts(h),
		onLoading: () => loadingCharts(h),
		onFailure: failed,
		onStale: ({ error }) => failed(error),
		onRefreshing: (buckets) => cards(buckets, true),
		onSuccess: (buckets) => cards(buckets, false),
	})
}
