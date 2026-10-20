import type {
	VercelAiGatewayBucket,
	VercelAiGatewayResponse,
	VercelDeploymentSummary,
} from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
import { ERROR_RATE_TEXT, errorRateLevel } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	aiGatewayProjectLabel,
	fillBuckets,
	zeroAiGatewayBucket,
} from "../../../components/infra/vercel/list-model"
import * as BarChart from "../../../charts/bar-chart"
import * as Chart from "../../../charts/chart"
import type { ChartRuntime } from "../../../charts/chart-runtime"
import type { ThemeColors } from "../../../charts/theme-colors"
import type { LoadFailure } from "../../../data/load-failure"
import type { TimeWindow } from "../../../data/time-range"
import { deploymentStateLabel, deploymentTone } from "../../../components/integrations/vercel-model"
import { AppRoute, hrefOf } from "../../../route"
import { chartLoading } from "../../../ui/chart-state"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { statusDot } from "../../../ui/status-dot"
import { columnHead, dataTable, ROW_LINK_CLASS } from "../../infra/kit/data-table"
import type { TimeSearch } from "../../infra/kit/view-tabs"
import { relativeTime } from "../../kit/relative-time"
import { sectionHeading } from "../../kit/section-heading"
import { docsLink, emptyActions } from "../../kit/signal-empty-state"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import { chartCard } from "../kit/chart-card"
import { seriesInput } from "./data"

// Pieces both Vercel pages draw: `DeploymentInline`, the rate formats and `VercelAiGatewayPanel`.

export type Clock = Readonly<{ nowMs: number; timeZone: string }>

/** A slot's data, or null while it loads or failed with nothing kept. */
export const dataOf = <A, E>(data: AsyncData.AsyncData<A, E>): A | null =>
	AsyncData.matchData(data, { onEmpty: () => null, onFailure: () => null, onData: (value) => value })

/** A failure with no data left to show; a refetch that failed over loaded data keeps the data. */
export const failureOf = <A>(data: AsyncData.AsyncData<A, LoadFailure>): LoadFailure | null =>
	dataOf(data) !== null
		? null
		: AsyncData.match(data, {
				onIdle: () => null,
				onLoading: () => null,
				onFailure: (failure) => failure,
				onStale: ({ error }) => error,
				onSuccess: () => null,
				onRefreshing: () => null,
			})

/** `aiGateway.timeseries` with the window's empty buckets filled. */
export const fillAiSeries = (rows: ReadonlyArray<VercelAiGatewayBucket>, window: TimeWindow | null) =>
	window === null ? rows : fillBuckets(rows, seriesInput(window), zeroAiGatewayBucket)

/** A 0–100 share as text, or the empty value without a denominator. */
export const percentText = (percent: number | null) =>
	percent === null ? EMPTY_VALUE : formatPercent(percent / 100)
export const errorText = (percent: number | null) =>
	percent === null ? EMPTY_VALUE : formatErrorRate(percent / 100)
export const errorTone = (percent: number | null) => errorRateLevel(percent === null ? 0 : percent / 100)

export const projectHref = (projectId: string, time: TimeSearch) =>
	hrefOf(AppRoute.InfraVercelProject({ projectId, search: time }))

/** State dot, state, branch and age of one deployment, on one line. */
export const deploymentInline = <M>(
	h: HtmlBuilder<M>,
	deployment: VercelDeploymentSummary,
	clock: Clock,
): Html =>
	h.span(
		[h.Class("flex min-w-0 items-center gap-1.5 text-2xs")],
		[
			statusDot(h, { tone: deploymentTone(deployment.state), size: "lg" }),
			h.span([h.Class("shrink-0 text-foreground/80")], [deploymentStateLabel(deployment.state)]),
			...(deployment.branch === null || deployment.branch === ""
				? []
				: [
						h.span(
							[h.Class("truncate font-mono text-muted-foreground"), h.Title(deployment.branch)],
							[deployment.branch],
						),
					]),
			relativeTime(h, {
				value: deployment.createdAt,
				...clock,
				variant: "short",
				mono: true,
				tooltip: "title",
				className: "shrink-0 text-muted-foreground",
			}),
		],
	)

/** Nothing went through AI Gateway in the window: what makes it show up. */
export const aiGatewayEmpty = <M>(h: HtmlBuilder<M>): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "SquareSparkleIcon", { size: 16 })]),
				emptyTitle(h, ["Requests through AI Gateway appear here"]),
				emptyDescription(h, [
					"Call a model through Vercel AI Gateway from a forwarded project. The traces drain carries each request's model, tokens and cost.",
				]),
			]),
			emptyContent(h, [emptyActions(h, [docsLink(h, "vercel", "How AI Gateway traces reach Maple")])]),
		],
		"rounded-md border border-dashed py-14",
	)

export const aiGatewayLoading = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("space-y-6")],
		[
			statRailLoading(h, 5, 5),
			h.div(
				[h.Class("grid grid-cols-1 gap-4 lg:grid-cols-2")],
				[
					chartLoading(h, { variant: "bar", height: 240 }),
					chartLoading(h, { variant: "bar", height: 240 }),
				],
			),
		],
	)

/** The bar charts' rows: one series per key besides `bucket`. */
export type BarRows = ReadonlyArray<Readonly<Record<string, string | number>>>

/** Draws one bar chart; the page owns the chart Submodels and the theme. */
export type BarChartSlot = (
	chartId: string,
	rows: BarRows,
	options: Readonly<{ unit?: string; stacked?: boolean }>,
) => Html

export const AI_GATEWAY_CHART_IDS = ["vercel-ai-spend", "vercel-ai-requests"] as const

type ChartState = Readonly<{
	charts: Readonly<Record<string, Chart.Model>>
	themeColors: ThemeColors | null
	chartRuntime: ChartRuntime
	nowMs: number
}>

/** A page's bar charts: one Chart Submodel each, a skeleton until the runtime and theme are in. */
export const barChartSlot =
	<M>(
		h: HtmlBuilder<M>,
		state: ChartState,
		toMessage: (chartId: string, message: Chart.Message) => M,
		timeZone: string,
	): BarChartSlot =>
	(chartId, rows, options) => {
		const theme = state.themeColors
		if (theme === null || state.chartRuntime._tag === "Loading")
			return chartLoading(h, { variant: "bar" })
		return h.submodel({
			slotId: chartId,
			model: state.charts[chartId] ?? Chart.init(),
			view: BarChart.view,
			toParentMessage: (message: Chart.Message) => toMessage(chartId, message),
			viewInputs: {
				chartId,
				data: rows,
				theme,
				timeZone,
				nowMs: state.nowMs,
				unit: options.unit,
				stacked: options.stacked,
				legend: "hidden",
				className: "h-full w-full",
			},
		})
	}

const ROW_CLASS = "flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0"
const NUM = "w-[96px] text-right font-mono text-xs tabular-nums text-foreground/80"

const errorRate = (errors: number, requests: number) => (requests > 0 ? errors / requests : 0)

type Usage = Readonly<{
	requests: number
	costUsd: number
	inputTokens: number
	outputTokens: number
	errors: number
}>

const usageCells = <M>(h: HtmlBuilder<M>, usage: Usage): ReadonlyArray<Html> => {
	const rate = errorRate(usage.errors, usage.requests)
	return [
		h.div([h.Class(NUM)], [formatNumber(usage.requests)]),
		h.div([h.Class(cn(NUM, "font-medium text-foreground"))], [formatCost(usage.costUsd)]),
		h.div([h.Class(cn(NUM, "hidden md:block"))], [formatNumber(usage.inputTokens)]),
		h.div([h.Class(cn(NUM, "hidden md:block"))], [formatNumber(usage.outputTokens)]),
		h.div(
			[h.Class(cn(NUM, ERROR_RATE_TEXT[errorRateLevel(rate)]))],
			[usage.errors === 0 ? "0" : `${formatNumber(usage.errors)} · ${formatErrorRate(rate)}`],
		),
	]
}

const usageHeads = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	columnHead(h, { label: "Requests", width: "w-[96px]", align: "right" }),
	columnHead(h, { label: "Spend", width: "w-[96px]", align: "right" }),
	columnHead(h, { label: "Input tokens", width: "w-[96px]", align: "right", hidden: "hidden md:flex" }),
	columnHead(h, { label: "Output tokens", width: "w-[96px]", align: "right", hidden: "hidden md:flex" }),
	columnHead(h, { label: "Errors", width: "w-[96px]", align: "right" }),
]

const bySpend = <T extends Usage>(rows: ReadonlyArray<T>): ReadonlyArray<T> =>
	[...rows].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests)

const modelsTable = <M>(h: HtmlBuilder<M>, models: VercelAiGatewayResponse["models"]): Html =>
	h.section(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, { title: "By model", hint: "most spend first", count: String(models.length) }),
			dataTable(
				h,
				{ ariaLabel: "AI Gateway models" },
				[
					columnHead(h, { label: "Model", width: "w-0 flex-1 min-w-[220px]" }),
					...usageHeads(h),
					columnHead(h, { label: "p95", width: "w-[80px]", align: "right" }),
				],
				bySpend(models).map((model) =>
					h.div(
						[h.Key(`${model.provider}:${model.model}`), h.Class(ROW_CLASS)],
						[
							h.div(
								[h.Class("flex w-0 min-w-[220px] flex-1 items-baseline gap-2")],
								[
									h.span(
										[
											h.Class("truncate font-mono text-xs font-medium text-foreground"),
											h.Title(model.model),
										],
										[model.model],
									),
									...(model.provider === ""
										? []
										: [
												h.span(
													[
														h.Class(
															"shrink-0 font-mono text-3xs text-muted-foreground",
														),
													],
													[model.provider],
												),
											]),
								],
							),
							...usageCells(h, model),
							h.div(
								[
									h.Class(
										"w-[80px] text-right font-mono text-xs tabular-nums text-foreground/80",
									),
								],
								[
									model.p95DurationMs === null
										? EMPTY_VALUE
										: formatLatency(model.p95DurationMs),
								],
							),
						],
					),
				),
			),
		],
	)

const projectsTable = <M>(
	h: HtmlBuilder<M>,
	projects: VercelAiGatewayResponse["projects"],
	projectNames: ReadonlyMap<string, string>,
	time: TimeSearch,
): Html => {
	const name = (projectId: string) =>
		h.div(
			[h.Class("w-0 min-w-[220px] flex-1")],
			[
				h.span(
					[
						h.Class(
							cn(
								"block truncate font-mono text-xs font-medium",
								projectId === ""
									? "text-muted-foreground"
									: "text-foreground transition-colors group-hover:text-primary",
							),
						),
					],
					[aiGatewayProjectLabel(projectId, projectNames)],
				),
			],
		)
	return h.section(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, {
				title: "By project",
				hint: "most spend first",
				count: String(projects.length),
			}),
			dataTable(
				h,
				{ ariaLabel: "AI Gateway projects" },
				[columnHead(h, { label: "Project", width: "w-0 flex-1 min-w-[220px]" }), ...usageHeads(h)],
				bySpend(projects).map((project) =>
					project.projectId === ""
						? h.div([h.Key(""), h.Class(ROW_CLASS)], [name(""), ...usageCells(h, project)])
						: h.a(
								[
									h.Key(project.projectId),
									h.Class(ROW_LINK_CLASS),
									h.Href(projectHref(project.projectId, time)),
								],
								[name(project.projectId), ...usageCells(h, project)],
							),
				),
			),
		],
	)
}

const charts = <M>(
	h: HtmlBuilder<M>,
	timeseries: ReadonlyArray<VercelAiGatewayBucket>,
	bar: BarChartSlot,
): Html =>
	h.div(
		[h.Class("grid grid-cols-1 gap-4 lg:grid-cols-2")],
		[
			chartCard(
				h,
				{ title: "Spend", description: "AI Gateway's cost per request, summed per bucket" },
				[
					h.div(
						[h.Class("h-[200px] w-full px-1 pb-2")],
						[
							bar(
								AI_GATEWAY_CHART_IDS[0],
								timeseries.map((row) => ({ bucket: row.bucket, Spend: row.costUsd })),
								{ unit: "usd" },
							),
						],
					),
				],
			),
			chartCard(h, { title: "Requests", description: "Failed: the gateway returned an error" }, [
				h.div(
					[h.Class("h-[200px] w-full px-1 pb-2")],
					[
						bar(
							AI_GATEWAY_CHART_IDS[1],
							timeseries.map((row) => ({
								bucket: row.bucket,
								Succeeded: row.requests - row.errors,
								Failed: row.errors,
							})),
							{ stacked: true },
						),
					],
				),
			]),
		],
	)

export type AiGatewayPanelInputs = Readonly<{
	data: VercelAiGatewayResponse
	/** `data.timeseries` with the window's empty buckets filled. */
	timeseries: ReadonlyArray<VercelAiGatewayBucket>
	projectNames: ReadonlyMap<string, string>
	time: TimeSearch
	bar: BarChartSlot
}>

/** `VercelAiGatewayPanel`: summary, spend and request charts, then usage by model and by project. */
export const aiGatewayPanel = <M>(h: HtmlBuilder<M>, inputs: AiGatewayPanelInputs): Html => {
	const { summary } = inputs.data
	const rate = errorRate(summary.errors, summary.requests)
	const series = inputs.timeseries
	return h.div(
		[h.Class("space-y-6")],
		[
			statRail(h, { columns: 5 }, [
				statRailItem(h, {
					eyebrow: "Spend",
					value: formatCost(summary.costUsd),
					spark: series.map((row) => row.costUsd),
					subline:
						summary.requests > 0
							? `${formatCost(summary.costUsd / summary.requests)} per request`
							: undefined,
				}),
				statRailItem(h, {
					eyebrow: "Requests",
					value: formatNumber(summary.requests),
					spark: series.map((row) => row.requests),
					subline: `${inputs.data.models.length} ${inputs.data.models.length === 1 ? "model" : "models"}`,
				}),
				statRailItem(h, {
					eyebrow: "Tokens",
					value: formatNumber(summary.inputTokens),
					hint: "in",
					spark: series.map((row) => row.inputTokens + row.outputTokens),
					subline: `${formatNumber(summary.outputTokens)} out`,
				}),
				statRailItem(h, {
					eyebrow: "Error rate",
					value: formatErrorRate(rate),
					tone: errorRateLevel(rate),
					spark: series.map((row) => row.errors),
					subline: `${formatNumber(summary.errors)} failed`,
				}),
				statRailItem(h, {
					eyebrow: "p95 latency",
					value:
						summary.p95DurationMs === null ? EMPTY_VALUE : formatLatency(summary.p95DurationMs),
					compact: true,
					subline:
						summary.p50DurationMs === null
							? undefined
							: `p50 ${formatLatency(summary.p50DurationMs)}`,
				}),
			]),
			charts(h, series, inputs.bar),
			modelsTable(h, inputs.data.models),
			...(inputs.data.projects.length > 0
				? [projectsTable(h, inputs.data.projects, inputs.projectNames, inputs.time)]
				: []),
		],
	)
}
