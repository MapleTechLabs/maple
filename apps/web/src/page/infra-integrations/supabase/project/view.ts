import { formatBytes, formatPercent } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { badge } from "../../../../ui/display"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import { heroChip } from "../../../infra/kit/hero-chip"
import { pageHero } from "../../../infra/kit/page-parts"
import { projectStatusLabel } from "../../../integrations/supabase"
import { integrationNotConnected } from "../../kit/empty-states"
import { metricChartCards, metricChartsLoading } from "../../kit/metric-charts"
import { pageTime } from "../../kit/page-time"
import type { SupabaseProjectRow, SupabaseProjectTimeseriesRow, SupabaseStatus } from "../model"
import { visibleCharts } from "./charts"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"

// `/infra/supabase/$projectRef`.

type H = HtmlBuilder<Message>
type DiscoveredProject = SupabaseStatus["projects"][number]

const LINKED_CHART_ID = "supabase-project"
const LOADING_CHARTS = 4

/** The project as discovery lists it, once the status loaded. */
const discoveredOf = (model: Model): DiscoveredProject | null =>
	Option.getOrNull(
		Option.flatMap(AsyncData.getData(model.status.data), (status) =>
			Option.fromNullishOr(status.projects.find((project) => project.ref === model.projectRef)),
		),
	)

/** The project's summary row in the fleet read, once loaded. */
const summaryOf = (model: Model): SupabaseProjectRow | null =>
	Option.getOrNull(
		Option.flatMap(AsyncData.getData(model.projects.data), (rows) =>
			Option.fromNullishOr(rows.find((row) => row.projectRef === model.projectRef)),
		),
	)

export const titleOf = (model: Model): string => discoveredOf(model)?.name || model.projectRef

const stats = (h: H, row: SupabaseProjectRow): Html =>
	statRail(h, {}, [
		statRailItem(h, {
			compact: true,
			eyebrow: "Avg CPU",
			value: formatPercent(row.cpuAvg),
			subline: `peak ${formatPercent(row.cpuMax)}`,
		}),
		statRailItem(h, {
			compact: true,
			eyebrow: "Avg memory",
			value: formatPercent(row.memoryAvg),
			subline: row.memoryTotal > 0 ? `of ${formatBytes(row.memoryTotal)}` : undefined,
		}),
		statRailItem(h, {
			compact: true,
			eyebrow: "Disk used",
			value: formatPercent(row.diskUsedMax),
			subline: row.diskSize > 0 ? `of ${formatBytes(row.diskSize)}` : undefined,
		}),
		statRailItem(h, { compact: true, eyebrow: "Database size", value: formatBytes(row.dbSize) }),
	])

const chartsView = (h: H, model: Model, timeZone: string): Html => {
	const theme = model.themeColors
	const isReady = theme !== null && model.chartRuntime._tag !== "Loading"
	const grid = (buckets: ReadonlyArray<SupabaseProjectTimeseriesRow>, isWaiting: boolean) =>
		buckets.length === 0
			? noMetrics(h, discoveredOf(model))
			: isReady
				? metricChartCards(h, {
						idPrefix: "supabase",
						linkedChartId: LINKED_CHART_ID,
						charts: visibleCharts(buckets),
						buckets,
						models: model.charts,
						toMessage: (chartId, message) => Message.GotChartMessage({ chartId, message }),
						theme,
						timeZone,
						isWaiting,
					})
				: metricChartsLoading(h, LOADING_CHARTS)
	const failed = (failure: Parameters<typeof errorState>[1]["failure"]) =>
		errorState(h, {
			failure,
			title: "Failed to load project metrics",
			onRetry: Message.ClickedRetryTimeseries(),
		})
	return AsyncData.match(model.timeseries.data, {
		onIdle: () => metricChartsLoading(h, LOADING_CHARTS),
		onLoading: () => metricChartsLoading(h, LOADING_CHARTS),
		onFailure: failed,
		onStale: ({ error, data }) => (data.length === 0 ? failed(error) : grid(data, false)),
		onSuccess: (data) => grid(data, false),
		onRefreshing: (data) => grid(data, true),
	})
}

/** Nothing scraped in the window: says why, and where the switch is. */
const noMetrics = (h: H, project: DiscoveredProject | null): Html =>
	integrationNotConnected(h, {
		icon: icon(h, "SupabaseIcon", { size: 16 }),
		title: "No metrics for this project in this time range",
		description:
			project !== null && !project.metricsEnabled
				? "Metrics collection is off for this project. Turn on Collect metrics to start scraping it."
				: "Maple scrapes every minute once Collect metrics is on. Try a wider time range, or check the connection.",
		integration: "supabase",
		actionLabel: "Manage projects",
		actionVariant: "outline",
	})

/** The hero's chips: region and a pill when Supabase reports the project as not healthy. */
const heroMeta = (h: H, project: DiscoveredProject | null): ReadonlyArray<Html> | undefined => {
	if (project === null) return undefined
	const pill = projectStatusLabel(project.status)
	return [
		heroChip(h, project.ref),
		...(project.region === "" ? [] : [heroChip(h, project.region)]),
		...(pill === null ? [] : [badge(h, { variant: pill.tone }, [pill.label])]),
	]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const summary = summaryOf(model)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					scrollClassName: "gap-6",
					actions: pageTime(h, {
						search: model.search,
						defaultPreset: DEFAULT_PRESET,
						window: model.window,
						picker: model.timePicker,
						toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
						onReset: Message.ClickedResetTimeRange(),
						onReload: Message.ClickedReload(),
						isReloading: model.isReloading,
					}),
				},
				[
					pageHero(h, {
						title: titleOf(model),
						description:
							"Resources and Postgres health for this Supabase project, scraped every minute.",
						meta: heroMeta(h, discoveredOf(model)),
					}),
					...(summary === null ? [] : [stats(h, summary)]),
					chartsView(h, model, inputs.context.timeZone),
				],
			),
		],
	)
})
