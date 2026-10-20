import { formatCores, shareOfLimit } from "../../../../components/infra/railway/format"
import { formatBytes, formatPercent } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import * as InfraMetricChart from "../../../../charts/infra-metric-chart"
import { type ChartUnit, INFRA_CHART_TOKENS, type LongRow } from "../../../../charts/infra-metric-series"
import { ResolveThemeColors, type ThemeColors } from "../../../../charts/theme-colors"
import { chartLoading } from "../../../../ui/chart-state"
import { errorState } from "../../../../ui/error-state"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { timeControls } from "../../../kit/time-controls"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { chartCard } from "../../kit/chart-card"
import { heroChip } from "../../../infra/kit/hero-chip"
import { pageHero } from "../../../infra/kit/page-parts"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import type { RailwayServiceRow, RailwayServiceTimeseriesRow } from "../model"
import { Message } from "./message"
import type { Model } from "./model"
import { CHART_IDS, DEFAULT_PRESET } from "./update"

// `RailwayServicePage`.

type H = HtmlBuilder<Message>
type Pick = (row: RailwayServiceTimeseriesRow) => number

const LINKED_CHART_ID = "railway-service"

const CHARTS: ReadonlyArray<{
	readonly title: (typeof CHART_IDS)[number]
	readonly unit: ChartUnit
	readonly series: ReadonlyArray<readonly [string, Pick]>
}> = [
	{
		title: "CPU",
		unit: "cores",
		series: [
			["Average", (row) => row.cpuAvg],
			["Peak", (row) => row.cpuMax],
		],
	},
	{
		title: "Memory",
		unit: "bytes",
		series: [
			["Average", (row) => row.memoryAvg],
			["Peak", (row) => row.memoryMax],
		],
	},
	{
		title: "Network (as reported by Railway)",
		unit: "bytes",
		series: [
			["Received", (row) => row.networkRx],
			["Sent", (row) => row.networkTx],
		],
	},
	{
		title: "Disk",
		unit: "bytes",
		series: [
			["Volume", (row) => row.diskVolume],
			["Ephemeral", (row) => row.diskEphemeral],
		],
	},
]

const toRows = (
	buckets: ReadonlyArray<RailwayServiceTimeseriesRow>,
	series: ReadonlyArray<readonly [string, Pick]>,
): ReadonlyArray<LongRow> =>
	buckets.flatMap((row) =>
		series.map(([label, pick]) => ({ bucket: row.bucket, attributeValue: label, value: pick(row) })),
	)

/** The service's row in the fleet read, once loaded. */
export const serviceOf = (model: Model): RailwayServiceRow | null =>
	Option.getOrNull(
		Option.flatMap(AsyncData.getData(model.services.data), (rows) =>
			Option.fromNullishOr(
				rows.find(
					(row) =>
						row.serviceId === model.serviceId && row.environmentId === model.search.environmentId,
				),
			),
		),
	)

export const titleOf = (model: Model): string => {
	const service = serviceOf(model)
	return service === null || service.serviceName === "" ? model.serviceId : service.serviceName
}

const stats = (h: H, service: RailwayServiceRow): Html => {
	const cpuShare = shareOfLimit(service.cpuAvg, service.cpuLimit)
	const memoryShare = shareOfLimit(service.memoryAvg, service.memoryLimit)
	return statRail(h, {}, [
		statRailItem(h, {
			compact: true,
			eyebrow: "Avg CPU",
			value: formatCores(service.cpuAvg),
			subline:
				cpuShare === null
					? undefined
					: `${formatPercent(cpuShare / 100)} of ${formatCores(service.cpuLimit)}`,
		}),
		statRailItem(h, {
			compact: true,
			eyebrow: "Avg memory",
			value: formatBytes(service.memoryAvg),
			subline:
				memoryShare === null
					? undefined
					: `${formatPercent(memoryShare / 100)} of ${formatBytes(service.memoryLimit)}`,
		}),
		statRailItem(h, { compact: true, eyebrow: "Peak memory", value: formatBytes(service.memoryMax) }),
		statRailItem(h, { compact: true, eyebrow: "Replicas", value: String(service.replicas) }),
	])
}

const GRID = "grid grid-cols-1 gap-4 lg:grid-cols-2"

const loadingGrid = (h: H): Html =>
	h.div(
		[h.Class(GRID)],
		CHARTS.map(() => chartLoading(h, { variant: "line", height: 256 })),
	)

const chartGrid = (
	h: H,
	model: Model,
	buckets: ReadonlyArray<RailwayServiceTimeseriesRow>,
	theme: ThemeColors,
	timeZone: string,
	isWaiting: boolean,
): Html => {
	const xDomain = buckets.map((row) => row.bucket)
	return h.div(
		[h.Class(GRID)],
		CHARTS.map((chart, index) =>
			chartCard(h, { title: chart.title }, [
				h.submodel({
					slotId: `railway-chart-${index}`,
					model: model.charts[chart.title] ?? Chart.init(),
					view: InfraMetricChart.view,
					toParentMessage: (message: Chart.Message) =>
						Message.GotChartMessage({ chartId: chart.title, message }),
					viewInputs: {
						chartId: `railway-${index}`,
						spec: InfraMetricChart.infraMetricSpec({
							rows: toRows(buckets, chart.series),
							unit: chart.unit,
							xDomain,
							theme,
							timeZone,
							gradientPrefix: `railway-${index}`,
						}),
						linkedChartId: LINKED_CHART_ID,
						isWaiting,
					},
				}),
			]),
		),
	)
}

const chartsView = (h: H, model: Model, timeZone: string): Html => {
	const theme = model.themeColors
	const isReady = theme !== null && model.chartRuntime._tag !== "Loading"
	const grid = (buckets: ReadonlyArray<RailwayServiceTimeseriesRow>, isWaiting: boolean) =>
		isReady ? chartGrid(h, model, buckets, theme, timeZone, isWaiting) : loadingGrid(h)
	const failed = (failure: Parameters<typeof errorState>[1]["failure"]) =>
		errorState(h, {
			failure,
			title: "Failed to load service metrics",
			onRetry: Message.ClickedRetryTimeseries(),
		})
	return AsyncData.match(model.timeseries.data, {
		onIdle: () => loadingGrid(h),
		onLoading: () => loadingGrid(h),
		onFailure: failed,
		onStale: ({ error, data }) => (data.length === 0 ? failed(error) : grid(data, false)),
		onSuccess: (data) => grid(data, false),
		onRefreshing: (data) => grid(data, true),
	})
}

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const service = serviceOf(model)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					scrollClassName: "gap-6",
					actions: timeControls(h, {
						search: model.search,
						defaultPreset: DEFAULT_PRESET,
						window: model.window,
						onReset: Message.ClickedResetTimeRange(),
						onReload: Message.ClickedReload(),
						isReloading: model.isReloading,
						trigger: (label) =>
							h.submodel({
								slotId: "time-range-picker",
								model: model.timePicker,
								view: TimeRangePicker.view,
								toParentMessage: toTimePicker,
								viewInputs: {
									label,
									selectedPreset:
										model.search.timePreset ??
										(model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
									presets: TimeRangePicker.PRESET_VALUES,
								},
							}),
					}),
				},
				[
					pageHero(h, {
						title: titleOf(model),
						description: "Resource usage for this Railway service, summed across its replicas.",
						meta:
							service === null
								? undefined
								: [heroChip(h, service.projectName), heroChip(h, service.environmentName)],
					}),
					...(service === null ? [] : [stats(h, service)]),
					chartsView(h, model, inputs.context.timeZone),
				],
			),
		],
	)
})
