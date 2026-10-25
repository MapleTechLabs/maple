import { formatCores, shareOfLimit } from "../../../../components/infra/railway/format"
import { formatBytes, formatPercent } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { errorState } from "../../../../ui/error-state"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { timeControls } from "../../../kit/time-controls"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { type MetricChart, metricChartCards, metricChartsLoading } from "../../kit/metric-charts"
import { heroChip } from "../../../infra/kit/hero-chip"
import { pageHeroParts } from "../../../infra/kit/page-parts"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import type { RailwayServiceRow, RailwayServiceTimeseriesRow } from "../model"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"

// `RailwayServicePage`.

type H = HtmlBuilder<Message>

const LINKED_CHART_ID = "railway-service"

/** Ids match `CHART_IDS`, the keys of the chart models. */
const CHARTS: ReadonlyArray<MetricChart<RailwayServiceTimeseriesRow>> = [
	{
		id: "CPU",
		unit: "cores",
		series: [
			["Average", (row) => row.cpuAvg],
			["Peak", (row) => row.cpuMax],
		],
	},
	{
		id: "Memory",
		unit: "bytes",
		series: [
			["Average", (row) => row.memoryAvg],
			["Peak", (row) => row.memoryMax],
		],
	},
	{
		id: "Network (as reported by Railway)",
		unit: "bytes",
		series: [
			["Received", (row) => row.networkRx],
			["Sent", (row) => row.networkTx],
		],
	},
	{
		id: "Disk",
		unit: "bytes",
		series: [
			["Volume", (row) => row.diskVolume],
			["Ephemeral", (row) => row.diskEphemeral],
		],
	},
]

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

const chartsView = (h: H, model: Model, timeZone: string): Html => {
	const theme = model.themeColors
	const isReady = theme !== null && model.chartRuntime._tag !== "Loading"
	const grid = (buckets: ReadonlyArray<RailwayServiceTimeseriesRow>, isWaiting: boolean) =>
		isReady
			? metricChartCards(h, {
					idPrefix: "railway",
					linkedChartId: LINKED_CHART_ID,
					charts: CHARTS,
					buckets,
					models: model.charts,
					toMessage: (chartId, message) => Message.GotChartMessage({ chartId, message }),
					theme,
					timeZone,
					isWaiting,
				})
			: metricChartsLoading(h, CHARTS.length)
	const failed = (failure: Parameters<typeof errorState>[1]["failure"]) =>
		errorState(h, {
			failure,
			title: "Couldn't load service metrics",
			onRetry: Message.ClickedRetryTimeseries(),
		})
	return AsyncData.match(model.timeseries.data, {
		onIdle: () => metricChartsLoading(h, CHARTS.length),
		onLoading: () => metricChartsLoading(h, CHARTS.length),
		onFailure: failed,
		onStale: ({ error, data }) => (data.length === 0 ? failed(error) : grid(data, false)),
		onSuccess: (data) => grid(data, false),
		onRefreshing: (data) => grid(data, true),
	})
}

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const service = serviceOf(model)
	const hero = pageHeroParts(h, {
		title: titleOf(model),
		description: "Resource usage for this Railway service, summed across its replicas.",
		meta:
			service === null
				? undefined
				: [heroChip(h, service.projectName), heroChip(h, service.environmentName)],
	})
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					scrollClassName: "gap-6",
					titleContent: hero.title,
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
					hero.body,
					...(service === null ? [] : [stats(h, service)]),
					chartsView(h, model, inputs.context.timeZone),
				],
			),
		],
	)
})
