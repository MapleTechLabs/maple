import { AWS_INFRA_KINDS, type AwsInfraKindId } from "@maple/domain/aws-infra"
import {
	EMPTY_VALUE,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatPercent,
	formatRate,
	formatUptime,
} from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { linkButton } from "../../../../ui/button"
import { chartError, chartLoading } from "../../../../ui/chart-state"
import { badge } from "../../../../ui/display"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { panel, panelHeader } from "../../../../ui/panel"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { statRail, statRailItem, statRailLoading } from "../../../kit/stat-rail"
import { pageHero } from "../../../infra/kit/page-parts"
import { integrationNotConnected } from "../../kit/empty-states"
import { metricChartCards, metricChartsLoading } from "../../kit/metric-charts"
import { pageTime } from "../../kit/page-time"
import type { BucketPoint, TracedService } from "../data"
import { HOT, type Judgement, judge, perMinute, tracedAs } from "../derive"
import { type BucketRow, bucketRows, CHARTS, type Figure, figureOf } from "./charts"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"

// `/infra/aws/$kind/$name`: one resource's CloudWatch metrics, and the service it runs as.

type H = HtmlBuilder<Message>

const MUTED = "text-muted-foreground"

type Tile = Readonly<{
	eyebrow: string
	value: string
	subline: string
	tone?: Tone
	spark?: ReadonlyArray<number>
}>

type TileContext = Readonly<{ windowMs: number }>

const percentTile = (eyebrow: string, figure: Figure | null): Tile => ({
	eyebrow,
	value: figure === null ? EMPTY_VALUE : formatPercent(figure.value / 100),
	subline: figure === null ? "not reported" : `peak ${formatPercent(figure.peak / 100)}`,
	tone: figure !== null && figure.value / 100 >= HOT ? "warn" : undefined,
	spark: figure?.trend,
})

const perMinuteTile = (eyebrow: string, figure: Figure | null, context: TileContext): Tile => ({
	eyebrow,
	value: figure === null ? EMPTY_VALUE : formatRate(perMinute(figure.value, context.windowMs)),
	subline: figure === null ? "not reported" : `${formatRate(figure.value)} in the window`,
	spark: figure?.trend,
})

const rateTile = (eyebrow: string, part: number, whole: Figure | null): Tile => {
	const rate = whole === null || whole.value <= 0 ? null : part / whole.value
	return {
		eyebrow,
		value: rate === null ? EMPTY_VALUE : formatErrorRate(rate),
		subline: rate === null ? "no traffic" : `${formatRate(part)} of ${formatRate(whole?.value ?? 0)}`,
		tone: rate !== null && rate >= 0.01 ? "crit" : undefined,
	}
}

const plainTile = (
	eyebrow: string,
	figure: Figure | null,
	format: (value: number) => string,
	peakLabel = "peak",
): Tile => ({
	eyebrow,
	value: figure === null ? EMPTY_VALUE : format(figure.value),
	subline: figure === null ? "not reported" : `${peakLabel} ${format(figure.peak)}`,
	spark: figure?.trend,
})

const tilesOf = (
	kind: AwsInfraKindId,
	rows: ReadonlyArray<BucketRow>,
	context: TileContext,
): ReadonlyArray<Tile> => {
	const f = (key: string) => figureOf(kind, rows, key)
	switch (kind) {
		case "ecs":
			return [percentTile("CPU", f("cpu")), percentTile("Memory", f("memory"))]
		case "ec2":
			return [
				percentTile("CPU", f("cpu")),
				plainTile("Network in", f("networkIn"), formatBytes, "busiest bucket"),
				plainTile("Network out", f("networkOut"), formatBytes, "busiest bucket"),
				{
					eyebrow: "Status checks",
					value:
						(f("statusFailed")?.peak ?? 0) > 0
							? "failing"
							: f("statusFailed") === null
								? EMPTY_VALUE
								: "passing",
					subline: "instance and system",
					tone: (f("statusFailed")?.peak ?? 0) > 0 ? "crit" : undefined,
				},
			]
		case "loadBalancers": {
			const requests = f("requests")
			const errors = (f("target5xx")?.value ?? 0) + (f("elb5xx")?.value ?? 0)
			return [
				perMinuteTile("Requests / min", requests, context),
				rateTile("5xx", errors, requests),
				plainTile("Target response", f("responseTime"), (seconds) => formatLatency(seconds * 1000)),
			]
		}
		case "rds":
			return [
				percentTile("CPU", f("cpu")),
				plainTile("Connections", f("connections"), (value) => String(Math.round(value))),
				plainTile("Free storage", f("freeStorage"), formatBytes, "most"),
				plainTile("Free memory", f("freeMemory"), formatBytes, "most"),
			]
		case "lambda": {
			const invocations = f("invocations")
			return [
				perMinuteTile("Invocations / min", invocations, context),
				rateTile("Errors", f("errors")?.value ?? 0, invocations),
				plainTile("Throttles", f("throttles"), formatRate, "busiest bucket"),
				plainTile("Avg duration", f("duration"), formatLatency),
			]
		}
		case "sqs":
			return [
				plainTile("Visible messages", f("visible"), (value) => formatRate(Math.round(value))),
				plainTile("Oldest message", f("oldestAge"), formatUptime),
				perMinuteTile("Sent / min", f("sent"), context),
			]
	}
}

/** The resource's health from the same rules as its list row. */
const judgementOf = (kind: AwsInfraKindId, rows: ReadonlyArray<BucketRow>): Judgement => {
	const readings = Object.fromEntries(
		AWS_INFRA_KINDS[kind].metrics.flatMap((metric) => {
			const figure = figureOf(kind, rows, metric.key)
			return figure === null ? [] : [[metric.key, { value: figure.value, peak: figure.peak }] as const]
		}),
	)
	return judge(kind, readings)
}

const BADGE = { crit: "crit", warn: "warn", idle: "muted", ok: "ok" } as const

// The region becomes the console's hostname and comes from the URL, so only a real region links.
const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/
const AWS_ACCOUNT = /^\d{12}$/

/** The resource in the AWS console, where the page cannot follow. */
const consoleHref = (
	kind: AwsInfraKindId,
	name: string,
	region: string,
	cluster: string,
	account: string | undefined,
) => {
	const base = `https://${region}.console.aws.amazon.com`
	const q = `region=${encodeURIComponent(region)}`
	const id = encodeURIComponent(name)
	switch (kind) {
		case "ecs":
			return `${base}/ecs/v2/clusters/${encodeURIComponent(cluster)}/services/${id}/health?${q}`
		case "ec2":
			return `${base}/ec2/home?${q}#InstanceDetails:instanceId=${id}`
		// A load balancer opens by its ARN, which its name and account make; without one, a search.
		case "loadBalancers":
			return account === undefined
				? `${base}/ec2/home?${q}#LoadBalancers:search=${encodeURIComponent(name.split("/")[1] ?? name)}`
				: `${base}/ec2/home?${q}#LoadBalancer:loadBalancerArn=${encodeURIComponent(`arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/${name}`)}`
		case "rds":
			return `${base}/rds/home?${q}#database:id=${id}`
		case "lambda":
			return `${base}/lambda/home?${q}#/functions/${id}`
		// A queue opens by its URL, which needs the account.
		case "sqs":
			return account === undefined
				? `${base}/sqs/v3/home?${q}#/queues`
				: `${base}/sqs/v3/home?${q}#/queues/${encodeURIComponent(`https://sqs.${region}.amazonaws.com/${account}/${name}`)}`
	}
}

const tracedPanel = (h: H, service: TracedService | null, kind: AwsInfraKindId, name: string): Html =>
	panel(h, {}, [
		panelHeader(h, { title: service === null ? "Not traced" : `Traced as ${service.serviceName}` }),
		h.div(
			[h.Class("px-4 pb-4 text-xs")],
			service === null
				? [
						h.p(
							[h.Class(MUTED)],
							[
								`No traced service is named ${name}. Set OTEL_SERVICE_NAME=${name} on the ${AWS_INFRA_KINDS[kind].noun} and its traces line up with these metrics.`,
							],
						),
					]
				: [
						h.div(
							[h.Class("flex flex-wrap items-center gap-x-6 gap-y-2 font-mono tabular-nums")],
							[
								h.span(
									[],
									[
										h.span([h.Class(MUTED)], ["calls/min "]),
										formatRate(service.throughput * 60),
									],
								),
								h.span(
									[],
									[
										h.span([h.Class(MUTED)], ["errors "]),
										formatErrorRate(service.errorRate),
									],
								),
								h.span(
									[],
									[h.span([h.Class(MUTED)], ["p95 "]), formatLatency(service.p95LatencyMs)],
								),
								linkButton(
									h,
									{
										size: "sm",
										variant: "outline",
										className: "ml-auto",
										href: hrefOf(
											AppRoute.Service({
												serviceName: service.serviceName,
												search: {},
											}),
										),
									},
									["Open service"],
								),
							],
						),
					],
		),
	])

const body = (
	h: H,
	model: Model,
	kind: AwsInfraKindId,
	points: ReadonlyArray<BucketPoint>,
	timeZone: string,
	isWaiting: boolean,
): Html => {
	const rows = bucketRows(kind, points)
	if (rows.length === 0)
		return integrationNotConnected(h, {
			icon: icon(h, "AwsIcon", { size: 16 }),
			title: "No metrics in this time range",
			description: `CloudWatch sent nothing for this ${AWS_INFRA_KINDS[kind].noun} in the window. Widen the time range, or check that its region is streamed.`,
			integration: "aws",
			actionLabel: "Check the connection",
			actionVariant: "outline",
		})
	const window = model.window
	const windowMs = window === null ? 0 : toEpochMs(window.endTime) - toEpochMs(window.startTime)
	const tiles = tilesOf(kind, rows, { windowMs })
	const theme = model.themeColors
	return h.div(
		[h.Class("space-y-4")],
		[
			statRail(
				h,
				{ columns: tiles.length === 2 ? 2 : tiles.length === 3 ? 3 : 4 },
				tiles.map((tile) =>
					statRailItem(h, {
						eyebrow: tile.eyebrow,
						value: tile.value,
						subline: tile.subline,
						tone: tile.tone,
						spark: tile.spark,
					}),
				),
			),
			theme === null || model.chartRuntime._tag !== "Ready"
				? metricChartsLoading(h, CHARTS[kind].length)
				: metricChartCards(h, {
						idPrefix: "aws-resource",
						linkedChartId: "aws-resource",
						charts: CHARTS[kind],
						buckets: rows,
						models: model.charts,
						toMessage: (chartId, message) => Message.GotChartMessage({ chartId, message }),
						theme,
						timeZone,
						isWaiting,
					}),
			...(kind === "ecs" || kind === "lambda"
				? [
						AsyncData.matchData(model.traced.data, {
							onEmpty: () => chartLoading(h, { variant: "line", height: 64 }),
							onFailure: () =>
								chartError(h, { height: 64 }, ["Failed to load the traced service"]),
							onData: (traced) =>
								tracedPanel(
									h,
									tracedAs(traced, { kind, name: model.name }),
									kind,
									model.name,
								),
						}),
					]
				: []),
		],
	)
}

const resourceView = (h: H, model: Model, kind: AwsInfraKindId, timeZone: string): Html =>
	AsyncData.match(model.timeseries.data, {
		onIdle: () => h.div([h.Class("space-y-4")], [statRailLoading(h, 4, 4), metricChartsLoading(h, 2)]),
		onLoading: () => h.div([h.Class("space-y-4")], [statRailLoading(h, 4, 4), metricChartsLoading(h, 2)]),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Failed to load the metrics", onRetry: Message.ClickedRetry() }),
		onStale: ({ data }) => body(h, model, kind, data, timeZone, true),
		onSuccess: (data) => body(h, model, kind, data, timeZone, false),
		onRefreshing: (data) => body(h, model, kind, data, timeZone, true),
	})

export const titleOf = (model: Model) => model.name

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const kind = model.kind
	const region = model.search.region ?? ""
	const cluster = model.search.cluster ?? ""
	const rows =
		kind !== null && AsyncData.isSuccess(model.timeseries.data)
			? bucketRows(kind, model.timeseries.data.data)
			: []
	const judgement = kind === null || rows.length === 0 ? null : judgementOf(kind, rows)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					scrollClassName: "gap-4",
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
						trailing:
							judgement === null
								? []
								: [
										badge(h, { variant: BADGE[judgement.health] }, [
											judgement.reason ?? "Healthy",
										]),
									],
						description: [
							kind === null ? "Unknown resource" : AWS_INFRA_KINDS[kind].label,
							...(cluster === "" ? [] : [`${cluster} cluster`]),
							...(region === "" ? [] : [region]),
							...(model.search.account === undefined ? [] : [model.search.account]),
						].join(" · "),
						actions:
							kind === null || !AWS_REGION.test(region)
								? []
								: [
										linkButton(
											h,
											{
												size: "sm",
												variant: "outline",
												href: consoleHref(
													kind,
													model.name,
													region,
													cluster,
													AWS_ACCOUNT.test(model.search.account ?? "")
														? model.search.account
														: undefined,
												),
												attributes: [
													h.Target("_blank"),
													h.Rel("noopener noreferrer"),
												],
											},
											[
												"Open in AWS console",
												icon(h, "ExternalLinkIcon", { size: 12 }),
											],
										),
									],
					}),
					kind === null
						? integrationNotConnected(h, {
								icon: icon(h, "AwsIcon", { size: 16 }),
								title: "Maple does not read this kind of resource",
								description: "Go back to the AWS overview to pick a resource it streams.",
								integration: "aws",
								actionLabel: "Manage accounts",
								actionVariant: "outline",
							})
						: resourceView(h, model, kind, inputs.context.timeZone),
				],
			),
		],
	)
})
