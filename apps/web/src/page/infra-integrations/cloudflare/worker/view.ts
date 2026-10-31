import { WORKER_HEALTH_TONE, workerHealth } from "../../../../components/infra/cloudflare/list-model"
import {
	DURABLE_OBJECT_COLORS,
	durableObjectRows,
	FAILURE_COLORS,
	failureRows,
	invocationRows,
	outcomeLabel,
	percentileRows,
	untracedExceptions,
	workerOutcomeTotals,
} from "../../../../components/infra/cloudflare/worker-signals"
import {
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import * as InfraMetricChart from "../../../../charts/infra-metric-chart"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { ResolveThemeColors, type ThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { detailRailGroup, detailRailMetaRow } from "../../../../ui/detail-rail"
import { errorState } from "../../../../ui/error-state"
import { segmentedBar } from "../../../../ui/meter"
import { panel, panelHeader } from "../../../../ui/panel"
import { skeleton } from "../../../../ui/skeleton"
import { statusDot } from "../../../../ui/status-dot"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { correlationStrips, type StripSeries } from "../../../infra/kit/correlation-strips"
import { heroChip } from "../../../infra/kit/hero-chip"
import { pageHeroParts } from "../../../infra/kit/page-parts"
import { pageTime } from "../../kit/page-time"
import { formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import type { WorkerDetail } from "../data"
import { MountLinkedCursor } from "./command"
import { type PageData, pageOf, type Traced } from "./derive"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET } from "./update"

// `WorkerDetailPage` and its parts.

type H = HtmlBuilder<Message>

/** The failure and Durable Object strips name `--severity-fatal` and `--chart-2` too. */
const THEME_TOKENS = [...INFRA_CHART_TOKENS, "--severity-fatal", "--chart-2"]

/** `CloudflareWorkerHeader`. */
const header = (h: H, model: Model, data: PageData) => {
	const { row, accountName, traced, currentVersion } = data
	const tracedService = traced?.service ?? null
	return pageHeroParts(h, {
		title: h.span(
			[h.Class("flex items-center gap-3")],
			[
				...(row === null
					? []
					: [statusDot(h, { tone: WORKER_HEALTH_TONE[workerHealth(row)], size: "lg" })]),
				model.scriptName,
			],
		),
		meta: [
			heroChip(h, "worker"),
			...(accountName === null ? [] : [heroChip(h, ["account ", accountName])]),
			tracedService === null
				? heroChip(h, "no traces matched")
				: h.a(
						[h.Href(hrefOf(AppRoute.Service({ serviceName: tracedService, search: {} })))],
						[heroChip(h, ["traced as ", tracedService])],
					),
			...(currentVersion === null ? [] : [heroChip(h, ["version ", shortId(currentVersion, "sha")])]),
		],
	})
}

const figure = (h: H, value: string, caption: string, className?: string): Html =>
	h.div(
		[h.Class("flex flex-col items-start @2xl:items-end")],
		[
			h.span(
				[h.Class(cn("font-mono text-sm font-semibold tabular-nums text-foreground", className))],
				[value],
			),
			h.span([h.Class("font-mono text-3xs text-muted-foreground")], [caption]),
		],
	)

/** `CloudflareTraceGapCallout`: failures Cloudflare saw that the Worker's spans never recorded. */
const traceGapCallout = (h: H, exceptions: number, tracedErrors: number, tracedService: string): Html =>
	h.div(
		[h.Class("@container rounded-md border border-severity-error-a4")],
		[
			h.div(
				[h.Class("flex flex-col @2xl:flex-row @2xl:items-center")],
				[
					h.div(
						[h.Class("flex-1 space-y-1 px-4 py-3")],
						[
							h.p(
								[h.Class("text-sm font-medium text-foreground")],
								[
									formatNumber(exceptions),
									" exceptions in Cloudflare,",
									" ",
									tracedErrors === 0 ? "none" : formatNumber(tracedErrors),
									" in traces",
								],
							),
							h.p(
								[h.Class("max-w-prose text-xs text-muted-foreground")],
								[
									"These invocations most likely threw before ",
									tracedService,
									" exported a span, so tracing never saw them.",
								],
							),
						],
					),
					h.div(
						[
							h.Class(
								"flex items-center gap-6 border-t px-4 py-3 @2xl:self-stretch @2xl:border-t-0 @2xl:border-l @2xl:px-5",
							),
						],
						[
							figure(h, formatNumber(exceptions), "Cloudflare", "text-severity-error"),
							figure(h, formatNumber(tracedErrors), "traces"),
							h.a(
								[
									h.Class(
										"ml-auto font-mono text-xs text-primary hover:text-primary active:text-primary @2xl:ml-0",
									),
									h.Href(hrefOf(AppRoute.Logs({ search: { services: [tracedService] } }))),
								],
								["Logs in this window"],
							),
						],
					),
				],
			),
		],
	)

const summary = (
	h: H,
	value: string,
	caption?: string,
	valueClassName?: string,
	captionClassName?: string,
): ReadonlyArray<Html> => [
	h.span(
		[h.Class(cn("font-mono text-sm font-semibold tabular-nums text-foreground", valueClassName))],
		[value],
	),
	...(caption === undefined
		? []
		: [h.span([h.Class(cn("font-mono text-3xs text-muted-foreground", captionClassName))], [caption])]),
]

/** `buildStrips`: invocations, failures, CPU and duration, then Durable Objects when bound. */
const buildStrips = (h: H, detail: WorkerDetail, data: PageData): ReadonlyArray<StripSeries> => {
	const { row } = data
	const totals = workerOutcomeTotals(detail.outcomeBuckets)
	const failureRate = totals.invocations > 0 ? totals.failures / totals.invocations : 0
	const strips: ReadonlyArray<StripSeries> = [
		{
			id: "cf-invocations",
			label: "Invocations",
			source: "all outcomes",
			rows: invocationRows(detail.outcomeBuckets),
			unit: "count",
			summary: summary(
				h,
				formatNumber(totals.invocations),
				`${formatPercent(totals.invocations > 0 ? 1 - failureRate : 0)} success`,
			),
		},
		{
			id: "cf-failures",
			label: "Failures",
			source: "by how they ended",
			rows: failureRows(detail.outcomeBuckets),
			unit: "count",
			colors: FAILURE_COLORS,
			summary: summary(
				h,
				formatNumber(totals.failures),
				formatErrorRate(failureRate),
				totals.failures > 0 ? "text-severity-error" : undefined,
			),
		},
		{
			id: "cf-cpu",
			label: "CPU time",
			source: "p99 and p50",
			rows: percentileRows(detail.latencyBuckets, (b) => [b.cpuP50Ms, b.cpuP99Ms]),
			unit: "milliseconds",
			summary: summary(
				h,
				row !== null && row.cpuP99Ms > 0 ? formatLatency(row.cpuP99Ms) : EMPTY_VALUE,
				"p99",
			),
		},
		{
			id: "cf-duration",
			label: "Duration",
			source: "wall time, p99 and p50",
			rows: percentileRows(detail.latencyBuckets, (b) => [b.durationP50Ms, b.durationP99Ms]),
			unit: "milliseconds",
			summary: summary(
				h,
				row !== null && row.durationP99Ms > 0 ? formatLatency(row.durationP99Ms) : EMPTY_VALUE,
				"p99",
			),
		},
	]
	if (!detail.durableObjectBuckets.some((b) => b.requests > 0)) return strips
	const calls = detail.durableObjectBuckets.reduce((acc, b) => acc + b.requests, 0)
	const errors = detail.durableObjectBuckets.reduce((acc, b) => acc + b.errors, 0)
	return [
		...strips,
		{
			id: "cf-do-calls",
			label: "Durable Objects",
			source: "calls and errors",
			rows: durableObjectRows(detail.durableObjectBuckets),
			unit: "count",
			colors: DURABLE_OBJECT_COLORS,
			summary: summary(
				h,
				formatNumber(calls),
				`${formatErrorRate(calls > 0 ? errors / calls : 0)} failed`,
				undefined,
				errors / Math.max(calls, 1) >= 0.01 ? "text-severity-error" : undefined,
			),
		},
		{
			id: "cf-do-wall",
			label: "DO wall time",
			source: "p99 and p50",
			rows: percentileRows(detail.latencyBuckets, (b) => [b.doWallP50Ms, b.doWallP99Ms]),
			unit: "milliseconds",
		},
	]
}

const signals = (
	h: H,
	model: Model,
	detail: WorkerDetail,
	data: PageData,
	ctx: Readonly<{ theme: ThemeColors; timeZone: string }>,
	isWaiting: boolean,
): Html =>
	correlationStrips(h, {
		strips: buildStrips(h, detail, data),
		xDomain: [
			...new Set(
				[...detail.outcomeBuckets, ...detail.latencyBuckets, ...detail.durableObjectBuckets].map(
					(b) => b.bucket,
				),
			),
		].toSorted(),
		markers: data.markers,
		isWaiting,
		theme: ctx.theme,
		timeZone: ctx.timeZone,
		mountCursor: h.OnMount(MountLinkedCursor()),
		chart: (chartId, inputs) =>
			h.submodel({
				slotId: chartId,
				model: model.charts[chartId] ?? Chart.init(),
				view: InfraMetricChart.view,
				toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ chartId, message }),
				viewInputs: { ...inputs, chartId },
			}),
	})

/** `CloudflareWorkerOutcomes`: how each invocation ended, per Cloudflare. */
const outcomes = (h: H, detail: WorkerDetail): Html => {
	const totals = workerOutcomeTotals(detail.outcomeBuckets)
	return panel(h, {}, [
		panelHeader(h, { title: "Outcomes" }),
		h.div(
			[h.Class("divide-y divide-border-subtle")],
			totals.byStatus.map(({ status, count }) => {
				const success = status === "success"
				const share = totals.invocations > 0 ? count / totals.invocations : 0
				const label = outcomeLabel(status)
				return h.div(
					[h.Key(status), h.Class("flex items-center gap-4 px-4 py-2.5")],
					[
						h.span([
							h.AriaHidden(true),
							h.Class(
								cn(
									"size-2 shrink-0 rounded-sm",
									success ? "bg-severity-info" : "bg-severity-error",
								),
							),
						]),
						h.div(
							[h.Class("flex min-w-0 flex-1 items-baseline gap-2")],
							[
								h.span([h.Class("truncate text-xs text-foreground")], [label]),
								...(label.toLowerCase() === status.toLowerCase()
									? []
									: [
											h.span(
												[
													h.Class(
														"truncate font-mono text-3xs text-muted-foreground",
													),
												],
												[status],
											),
										]),
							],
						),
						segmentedBar(h, {
							className: "w-48 shrink-0",
							minVisible: 1,
							total: totals.invocations,
							segments: [
								{
									key: status,
									value: count,
									className: success ? "bg-foreground-subtle" : "bg-severity-error",
								},
							],
						}),
						h.span(
							[h.Class("w-20 text-right font-mono text-xs tabular-nums text-foreground-soft")],
							[formatNumber(count)],
						),
						h.span(
							[
								h.Class(
									cn(
										"w-16 text-right font-mono text-xs tabular-nums",
										success ? "text-muted-foreground" : "text-severity-error",
									),
								),
							],
							[formatErrorRate(share)],
						),
					],
				)
			}),
		),
	])
}

/** `CloudflareWorkerRail`. */
const rail = (h: H, data: PageData, timeZone: string): Html => {
	const { row, traced } = data
	const deploys = data.markers.map((marker) => ({ commitSha: marker.id, firstSeen: marker.at }))
	const present = (nodes: ReadonlyArray<Html | null>) => nodes.filter((node): node is Html => node !== null)
	return h.div(
		[h.Class("flex flex-col")],
		[
			detailRailGroup(
				h,
				"Worker",
				present([
					detailRailMetaRow(h, { icon: "UserIcon", label: "account", value: data.accountName }),
					detailRailMetaRow(h, {
						icon: "ServerIcon",
						label: "durable objects",
						value:
							row === null
								? null
								: row.doRequests > 0
									? `${formatNumber(row.doRequests)} calls`
									: "none bound",
					}),
					detailRailMetaRow(h, {
						icon: "StopwatchIcon",
						label: "cpu p50",
						value: row !== null && row.cpuP50Ms > 0 ? formatLatency(row.cpuP50Ms) : null,
					}),
				]),
			),
			detailRailGroup(
				h,
				"Deploys in window",
				deploys.length === 0
					? [h.p([h.Class("text-2xs text-muted-foreground")], ["No new version in this window."])]
					: present(
							deploys.map((deploy) =>
								detailRailMetaRow(h, {
									icon: "CodeIcon",
									label: shortId(deploy.commitSha, "sha"),
									value: formatTimeInTimezone(deploy.firstSeen, { timeZone }),
								}),
							),
						),
			),
			detailRailGroup(h, "Traces", tracesRail(h, traced)),
		],
	)
}

const tracesRail = (h: H, traced: Traced | null): ReadonlyArray<Html> =>
	traced === null
		? [
				h.p(
					[h.Class("text-2xs leading-relaxed text-muted-foreground")],
					["No service with this name sends spans, so Cloudflare's counts are all there is."],
				),
			]
		: [
				...[
					detailRailMetaRow(h, {
						icon: "PulseIcon",
						label: "spans",
						value: formatNumber(traced.spans),
					}),
					detailRailMetaRow(h, {
						icon: "PulseIcon",
						label: "error spans",
						value: formatNumber(traced.errors),
					}),
				].filter((node): node is Html => node !== null),
				h.a(
					[
						h.Class("pt-1 font-mono text-xs text-primary hover:text-primary active:text-primary"),
						h.Href(hrefOf(AppRoute.Service({ serviceName: traced.service, search: {} }))),
					],
					["Open ", traced.service],
				),
			]

const body = (
	h: H,
	model: Model,
	data: PageData,
	ctx: Readonly<{ theme: ThemeColors; timeZone: string }> | null,
): Html => {
	const loading = h.div([h.Class("space-y-6")], [skeleton(h, "h-96 w-full"), skeleton(h, "h-32 w-full")])
	const loaded = (detail: WorkerDetail, isWaiting: boolean): Html => {
		if (ctx === null) return loading
		const exceptions = workerOutcomeTotals(detail.outcomeBuckets).exceptions
		const untraced = untracedExceptions(exceptions, data.traced?.errors ?? null)
		return h.div(
			[h.Class("space-y-6")],
			[
				...(untraced === null || data.traced === null
					? []
					: [traceGapCallout(h, exceptions, data.traced.errors, data.traced.service)]),
				signals(h, model, detail, data, ctx, isWaiting),
				outcomes(h, detail),
			],
		)
	}
	return AsyncData.match(model.detail.data, {
		onIdle: () => loading,
		onLoading: () => loading,
		onFailure: (failure) => errorState(h, { failure }),
		onStale: ({ error }) => errorState(h, { failure: error }),
		onSuccess: (detail) => loaded(detail, false),
		onRefreshing: (detail) => loaded(detail, true),
	})
}

/** `WorkerDetailPage` below the top bar; the lab's has no time controls. */
export const workerPage = (h: H, model: Model, timeZone: string, isTimed = true): Html => {
	const data = pageOf(model)
	const theme = model.themeColors
	const ctx = theme === null || model.chartRuntime._tag === "Loading" ? null : { theme, timeZone }
	const hero = header(h, model, data)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					gap: "lg",
					titleContent: hero.title,
					actions: !isTimed
						? undefined
						: pageTime(h, {
								search: model.search,
								defaultPreset: DEFAULT_PRESET,
								window: model.window,
								picker: model.timePicker,
								toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
								onReset: Message.ClickedResetTimeRange(),
								onReload: Message.ClickedReload(),
								isReloading: model.isReloading,
							}),
					rightPanel: rail(h, data, timeZone),
				},
				[hero.body, body(h, model, data, ctx)],
			),
		],
	)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	workerPage(h, model, inputs.context.timeZone),
)
