import type {
	VercelDeploymentSummary,
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
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { STATUS_CLASS_COLORS } from "../../../../components/infra/cloudflare/constants"
import {
	fillBuckets,
	requestClassRows,
	vercelProjectLogAttrs,
	vercelProjectRow,
	vercelProjectTracesWhere,
	type VercelProjectRow,
	zeroRequestBucket,
} from "../../../../components/infra/vercel/list-model"
import {
	deploymentStateLabel,
	deploymentTone,
	percentOf,
} from "../../../../components/integrations/vercel-model"
import * as BarChart from "../../../../charts/bar-chart"
import * as Chart from "../../../../charts/chart"
import { CHART_EMPTY_MESSAGE } from "../../../../charts/infra-metric-chart"
import * as InfraMetricChart from "../../../../charts/infra-metric-chart"
import { INFRA_CHART_TOKENS, type LongRow } from "../../../../charts/infra-metric-series"
import * as PlotBoxChart from "../../../../charts/plot-box-chart"
import { stackedBreakdown } from "../../../../charts/stacked-breakdown-chart"
import { ResolveThemeColors, type ThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { linkButton } from "../../../../ui/button"
import { chartLoading } from "../../../../ui/chart-state"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { skeleton } from "../../../../ui/skeleton"
import { statusDot } from "../../../../ui/status-dot"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { relativeTime } from "../../../kit/relative-time"
import { sectionHeading } from "../../../kit/section-heading"
import { seriesLegend } from "../../../kit/series-legend"
import { statRail, statRailItem, statRailLoading } from "../../../kit/stat-rail"
import { heroChip } from "../../../infra/kit/hero-chip"
import { columnHead, dataTable, dataTableEmpty, skeletonRows } from "../../../infra/kit/data-table"
import { pageHero } from "../../../infra/kit/page-parts"
import { pickTimeSearch, type TimeSearch } from "../../../infra/kit/view-tabs"
import { CHART_HEIGHT, chartCard, chartCardMessage } from "../../kit/chart-card"
import { pageTime } from "../../kit/page-time"
import { DEFAULT_PRESET, seriesInput } from "../data"
import {
	aiGatewayPanel,
	barChartSlot,
	type BarChartSlot,
	type Clock,
	dataOf,
	deploymentInline,
	failureOf,
	fillAiSeries,
} from "../view-parts"
import { Message, type Model } from "./model"

// `VercelProjectPage`.

type H = HtmlBuilder<Message>

const THEME_TOKENS = [...INFRA_CHART_TOKENS, "--chart-2", ...BarChart.BAR_CHART_TOKENS]
const STATUS_ORDER = ["2xx", "3xx", "4xx", "5xx", "unknown"]
const ROW_CLASS = "flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0"
const NUM = "text-right font-mono text-xs tabular-nums text-foreground/80"

const rate = (part: number, whole: number) => (percentOf(part, whole) ?? 0) / 100

/** The inventory's view of the project; null while loading, failed, or when it is not listed. */
export const projectStatusOf = (model: Model): VercelProjectStatus | null =>
	dataOf(model.status.data)?.projects.find((project) => project.id === model.projectId) ?? null

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
			spark: buckets.map((bucket) => bucket.requests),
			subline:
				row.lastSeen === null
					? "none in this window"
					: relativeTime(h, { value: row.lastSeen, ...clock, prefix: "last", tooltip: "title" }),
		}),
		statRailItem(h, {
			eyebrow: "5xx rate",
			value: row.errorPercent === null ? EMPTY_VALUE : formatErrorRate(errorFraction),
			tone: errorRateLevel(errorFraction),
			spark: buckets.map((bucket) => bucket.requests5xx),
			subline: `${formatNumber(row.requests5xx)} server errors`,
		}),
		statRailItem(h, {
			eyebrow: "Cache hits",
			value: row.cacheHitPercent === null ? EMPTY_VALUE : formatPercent(row.cacheHitPercent / 100),
			spark: buckets.map((bucket) => bucket.cacheHits),
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
			spark: buckets.map((bucket) => bucket.errorLogs),
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
				items: built.legend.map(({ name, label, color }) => ({
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
	const xDomain = buckets.map((bucket) => bucket.bucket)
	const single = (pick: (bucket: VercelInfraRequestBucket) => number): ReadonlyArray<LongRow> =>
		buckets.map((bucket) => ({ bucket: bucket.bucket, attributeValue: "value", value: pick(bucket) }))
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
					? [dataTableEmpty(h, ["No requests in this window."])]
					: paths.map((path) => {
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
					columnHead(h, { label: "Message", width: "w-0 flex-1 min-w-[200px]" }),
					columnHead(h, { label: "Count", width: "w-[64px]", align: "right" }),
					columnHead(h, { label: "Last seen", width: "w-[72px]", align: "right" }),
				],
				errors.length === 0
					? [dataTableEmpty(h, ["No error logs in this window."])]
					: errors.map((error) =>
							h.div(
								[h.Key(`${error.source}:${error.message}`), h.Class(ROW_CLASS)],
								[
									h.div(
										[h.Class("flex w-0 min-w-[200px] flex-1 items-baseline gap-2")],
										[
											...(error.source === ""
												? []
												: [
														h.span(
															[
																h.Class(
																	"shrink-0 rounded-sm bg-muted px-1 font-mono text-3xs text-muted-foreground",
																),
															],
															[error.source],
														),
													]),
											h.span(
												[
													h.Class("truncate font-mono text-xs text-foreground"),
													h.Title(error.message),
												],
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
												tooltip: "title",
												className: "text-2xs text-muted-foreground",
											}),
										],
									),
								],
							),
						),
			),
		],
	)

const deploymentRow = (h: H, deployment: VercelDeploymentSummary, clock: Clock): Html =>
	h.div(
		[h.Key(deployment.id), h.Class(ROW_CLASS)],
		[
			h.span(
				[h.Class("flex w-[104px] items-center gap-1.5 text-xs")],
				[
					statusDot(h, { tone: deploymentTone(deployment.state), size: "lg" }),
					deploymentStateLabel(deployment.state),
				],
			),
			h.span(
				[h.Class("hidden w-[88px] text-2xs text-muted-foreground md:block")],
				[deployment.target ?? "preview"],
			),
			h.span(
				[h.Class("flex w-0 min-w-[260px] flex-1 items-baseline gap-2")],
				[
					...(deployment.branch === null || deployment.branch === ""
						? []
						: [
								h.span(
									[
										h.Class(
											"max-w-[40%] shrink-0 truncate font-mono text-2xs text-foreground/80",
										),
									],
									[deployment.branch],
								),
							]),
					h.span(
						[
							h.Class("truncate text-xs text-foreground"),
							...(deployment.commitMessage === null ? [] : [h.Title(deployment.commitMessage)]),
						],
						[deployment.commitMessage?.split("\n")[0] ?? deployment.url],
					),
					...(deployment.commitSha === null || deployment.commitSha === ""
						? []
						: [
								h.span(
									[h.Class("shrink-0 font-mono text-3xs text-muted-foreground")],
									[deployment.commitSha.slice(0, 7)],
								),
							]),
				],
			),
			h.span(
				[h.Class("hidden w-[120px] truncate text-2xs text-muted-foreground lg:block")],
				[deployment.creator ?? EMPTY_VALUE],
			),
			h.span(
				[h.Class("w-[72px] text-right")],
				[
					relativeTime(h, {
						value: deployment.createdAt,
						...clock,
						variant: "short",
						mono: true,
						tooltip: "title",
						className: "text-2xs text-muted-foreground",
					}),
				],
			),
			h.span(
				[h.Class("flex w-[16px] justify-end")],
				deployment.inspectorUrl === null
					? []
					: [
							h.a(
								[
									h.Href(deployment.inspectorUrl),
									h.Target("_blank"),
									h.Rel("noopener noreferrer"),
									h.AriaLabel("Open in Vercel"),
									h.Title("Open in Vercel"),
									h.Class("text-muted-foreground hover:text-foreground"),
								],
								[icon(h, "ExternalLinkIcon", { size: 12 })],
							),
						],
			),
		],
	)

const deployments = (h: H, model: Model, clock: Clock): Html => {
	const rows = dataOf(model.deployments.data)
	const failure = failureOf(model.deployments.data)
	return h.section(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, {
				title: "Deployments",
				hint: "newest first, from Vercel's API",
				count: rows === null ? undefined : String(rows.length),
			}),
			dataTable(
				h,
				{ ariaLabel: "Deployments" },
				[
					columnHead(h, { label: "State", width: "w-[104px]" }),
					columnHead(h, { label: "Target", width: "w-[88px]", hidden: "hidden md:flex" }),
					columnHead(h, { label: "Commit", width: "w-0 flex-1 min-w-[260px]" }),
					columnHead(h, { label: "By", width: "w-[120px]", hidden: "hidden lg:flex" }),
					columnHead(h, { label: "Created", width: "w-[72px]", align: "right" }),
					columnHead(h, { label: "", width: "w-[16px]" }),
				],
				failure !== null
					? [
							errorState(h, {
								failure,
								title: "Failed to load deployments",
								onRetry: Message.ClickedRetryDeployments(),
								variant: "inline",
								className: "px-4",
							}),
						]
					: rows === null
						? skeletonRows(h, 3, () => [skeleton(h, "h-3 w-full")])
						: rows.length === 0
							? [
									dataTableEmpty(h, [
										"No deployments recorded yet. Maple reads them from Vercel every few minutes.",
									]),
								]
							: rows.map((deployment) => deploymentRow(h, deployment, clock)),
			),
		],
	)
}

const AI_HINT = "requests this project made through Vercel AI Gateway"

const aiGatewaySection = (h: H, model: Model, time: TimeSearch, bar: BarChartSlot): ReadonlyArray<Html> => {
	const failure = failureOf(model.aiGateway.data)
	const data = dataOf(model.aiGateway.data)
	const heading = sectionHeading(h, { title: "AI Gateway", hint: AI_HINT })
	if (failure !== null)
		return [
			h.section(
				[h.Class("space-y-3")],
				[
					heading,
					errorState(h, {
						failure,
						title: "Failed to load AI Gateway usage",
						onRetry: Message.ClickedRetryAiGateway(),
					}),
				],
			),
		]
	if (data === null || data.summary.requests === 0) return []
	return [
		h.section(
			[h.Class("space-y-3")],
			[
				heading,
				aiGatewayPanel(h, {
					data,
					timeseries: fillAiSeries(data.timeseries, model.window),
					projectNames: new Map(),
					time,
					bar,
				}),
			],
		),
	]
}

const requestsSection = (h: H, model: Model, clock: Clock): ReadonlyArray<Html> => {
	const failure = failureOf(model.projects.data) ?? failureOf(model.buckets.data)
	if (failure !== null)
		return [
			errorState(h, {
				failure,
				title: "Failed to load this project's requests",
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
				title: "Failed to load top paths and errors",
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
				? [h.span([h.Class("text-2xs text-muted-foreground")], ["No production deployment recorded"])]
				: [
						h.span([h.Class("text-2xs text-muted-foreground")], ["Production"]),
						deploymentInline(h, production, clock),
						h.a(
							[
								h.Href(`https://${production.url}`),
								h.Target("_blank"),
								h.Rel("noopener noreferrer"),
								h.Class(
									"inline-flex items-center gap-1 font-mono text-2xs text-muted-foreground hover:text-foreground",
								),
							],
							[production.url, icon(h, "ExternalLinkIcon", { size: 10 })],
						),
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

/** `VercelProjectPage` below the top bar. */
export const projectPage = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const time = pickTimeSearch(model.search)
	const clock = { nowMs: model.nowMs, timeZone }
	return [
		header(h, model, time, clock),
		...requestsSection(h, model, clock),
		...detailSection(h, model, clock),
		deployments(h, model, clock),
		...aiGatewaySection(
			h,
			model,
			time,
			barChartSlot(
				h,
				model,
				(chartId, message) => Message.GotChartMessage({ chartId, message }),
				timeZone,
			),
		),
	]
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
