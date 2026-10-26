import { MAPLE_SERVICES_NAMESPACE } from "@maple/domain/uptime"
import { cn } from "@maple/ui/lib/utils"
import { formatAlertTime } from "@maple/web-data/alerts/form-utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { ChartSpec } from "../../../charts/chart-spec"
import * as FixedMetricChart from "../../../charts/fixed-metric-chart"
import { fixedMetricLegend, latencySeries } from "../../../charts/fixed-metric-legend"
import { LATENCY_SERIES } from "../../../charts/fixed-metric-series"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import { errorState } from "../../../ui/error-state"
import { segmentedSelect } from "../../../ui/segmented-select"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { isoMs } from "../shared/time"
import * as CopyButton from "../../../ui/copy-button"
import { copyableField } from "../../../ui/copyable-field"
import { eyebrow } from "../../../ui/eyebrow"
import { panel, panelHeader } from "../../../ui/panel"
import { traceHref, uptimeTracesHref, UPTIME_SERVICE } from "../shared/uptime-commands"
import {
	displayStatus,
	formatEvery,
	formatMs,
	formatShare,
	formatSpan,
	latencyPercentiles,
	STATUS_TONE,
	type UptimeMonitor,
	uptimeShare,
} from "../shared/uptime-derive"
import { Message } from "./message"
import type { CheckPoint, CheckStats, Model, UptimeWindow } from "./model"
import { uptimePanelBody } from "../shared/uptime-view"

// The monitor page's panels: response time, the checks list and the side panels.

type H = HtmlBuilder<Message>

const CHECK_ROWS = 15

/** A key/value row in a side panel. */
const fact = (h: H, label: string, value: Html | string, valueClass?: string): Html =>
	h.div(
		[h.Class("flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm")],
		[
			h.span([h.Class("shrink-0 whitespace-nowrap text-muted-foreground")], [label]),
			h.span([h.Class(cn("min-w-0 break-words text-right tabular-nums", valueClass))], [value]),
		],
	)

export const CHART_TOKENS = [...LATENCY_SERIES.map((entry) => entry.token), "--border", "--background"]

const WINDOWS: ReadonlyArray<{ value: UptimeWindow; label: string }> = [
	{ value: "1h", label: "1h" },
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7d" },
]

const WINDOW_LABEL = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days" } as const

const STATUS_WORD = {
	up: "Up",
	down: "Down",
	degraded: "Degraded",
	pending: "Pending",
	paused: "Paused",
} as const

export type ChartContext = Readonly<{ theme: ThemeColors; timeZone: string; nowMs: number }>

const statsOf = (model: Model): Option.Option<CheckStats> => AsyncData.getData(model.stats.data)

/** `3m ago`. */
const ago = (nowMs: number, atMs: number): string => `${formatSpan(nowMs - atMs)} ago`

/** The figures over the page: status, the last check, uptime and the window's percentiles. */
export const kpiRail = (
	h: H,
	model: Model,
	monitor: UptimeMonitor,
	nowMs: number,
	timeZone: string,
): Html => {
	const status = displayStatus(monitor)
	const changed = monitor.state.status_changed_at
	const last = monitor.state.last_check
	const isHeartbeat = monitor.kind === "heartbeat"
	const statusItem = statRailItem(h, {
		eyebrow: "Status",
		value: STATUS_WORD[status],
		tone: STATUS_TONE[status],
		compact: true,
		subline:
			changed === null || status === "paused" || status === "pending"
				? `Every ${formatEvery(monitor.interval_seconds)}`
				: `for ${formatSpan(nowMs - isoMs(changed))}`,
	})
	const lastItem = isHeartbeat
		? statRailItem(h, {
				eyebrow: "Last ping",
				value:
					monitor.state.last_ping_at === null
						? "None yet"
						: ago(nowMs, isoMs(monitor.state.last_ping_at)),
				compact: true,
				subline:
					monitor.state.last_ping_at === null
						? "Waiting for the first ping"
						: formatAlertTime(monitor.state.last_ping_at, timeZone),
			})
		: statRailItem(h, {
				eyebrow: "Last checked",
				value: last === null ? "Not yet" : ago(nowMs, isoMs(last.at)),
				tone: last !== null && !last.ok ? "crit" : "neutral",
				compact: true,
				subline:
					last === null
						? "The first check runs shortly"
						: [
								last.status_code === null
									? last.ok
										? "Passed"
										: "Failed"
									: String(last.status_code),
								last.duration_ms === null ? "" : ` in ${formatMs(last.duration_ms)}`,
							].join(""),
			})
	if (isHeartbeat) {
		const share = uptimeShare(monitor.state.recent)
		return statRail(h, { columns: 3 }, [
			statusItem,
			lastItem,
			statRailItem(h, {
				eyebrow: "Uptime",
				value: formatShare(share),
				tone: share !== null && share < 1 ? "warn" : "neutral",
				compact: true,
				subline: `Over the last ${monitor.state.recent.length} checks`,
			}),
		])
	}
	// The window's figures from the check spans; the recent ring until they arrive.
	const stats = statsOf(model)
	const recent = latencyPercentiles(monitor.state.recent)
	const figures = Option.match(stats, {
		onNone: () => ({
			share: uptimeShare(monitor.state.recent),
			p50: recent.p50,
			p95: recent.p95,
			p99: recent.p99,
			scope: `last ${monitor.state.recent.length} checks`,
			subline: `last ${monitor.state.recent.length} checks`,
		}),
		onSome: (data) => ({
			share: data.checks === 0 ? null : (data.checks - data.failures) / data.checks,
			p50: data.p50Ms,
			p95: data.p95Ms,
			p99: data.p99Ms,
			scope: WINDOW_LABEL[model.window],
			subline:
				data.checks === 0
					? `No checks in the ${WINDOW_LABEL[model.window]}`
					: `${data.checks.toLocaleString()} checks, ${data.failures.toLocaleString()} failed`,
		}),
	})
	const percentile = (label: string, value: number | null) =>
		statRailItem(h, {
			eyebrow: label,
			value: formatMs(value),
			compact: true,
			subline: figures.scope,
		})
	return statRail(h, { columns: 3, className: "lg:grid-cols-6 lg:divide-y-0" }, [
		statusItem,
		lastItem,
		statRailItem(h, {
			eyebrow: "Uptime",
			value: formatShare(figures.share),
			tone: figures.share !== null && figures.share < 1 ? "warn" : "neutral",
			compact: true,
			subline: figures.subline,
		}),
		percentile("P50", figures.p50),
		percentile("P95", figures.p95),
		percentile("P99", figures.p99),
	])
}

const chartRows = (points: ReadonlyArray<CheckPoint>) =>
	points.map((point) => ({
		bucket: point.bucket,
		p50LatencyMs: point.p50LatencyMs,
		p95LatencyMs: point.p95LatencyMs,
		p99LatencyMs: point.p99LatencyMs,
		partial: point.partial,
	}))

const latencyChart = (h: H, model: Model, points: ReadonlyArray<CheckPoint>, context: ChartContext): Html =>
	h.submodel({
		slotId: "uptime-latency-chart",
		model: model.chart,
		view: FixedMetricChart.view,
		viewInputs: {
			chartId: "uptime-latency",
			ariaLabel: "Response time percentiles",
			spec: ChartSpec.FixedMetric({
				chart: "Latency",
				marginLeft: 64,
				rows: chartRows(points),
				colors: {
					border: resolveColor(context.theme, "--border"),
					background: resolveColor(context.theme, "--background"),
					...Object.fromEntries(
						LATENCY_SERIES.map((entry) => [entry.key, resolveColor(context.theme, entry.token)]),
					),
				},
				perSecond: false,
				timeZone: context.timeZone,
				nowMs: context.nowMs,
				gradientPrefix: "uptime-latency",
				showTooltip: true,
			}),
			className: "h-full w-full aspect-auto",
			legend: fixedMetricLegend(h, latencySeries(context.theme)),
		},
		toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ message }),
	})

/** One segment per bucket under the chart: green when every check passed, red with any failure. */
const availabilityStrip = (h: H, points: ReadonlyArray<CheckPoint>, timeZone: string): Html =>
	h.div(
		[h.Class("flex h-2 gap-px pl-16"), h.AriaHidden(true)],
		points.map((point) => {
			const failed = Math.round(point.errorRate * point.totalCount)
			const label =
				point.totalCount === 0
					? `${formatAlertTime(point.bucket, timeZone)}: no checks`
					: `${formatAlertTime(point.bucket, timeZone)}: ${point.totalCount} checks, ${failed} failed`
			return h.span(
				[
					h.Key(point.bucket),
					h.Title(label),
					h.Class(
						cn(
							"min-w-0 flex-1 rounded-[1px]",
							point.totalCount === 0
								? "bg-muted"
								: failed > 0
									? "bg-destructive"
									: "bg-success/70",
						),
					),
				],
				[],
			)
		}),
	)

/** P50, P95 and P99 over the picked window, from the monitor's check spans. */
export const responseTimePanel = (h: H, model: Model, context: ChartContext | null): Html => {
	const data = model.stats.data
	const body = AsyncData.isFailure(data)
		? errorState(h, { failure: data.error, title: "Couldn't load response times", className: "py-8" })
		: Option.match(statsOf(model), {
				onNone: () => h.div([h.Class("h-56")], [chartSkeleton(h, "line")]),
				onSome: (stats) =>
					stats.checks === 0
						? h.p(
								[h.Class("py-16 text-center text-sm text-muted-foreground")],
								[
									`No checks in the ${WINDOW_LABEL[model.window]}. The next one runs shortly.`,
								],
							)
						: context === null
							? h.div([h.Class("h-56")], [chartSkeleton(h, "line")])
							: h.div(
									[h.Class("flex flex-col gap-2")],
									[
										h.div(
											[h.Class("h-56")],
											[latencyChart(h, model, stats.points, context)],
										),
										availabilityStrip(h, stats.points, context.timeZone),
									],
								),
			})
	return panel(h, {}, [
		panelHeader(h, {
			title: "Response time",
			action: segmentedSelect(h, {
				ariaLabel: "Window",
				size: "xs",
				value: model.window,
				onChange: (window) => Message.PickedWindow({ window }),
				options: WINDOWS,
			}),
		}),
		uptimePanelBody(h, [body]),
	])
}

type CheckRow = Readonly<{
	at: string
	ok: boolean
	statusCode: number | null
	durationMs: number | null
	result: string
	traceId: string | null
}>

/** Newest first: the last check carries the status, error and trace; the rest only pass or fail. */
const checkRows = (monitor: UptimeMonitor): ReadonlyArray<CheckRow> => {
	const last = monitor.state.last_check
	const recent = [...monitor.state.recent].reverse()
	return recent.slice(0, CHECK_ROWS).map((check): CheckRow =>
		last !== null && last.at === check.at
			? {
					at: last.at,
					ok: last.ok,
					statusCode: last.status_code,
					durationMs: last.duration_ms,
					result: last.ok ? "OK" : (last.error ?? "Failed"),
					traceId: last.trace_id,
				}
			: {
					at: check.at,
					ok: check.ok,
					statusCode: null,
					durationMs: check.duration_ms,
					result: check.ok ? "OK" : "Failed",
					traceId: null,
				},
	)
}

const CHECK_GRID = "grid grid-cols-[90px_64px_90px_minmax(0,1fr)_80px] items-center gap-3"

export const checksPanel = (h: H, monitor: UptimeMonitor, timeZone: string): Html => {
	const rows = checkRows(monitor)
	return panel(h, {}, [
		panelHeader(h, {
			title: "Checks",
			action: h.a(
				[h.Href(uptimeTracesHref()), h.Class("text-xs text-primary hover:underline")],
				["View all checks in Traces"],
			),
		}),
		h.p(
			[h.Class("px-4 pb-2 text-xs text-muted-foreground")],
			[`Each check is a span in the ${UPTIME_SERVICE} service, namespace ${MAPLE_SERVICES_NAMESPACE}.`],
		),
		h.div(
			[h.Class(cn(CHECK_GRID, "border-y px-4 py-2"))],
			[
				eyebrow(h, {}, ["Time"]),
				eyebrow(h, {}, ["Status"]),
				eyebrow(h, {}, ["Duration"]),
				eyebrow(h, {}, ["Result"]),
				eyebrow(h, { className: "text-right" }, ["Trace"]),
			],
		),
		rows.length === 0
			? h.p([h.Class("px-4 py-6 text-sm text-muted-foreground")], ["No checks yet."])
			: h.ul(
					[h.Class("divide-y")],
					rows.map((row, index) =>
						h.li(
							[h.Key(`${row.at}-${index}`), h.Class(cn(CHECK_GRID, "px-4 py-2 text-sm"))],
							[
								h.span(
									[h.Class("font-mono text-xs text-muted-foreground")],
									[formatAlertTime(row.at, timeZone)],
								),
								h.span(
									[
										h.Class(
											cn(
												"font-mono text-xs",
												row.ok ? "text-success" : "text-destructive",
											),
										),
									],
									[
										row.statusCode === null
											? row.ok
												? "Pass"
												: "Fail"
											: String(row.statusCode),
									],
								),
								h.span(
									[h.Class("font-mono text-xs tabular-nums")],
									[formatMs(row.durationMs)],
								),
								h.span([h.Class("truncate text-xs text-muted-foreground")], [row.result]),
								row.traceId === null
									? h.span([h.Class("text-right text-xs text-muted-foreground")], ["–"])
									: h.a(
											[
												h.Href(traceHref(row.traceId)),
												h.Class(
													"text-right font-mono text-xs text-primary hover:underline",
												),
											],
											[`${row.traceId.slice(0, 4)}…${row.traceId.slice(-4)}`],
										),
							],
						),
					),
				),
	])
}

/** "every 1d, 30m grace", or the cron line and its time zone. */
const heartbeatExpectation = (config: Extract<UptimeMonitor["config"], { type: "heartbeat" }>): string => {
	const schedule =
		config.schedule.type === "interval"
			? `every ${formatEvery(config.schedule.seconds)}`
			: `cron ${config.schedule.expression} (${config.schedule.timezone})`
	return `${schedule}, ${formatEvery(config.grace_seconds)} grace`
}

export const lastCheckPanel = (h: H, monitor: UptimeMonitor): Html => {
	const last = monitor.state.last_check
	const result =
		last === null
			? "No check yet"
			: last.status_code !== null
				? String(last.status_code)
				: last.ok
					? "Passed"
					: "Failed"
	const config = monitor.config
	const isHeartbeat = config.type === "heartbeat"
	return panel(h, { className: "divide-y" }, [
		panelHeader(h, { title: "Last check" }),
		fact(h, "Result", result, last !== null && !last.ok ? "text-destructive" : undefined),
		...(isHeartbeat ? [] : [fact(h, "Duration", formatMs(last?.duration_ms ?? null))]),
		fact(h, "Probe", isHeartbeat ? "Your job" : "Ashburn, US"),
		config.type === "heartbeat"
			? fact(h, "Expected", heartbeatExpectation(config))
			: fact(
					h,
					"Down after",
					`${monitor.failures_to_down} failed ${monitor.failures_to_down === 1 ? "check" : "checks in a row"}`,
				),
		...(last === null || last.ok || last.error === null
			? []
			: [h.p([h.Class("px-4 py-2.5 text-sm text-destructive")], [last.error])]),
	])
}

export const setupPanel = (h: H, model: Model, monitor: UptimeMonitor, serviceHref: string | null): Html => {
	const count = monitor.destination_ids.length
	// `null` until destinations sync: the count, rather than calling every one unavailable.
	const destinations = model.destinations
	const notifies =
		count === 0
			? "Nobody yet. The incident still opens in the inbox."
			: destinations === null
				? `${count} ${count === 1 ? "destination" : "destinations"}`
				: monitor.destination_ids
						.map(
							(id) =>
								destinations.find((row) => row.id === id)?.name ?? "Unavailable destination",
						)
						.join(", ")
	return panel(h, { className: "divide-y" }, [
		panelHeader(h, { title: "Setup" }),
		h.div(
			[h.Class("px-4 py-3")],
			[eyebrow(h, {}, ["Notifies"]), h.p([h.Class("mt-1 text-sm")], [notifies])],
		),
		h.div(
			[h.Class("px-4 py-3")],
			[
				eyebrow(h, {}, ["Service"]),
				h.p(
					[h.Class("mt-1 text-sm")],
					[
						serviceHref === null || monitor.service_name === null
							? "Not linked to a service"
							: h.a(
									[h.Href(serviceHref), h.Class("text-primary hover:underline")],
									[monitor.service_name],
								),
					],
				),
			],
		),
	])
}

const snippet = (h: H, model: Model, id: string, label: string, value: string): Html =>
	copyableField(h, {
		id: `uptime-snippet-${id}`,
		label,
		value,
		copy: model.copies[id] ?? CopyButton.init(),
		toCopyMessage: (message) => Message.GotCopyMessage({ id, message }),
	})

/** The ping URL and the lines a job adds: success, failure, and a crontab entry. */
export const heartbeatPanel = (h: H, model: Model, pingUrl: string): Html =>
	panel(h, {}, [
		panelHeader(h, { title: "Ping URL" }),
		uptimePanelBody(h, [
			h.p(
				[h.Class("mb-3 text-sm text-muted-foreground")],
				["Send a GET or POST here when the job succeeds. Add /fail to report a failure right away."],
			),
			h.div(
				[h.Class("flex flex-col gap-3")],
				[
					snippet(h, model, "url", "Ping URL", pingUrl),
					snippet(
						h,
						model,
						"success",
						"After the job succeeds",
						`curl -fsS -m 10 --retry 3 ${pingUrl}`,
					),
					snippet(
						h,
						model,
						"fail",
						"When the job fails",
						`curl -fsS -m 10 --retry 3 ${pingUrl}/fail`,
					),
					snippet(
						h,
						model,
						"crontab",
						"Crontab",
						`0 2 * * * /path/to/job.sh && curl -fsS -m 10 ${pingUrl} || curl -fsS -m 10 ${pingUrl}/fail`,
					),
				],
			),
		]),
	])
