import type {
	VercelInfraProjectDetailResponse,
	VercelInfraRequestBucket,
	VercelProjectStatus,
} from "@maple/domain/http"
import { ERROR_RATE_TEXT, errorRateLevel } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { STATUS_CLASS_COLORS } from "@maple/views/lib/cloudflare-constants"
import {
	fillBuckets,
	requestClassRows,
	vercelProjectLogAttrs,
	vercelProjectRow,
	vercelProjectTracesWhere,
	type VercelProjectRow,
	zeroRequestBucket,
} from "../../../../components/infra/vercel/list-model"
import { percentOf } from "../../../../components/integrations/vercel-model"
import * as BarChart from "@maple/views/charts/bar-chart"
import * as Chart from "@maple/views/charts/chart"
import { CHART_EMPTY_MESSAGE } from "@maple/views/charts/infra-metric-chart"
import * as InfraMetricChart from "@maple/views/charts/infra-metric-chart"
import { INFRA_CHART_TOKENS, type LongRow } from "@maple/views/charts/infra-metric-series"
import * as PlotBoxChart from "@maple/views/charts/plot-box-chart"
import { stackedBreakdown } from "@maple/views/charts/stacked-breakdown-chart"
import { ResolveThemeColors, type ThemeColors } from "@maple/views/charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { linkButton } from "@maple/views/ui/button"
import { chartLoading } from "@maple/views/ui/chart-state"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography, typographyClass } from "@maple/views/ui/typography"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { relativeTime } from "../../../kit/relative-time"
import { sectionHeading } from "../../../kit/section-heading"
import { seriesLegend } from "../../../kit/series-legend"
import { statRail, statRailItem, statRailLoading } from "../../../kit/stat-rail"
import { heroChip } from "../../../infra/kit/hero-chip"
import { columnHead, dataTable, dataTableEmpty } from "../../../infra/kit/data-table"
import { pageHero } from "../../../infra/kit/page-parts"
import { pickTimeSearch, type TimeSearch, viewTabStrip } from "../../../infra/kit/view-tabs"
import { CHART_HEIGHT, chartCard, chartCardMessage } from "../../kit/chart-card"
import { pageTime } from "../../kit/page-time"
import { DEFAULT_PRESET, seriesInput } from "../data"
import {
	aiGatewayEmpty,
	aiGatewayLoading,
	aiGatewayPanel,
	barChartSlot,
	type BarChartSlot,
	type Clock,
	dataOf,
	deploymentInline,
	failureOf,
	fillAiSeries,
	LEAD_COLUMN,
	ROW_CLASS,
} from "../view-parts"
import type { VercelProjectTab } from "../../../../route/search"
import {
	buildsSection,
	dependenciesSection,
	drainNotice,
	functionsSection,
	readSection,
	speedInsightsSection,
	webAnalyticsSection,
} from "../sections"
import { Message, type Model } from "./model"
import { tabOf } from "./update"

// `VercelProjectPage`.

type H = HtmlBuilder<Message>

const THEME_TOKENS = [...INFRA_CHART_TOKENS, "--chart-2", ...BarChart.BAR_CHART_TOKENS]
const STATUS_ORDER = ["2xx", "3xx", "4xx", "5xx", "unknown"]
const NUM = typographyClass({ size: "xs", tone: "soft", mono: true, numeric: true, className: "text-right" })

const rate = (part: number, whole: number) => (percentOf(part, whole) ?? 0) / 100

/** The inventory's view of the project; null while loading, failed, or when it is not listed. */
export const projectStatusOf = (model: Model): VercelProjectStatus | null =>
	Option.getOrNull(
		Arr.findFirst(dataOf(model.status.data)?.projects ?? [], (project) => project.id === model.projectId),
	)

/** The project's row: zeros when nothing arrived; a failed status read still shows it, under its id. */
export const projectRowOf = (model: Model): VercelProjectRow | null => {
	const projects = dataOf(model.projects.data)
	return projects === null
		? null
		: vercelProjectRow(model.projectId, dataOf(model.status.data)?.projects ?? [], projects)
}

export const titleOf = (model: Model): string =>
	projectStatusOf(model)?.name ?? projectRowOf(model)?.name ?? model.projectId

const stats = (
	h: H,
	row: VercelProjectRow,
	buckets: ReadonlyArray<VercelInfraRequestBucket>,
	clock: Clock,
): Html => {
	const errorFraction = row.errorPercent === null ? 0 : row.errorPercent / 100
	return statRail(h, { columns: 5 }, [
		statRailItem(h, {
			eyebrow: "Requests",
			value: formatNumber(row.requests),
			spark: Arr.map(buckets, (bucket) => bucket.requests),
			subline:
				row.lastSeen === null
					? "none in this window"
					: relativeTime(h, { value: row.lastSeen, ...clock, prefix: "last" }),
		}),
		statRailItem(h, {
			eyebrow: "5xx rate",
			value: row.errorPercent === null ? EMPTY_VALUE : formatErrorRate(errorFraction),
			tone: errorRateLevel(errorFraction),
			spark: Arr.map(buckets, (bucket) => bucket.requests5xx),
			subline: `${formatNumber(row.requests5xx)} server errors`,
		}),
		statRailItem(h, {
			eyebrow: "Cache hits",
			value: row.cacheHitPercent === null ? EMPTY_VALUE : formatPercent(row.cacheHitPercent / 100),
			spark: Arr.map(buckets, (bucket) => bucket.cacheHits),
			subline: row.cacheHitPercent === null ? "no cache lookups" : "of cache lookups",
		}),
		statRailItem(h, {
			eyebrow: "p95 latency",
			value: row.p95DurationMs === null ? EMPTY_VALUE : formatLatency(row.p95DurationMs),
			compact: true,
			subline: row.p95DurationMs === null ? "no deployment traces" : "deployment root spans",
		}),
		statRailItem(h, {
			eyebrow: "Error logs",
			value: formatNumber(row.errorLogs),
			tone: row.errorLogs > 0 ? "warn" : "neutral",
			spark: Arr.map(buckets, (bucket) => bucket.errorLogs),
			subline: "error and fatal records",
		}),
	])
}

const CHART_GRID = "grid grid-cols-1 gap-4 lg:grid-cols-4"

const chartsLoading = (h: H): Html =>
	h.div(
		[h.Class(CHART_GRID)],
		[
			chartLoading(h, { variant: "area", height: CHART_HEIGHT, className: "lg:col-span-2" }),
			chartLoading(h, { variant: "area", height: CHART_HEIGHT }),
			chartLoading(h, { variant: "area", height: CHART_HEIGHT }),
		],
	)

const statusChart = (
	h: H,
	model: Model,
	buckets: ReadonlyArray<VercelInfraRequestBucket>,
	theme: ThemeColors,
	timeZone: string,
): Html => {
	const chartId = "vercel-status"
	const built = stackedBreakdown({
		rows: requestClassRows(buckets),
		colors: STATUS_CLASS_COLORS,
		order: STATUS_ORDER,
		theme,
		timeZone,
		gradientPrefix: chartId,
	})
	return chartCard(
		h,
		{
			title: "Requests by status",
			className: "lg:col-span-2",
			legend: seriesLegend(h, {
				items: Arr.map(built.legend, ({ name, label, color }) => ({
					key: name,
					label,
					title: label,
					color,
				})),
			}),
		},
		[
			built.isEmpty
				? chartCardMessage(h, CHART_EMPTY_MESSAGE)
				: h.submodel({
						slotId: chartId,
						model: model.charts[chartId] ?? Chart.init(),
						view: PlotBoxChart.view,
						toParentMessage: (message: Chart.Message) =>
							Message.GotChartMessage({ chartId, message }),
						viewInputs: {
							chartId,
							spec: built.spec,
							ariaLabel: "Requests by status",
							height: CHART_HEIGHT,
						},
					}),
		],
	)
}

const metricChart = (
	h: H,
	model: Model,
	options: Readonly<{
		chartId: string
		title: string
		rows: ReadonlyArray<LongRow>
		xDomain: ReadonlyArray<string>
		color?: string
	}>,
	theme: ThemeColors,
	timeZone: string,
): Html =>
	chartCard(h, { title: options.title }, [
		h.submodel({
			slotId: options.chartId,
			model: model.charts[options.chartId] ?? Chart.init(),
			view: InfraMetricChart.view,
			toParentMessage: (message: Chart.Message) =>
				Message.GotChartMessage({ chartId: options.chartId, message }),
			viewInputs: {
				chartId: options.chartId,
				height: CHART_HEIGHT,
				spec: InfraMetricChart.infraMetricSpec({
					rows: options.rows,
					unit: "count",
					seriesLabel: options.title,
					xDomain: options.xDomain,
					seriesColors: options.color === undefined ? {} : { value: options.color },
					theme,
					timeZone,
					gradientPrefix: options.chartId,
				}),
			},
		}),
	])

const charts = (
	h: H,
	model: Model,
	buckets: ReadonlyArray<VercelInfraRequestBucket>,
	timeZone: string,
): Html => {
	const theme = model.themeColors
	if (theme === null || model.chartRuntime._tag === "Loading") return chartsLoading(h)
	const xDomain = Arr.map(buckets, (bucket) => bucket.bucket)
	const single = (pick: (bucket: VercelInfraRequestBucket) => number): ReadonlyArray<LongRow> =>
		Arr.map(buckets, (bucket) => ({
			bucket: bucket.bucket,
			attributeValue: "value",
			value: pick(bucket),
		}))
	return h.div(
		[h.Class(CHART_GRID)],
		[
			statusChart(h, model, buckets, theme, timeZone),
			metricChart(
				h,
				model,
				{ chartId: "vercel-cache", title: "Cache hits", rows: single((b) => b.cacheHits), xDomain },
				theme,
				timeZone,
			),
			metricChart(
				h,
				model,
				{
					chartId: "vercel-errors",
					title: "Error logs",
					rows: single((b) => b.errorLogs),
					xDomain,
					color: "var(--severity-warn)",
				},
				theme,
				timeZone,
			),
		],
	)
}

const topPaths = (h: H, paths: VercelInfraProjectDetailResponse["paths"]): Html =>
	h.section(
		[h.Class("min-w-0 space-y-3")],
		[
			sectionHeading(h, {
				title: "Top paths",
				hint: "most requested first",
				count: String(paths.length),
			}),
			dataTable(
				h,
				{ ariaLabel: "Top paths" },
				[
					columnHead(h, { label: "Path", width: "w-0 flex-1 min-w-[160px]" }),
					columnHead(h, { label: "Requests", width: "w-[80px]", align: "right" }),
					columnHead(h, {
						label: "4xx",
						width: "w-[64px]",
						align: "right",
						hidden: "hidden xl:flex",
					}),
					columnHead(h, { label: "5xx", width: "w-[64px]", align: "right" }),
					columnHead(h, { label: "Cached", width: "w-[64px]", align: "right" }),
				],
				paths.length === 0
					? [dataTableEmpty(h, ["No requests in this window"])]
					: Arr.map(paths, (path) => {
							const errors = rate(path.requests5xx, path.requests)
							return h.div(
								[h.Key(path.path), h.Class(ROW_CLASS)],
								[
									h.span(
										[
											h.Class(
												"w-0 min-w-[160px] flex-1 truncate font-mono text-xs text-foreground",
											),
											h.Title(path.path),
										],
										[path.path === "" ? "/" : path.path],
									),
									h.span([h.Class(cn(NUM, "w-[80px]"))], [formatNumber(path.requests)]),
									h.span(
										[h.Class(cn(NUM, "hidden w-[64px] xl:block"))],
										[formatErrorRate(rate(path.requests4xx, path.requests))],
									),
									h.span(
										[
											h.Class(
												cn(NUM, "w-[64px]", ERROR_RATE_TEXT[errorRateLevel(errors)]),
											),
										],
										[formatErrorRate(errors)],
									),
									h.span(
										[h.Class(cn(NUM, "w-[64px]"))],
										[
											path.cacheLookups === 0
												? EMPTY_VALUE
												: formatPercent(rate(path.cacheHits, path.cacheLookups)),
										],
									),
								],
							)
						}),
			),
		],
	)

const topErrors = (h: H, errors: VercelInfraProjectDetailResponse["errors"], clock: Clock): Html =>
	h.section(
		[h.Class("min-w-0 space-y-3")],
		[
			sectionHeading(h, {
				title: "Top errors",
				hint: "error and fatal logs, most frequent first",
				count: String(errors.length),
			}),
			dataTable(
				h,
				{ ariaLabel: "Top errors" },
				[
					columnHead(h, { label: "Message", width: LEAD_COLUMN }),
					columnHead(h, { label: "Count", width: "w-[64px]", align: "right" }),
					columnHead(h, { label: "Last seen", width: "w-[72px]", align: "right" }),
				],
				errors.length === 0
					? [dataTableEmpty(h, ["No error logs in this window"])]
					: Arr.map(errors, (error) =>
							h.div(
								[h.Key(`${error.source}:${error.message}`), h.Class(ROW_CLASS)],
								[
									hstack(
										h,
										{
											align: "baseline",
											gap: "2",
											grow: true,
											className: "w-0 min-w-[200px]",
										},
										[
											...(error.source === ""
												? []
												: [
														badge(
															h,
															{ variant: "muted", size: "xs", mono: true },
															[error.source],
														),
													]),
											typography(
												h,
												{
													size: "xs",
													tone: "foreground",
													mono: true,
													truncate: true,
													attributes: [h.Title(error.message)],
												},
												[error.message === "" ? "(empty message)" : error.message],
											),
										],
									),
									h.span(
										[h.Class(cn(NUM, "w-[64px]", TONE_TEXT.crit))],
										[formatNumber(error.occurrences)],
									),
									h.span(
										[h.Class("w-[72px] text-right")],
										[
											relativeTime(h, {
												value: error.lastSeen,
												...clock,
												variant: "short",
												mono: true,
												className: typographyClass({ size: "2xs", tone: "muted" }),
											}),
										],
									),
								],
							),
						),
			),
		],
	)

const aiGatewaySection = (h: H, model: Model, time: TimeSearch, bar: BarChartSlot, enabled: boolean): Html =>
	readSection(h, {
		title: "AI Gateway",
		hint: "requests this project made through Vercel AI Gateway",
		read: { data: model.aiGateway.data, onRetry: Message.ClickedRetryAiGateway() },
		off: enabled
			? null
			: {
					lead: "AI Gateway is off.",
					text: "Turn on the AI Gateway drain to see this project's model spend, tokens and errors.",
				},
		failure: "Couldn't load AI Gateway usage",
		loading: () => [aiGatewayLoading(h)],
		body: (data) =>
			data.summary.requests === 0
				? [aiGatewayEmpty(h, true)]
				: [
						aiGatewayPanel(h, {
							data,
							timeseries: fillAiSeries(data.timeseries, model.window),
							projectNames: new Map(),
							time,
							bar,
						}),
					],
	})

const functionsStats = (h: H, row: VercelProjectRow | null): Html =>
	row === null
		? statRailLoading(h, 2, 2)
		: statRail(h, { columns: 2 }, [
				statRailItem(h, { eyebrow: "Invocations", value: formatNumber(row.invocations) }),
				statRailItem(h, {
					eyebrow: "Cold starts",
					value:
						row.coldStartPercent === null
							? EMPTY_VALUE
							: formatPercent(row.coldStartPercent / 100),
					tone: errorRateLevel(row.coldStartPercent === null ? 0 : row.coldStartPercent / 100),
					subline: "of invocations started a new instance",
				}),
			])

const requestsSection = (h: H, model: Model, clock: Clock): ReadonlyArray<Html> => {
	const failure = failureOf(model.projects.data) ?? failureOf(model.buckets.data)
	if (failure !== null)
		return [
			errorState(h, {
				failure,
				title: "Couldn't load this project's requests",
				onRetry: Message.ClickedRetryRequests(),
			}),
		]
	const row = projectRowOf(model)
	const raw = dataOf(model.buckets.data)
	if (row === null || raw === null || model.window === null)
		return [statRailLoading(h, 5, 5), chartsLoading(h)]
	const buckets = fillBuckets(raw, seriesInput(model.window), zeroRequestBucket)
	return [stats(h, row, buckets, clock), charts(h, model, buckets, clock.timeZone)]
}

const detailSection = (h: H, model: Model, clock: Clock): ReadonlyArray<Html> => {
	const failure = failureOf(model.detail.data)
	if (failure !== null)
		return [
			errorState(h, {
				failure,
				title: "Couldn't load top paths and errors",
				onRetry: Message.ClickedRetryDetail(),
			}),
		]
	const detail = dataOf(model.detail.data)
	return detail === null
		? []
		: [
				h.div(
					[h.Class("grid grid-cols-1 gap-6 lg:grid-cols-2")],
					[topPaths(h, detail.paths), topErrors(h, detail.errors, clock)],
				),
			]
}

const header = (h: H, model: Model, time: TimeSearch, clock: Clock): Html => {
	const project = projectStatusOf(model)
	const production = project?.productionDeployment ?? null
	return pageHero(h, {
		title: titleOf(model),
		trailing:
			project?.framework === null || project === null ? undefined : heroChip(h, project.framework),
		meta:
			production === null
				? [typography(h, { size: "2xs", tone: "muted" }, ["No production deployment recorded"])]
				: [
						typography(h, { size: "2xs", tone: "muted" }, ["Production"]),
						deploymentInline(h, production, clock),
						typography(h, { size: "2xs" }, [
							textLink(
								h,
								{
									href: `https://${production.url}`,
									tone: "muted",
									isMono: true,
									attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
								},
								[production.url, icon(h, "ExternalLinkIcon", { size: 10 })],
							),
						]),
					],
		actions: [
			linkButton(
				h,
				{
					size: "sm",
					variant: "outline",
					href: hrefOf(
						AppRoute.Logs({
							search: { ...time, attrs: [...vercelProjectLogAttrs(model.projectId)] },
						}),
					),
				},
				[icon(h, "FileIcon"), "Logs"],
			),
			linkButton(
				h,
				{
					size: "sm",
					variant: "outline",
					href: hrefOf(
						AppRoute.Traces({
							search: { ...time, whereClause: vercelProjectTracesWhere(model.projectId) },
						}),
					),
				},
				[icon(h, "PulseIcon"), "Traces"],
			),
		],
	})
}

const TABS: ReadonlyArray<Readonly<{ id: VercelProjectTab; title: string }>> = [
	{ id: "traffic", title: "Traffic" },
	{ id: "functions", title: "Functions" },
	{ id: "dependencies", title: "Dependencies" },
	{ id: "builds", title: "Builds" },
	{ id: "aiGateway", title: "AI Gateway" },
	{ id: "speedInsights", title: "Speed Insights" },
	{ id: "webAnalytics", title: "Web Analytics" },
]

const tabStrip = (h: H, model: Model, time: TimeSearch): Html =>
	viewTabStrip(
		h,
		"Project views",
		Arr.map(TABS, (tab) => ({
			id: tab.id,
			title: tab.title,
			href: hrefOf(
				AppRoute.InfraVercelProject({
					projectId: model.projectId,
					search: tab.id === "traffic" ? time : { ...time, tab: tab.id },
				}),
			),
		})),
		tabOf(model),
	)

/** The project's own service on the service map: ingest names Vercel's runtime spans after the project. */
const serviceMapHref = (model: Model, time: TimeSearch): string =>
	hrefOf(AppRoute.ServiceMap({ search: { ...time, focusService: titleOf(model) } }))

const tabBody = (h: H, model: Model, time: TimeSearch, clock: Clock): ReadonlyArray<Html> => {
	const status = dataOf(model.status.data)
	const tracesEnabled = status?.tracesEnabled ?? true
	switch (tabOf(model)) {
		case "traffic":
			return [
				...(status === null || status.logsEnabled
					? []
					: [
							drainNotice(h, {
								lead: "Logs are off.",
								text: "Requests, status codes, cache hits and error logs come from the logs drain.",
								actionLabel: "Forward logs",
							}),
						]),
				...requestsSection(h, model, clock),
				...detailSection(h, model, clock),
			]
		case "functions":
			return [
				...(tracesEnabled ? [functionsStats(h, projectRowOf(model))] : []),
				functionsSection(h, {
					read: { data: model.functions.data, onRetry: Message.ClickedRetryFunctions() },
					tracesEnabled,
				}),
			]
		case "dependencies":
			return [
				dependenciesSection(h, {
					read: { data: model.dependencies.data, onRetry: Message.ClickedRetryDependencies() },
					tracesEnabled,
					serviceMapHref: serviceMapHref(model, time),
				}),
			]
		case "builds":
			return [
				buildsSection(h, {
					read: { data: model.deployments.data, onRetry: Message.ClickedRetryDeployments() },
					clock,
					projectName: null,
				}),
			]
		case "aiGateway":
			return [
				aiGatewaySection(
					h,
					model,
					time,
					barChartSlot(
						h,
						model,
						(chartId, message) => Message.GotChartMessage({ chartId, message }),
						clock.timeZone,
					),
					status?.aiGatewayEnabled ?? true,
				),
			]
		case "speedInsights":
			return [
				speedInsightsSection(h, {
					read: { data: model.speedInsights.data, onRetry: Message.ClickedRetrySpeedInsights() },
					enabled: status?.speedInsightsEnabled ?? true,
				}),
			]
		case "webAnalytics":
			return [
				webAnalyticsSection(h, {
					read: { data: model.webAnalytics.data, onRetry: Message.ClickedRetryWebAnalytics() },
					enabled: status?.webAnalyticsEnabled ?? true,
					compact: false,
				}),
			]
	}
}

/** `VercelProjectPage` below the top bar: the header, the tabs, then the active tab. */
export const projectPage = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const time = pickTimeSearch(model.search)
	const clock = { nowMs: model.nowMs, timeZone }
	return [header(h, model, time, clock), tabStrip(h, model, time), ...tabBody(h, model, time, clock)]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
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
				projectPage(h, model, inputs.context.timeZone),
			),
		],
	),
)
