import { MAPLE_SERVICES_NAMESPACE } from "@maple/domain/uptime"
import { bucketTimeScale } from "@maple/ui/components/plot/plot-scales"
import { formatBucketLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { formatAlertDateTime, formatAlertTime } from "@maple/web-data/alerts/form-utils"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import * as Chart from "../../../charts/chart"
import { ChartSpec } from "../../../charts/chart-spec"
import * as FixedMetricChart from "../../../charts/fixed-metric-chart"
import { fixedMetricLegend, latencySeries } from "../../../charts/fixed-metric-legend"
import { LATENCY_SERIES } from "../../../charts/fixed-metric-series"
import { bucketTooltipBody } from "../../../charts/bucket-tooltip"
import { plotFrame } from "../../../charts/plot-frame"
import { stackedBreakdown } from "../../../charts/stacked-breakdown-chart"
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
import type { CheckPoint, CheckSample, CheckStats, Model, PhasePoint, UptimeWindow } from "./model"
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

/** An HTTP check's phases in the order they happen, which is also the stack order from the axis up. */
const PHASES = [
	{ key: "dnsMs", label: "DNS", token: "--chart-1" },
	{ key: "connectMs", label: "Connect", token: "--chart-2" },
	{ key: "tlsMs", label: "TLS", token: "--chart-3" },
	{ key: "ttfbMs", label: "TTFB", token: "--chart-4" },
	{ key: "transferMs", label: "Transfer", token: "--chart-5" },
] as const satisfies ReadonlyArray<{ key: keyof PhasePoint; label: string; token: string }>

export const CHART_TOKENS = [
	...LATENCY_SERIES.map((entry) => entry.token),
	...PHASES.map((phase) => phase.token),
	"--border",
	"--background",
]

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

/** A switched window shows the previous figures until its own land; they are dimmed meanwhile. */
const isStatsRefreshing = (model: Model): boolean => AsyncData.isRefreshing(model.stats.data)

/** Time of day within an hour, the date as well over longer windows. */
const timeLabel = (window: UptimeWindow, iso: string, timeZone: string): string =>
	window === "1h" ? formatAlertTime(iso, timeZone) : formatAlertDateTime(iso, timeZone)

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
			scope: WINDOW_LABEL[data.window],
			subline:
				data.checks === 0
					? `No checks in the ${WINDOW_LABEL[data.window]}`
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
	return statRail(
		h,
		{
			columns: 3,
			isBusy: isStatsRefreshing(model),
			className: cn("lg:grid-cols-6 lg:divide-y-0", refreshingClass(isStatsRefreshing(model))),
		},
		[
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
		],
	)
}

const chartRows = (points: ReadonlyArray<CheckPoint>) =>
	points.map((point) => ({
		bucket: point.bucket,
		p50LatencyMs: point.p50LatencyMs,
		p95LatencyMs: point.p95LatencyMs,
		p99LatencyMs: point.p99LatencyMs,
		partial: point.partial,
	}))

/** The plot's insets in px, shared by every chart on the page so one instant sits at one x (`pl-16`, `pr-3`). */
const PLOT_LEFT = 64
const PLOT_RIGHT = 12

/** Every chart spans the picked window, not just the buckets that hold data. */
const windowDomain = (stats: CheckStats): readonly [number, number] => [
	stats.windowStartMs,
	stats.windowEndMs,
]

const latencyChart = (h: H, model: Model, stats: CheckStats, context: ChartContext): Html =>
	h.submodel({
		slotId: "uptime-latency-chart",
		model: model.chart,
		view: FixedMetricChart.view,
		viewInputs: {
			chartId: "uptime-latency",
			ariaLabel: "Response time percentiles",
			spec: ChartSpec.FixedMetric({
				chart: "Latency",
				marginLeft: PLOT_LEFT,
				marginRight: PLOT_RIGHT,
				xDomainMs: [...windowDomain(stats)],
				rows: chartRows(stats.points),
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
const availabilityStrip = (
	h: H,
	points: ReadonlyArray<CheckPoint>,
	window: UptimeWindow,
	timeZone: string,
): Html =>
	h.div(
		[h.Class("flex h-2 gap-px pr-3 pl-16"), h.AriaHidden(true)],
		points.map((point) => {
			const failed = Math.round(point.errorRate * point.totalCount)
			const label =
				point.totalCount === 0
					? `${timeLabel(window, point.bucket, timeZone)}: no checks`
					: `${timeLabel(window, point.bucket, timeZone)}: ${point.totalCount} checks, ${failed} failed`
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
									`No checks in the ${WINDOW_LABEL[stats.window]}. The next one runs shortly.`,
								],
							)
						: model.chartRuntime._tag === "Failed"
							? h.p(
									[h.Class("py-16 text-center text-sm text-muted-foreground")],
									["The chart couldn't load. Reload the page to try again."],
								)
							: context === null
								? h.div([h.Class("h-56")], [chartSkeleton(h, "line")])
								: h.div(
										[
											...(isStatsRefreshing(model) ? [h.AriaBusy(true)] : []),
											h.Class(
												cn(
													"flex flex-col gap-2",
													refreshingClass(isStatsRefreshing(model)),
												),
											),
										],
										[
											h.div(
												[h.Class("h-56")],
												[latencyChart(h, model, stats, context)],
											),
											availabilityStrip(
												h,
												stats.points,
												stats.window,
												context.timeZone,
											),
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

/** 1, 2 or 5 times a power of ten, at or above `value`. */
const niceCeil = (value: number): number => {
	const power = 10 ** Math.floor(Math.log10(Math.max(1, value)))
	const step = [1, 2, 5, 10].find((candidate) => candidate * power >= value) ?? 10
	return step * power
}

/** The y range: the checks' p99 with headroom, so one timeout does not flatten the rest; slower checks sit on the top edge. */
const scatterMax = (samples: ReadonlyArray<CheckSample>): number => {
	const sorted = samples.map((sample) => sample.durationMs).sort((a, b) => a - b)
	const p99 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] ?? 1
	return niceCeil(p99 * 1.15)
}

type Domain = Readonly<{ startMs: number; endMs: number }>

/** Where a time or a duration sits on the plot, as a 0 to 1 share of its width or height. */
const xShare = (ms: number, domain: Domain): number =>
	(ms - domain.startMs) / Math.max(1, domain.endMs - domain.startMs)
const yShare = (ms: number, yMax: number): number => Math.min(1, ms / yMax)

/** Round clock ticks in the viewer's zone, short labels; the end ones kept inside the plot. */
const scatterTimeTicks = (domain: Domain, window: UptimeWindow, timeZone: string) => {
	const context = { rangeMs: domain.endMs - domain.startMs, bucketSeconds: undefined, timeZone }
	return bucketTimeScale([new Date(domain.startMs), new Date(domain.endMs)], timeZone)
		.ticks(window === "7d" ? 7 : 4)
		.map((date) => ({
			share: xShare(date.getTime(), domain),
			label: formatBucketLabel(date.toISOString(), context, "tick"),
		}))
		.filter((tick) => tick.share >= 0 && tick.share <= 1)
}

const tickAnchor = (share: number): string =>
	share < 0.06 ? "translate-x-0" : share > 0.94 ? "-translate-x-full" : "-translate-x-1/2"

/** A check's bar segments bottom up: its phases when it recorded them, else one bar of its total. */
const barSegments = (sample: CheckSample): ReadonlyArray<{ key: string; ms: number; color: string }> =>
	sample.phases === null
		? [{ key: "total", ms: sample.durationMs, color: "var(--muted-foreground)" }]
		: PHASES.map((phase) => ({
				key: phase.key,
				ms: sample.phases?.[phase.key] ?? 0,
				color: `var(${phase.token})`,
			})).filter((segment) => segment.ms > 0)

/** One column per check, its full height a link to its trace; failures red, a check past the axis capped with a caret. */
const checkBars = (
	h: H,
	samples: ReadonlyArray<CheckSample>,
	startMs: number,
	endMs: number,
	yMax: number,
): Html => {
	const domain: Domain = { startMs, endMs }
	// Bars thin out as checks pile up, never under a pixel or over 6; the width keeps a 30% gap, so no inset.
	const width = `max(1px, min(6px, ${(70 / Math.max(1, samples.length)).toFixed(3)}%))`
	const bar = (sample: CheckSample, index: number) => {
		const clipped = sample.durationMs > yMax
		return h.a(
			[
				h.Key(`${sample.traceId}-${index}`),
				h.Href(traceHref(sample.traceId)),
				h.Attribute("tabindex", "-1"),
				h.OnMouseEnter(Message.HoveredCheck({ index })),
				h.Class("group absolute inset-y-0 -translate-x-1/2 hover:bg-foreground/5"),
				h.Style({ left: `${xShare(isoMs(sample.at), domain) * 100}%`, width }),
			],
			[
				h.span(
					[
						h.Class(
							cn(
								"absolute inset-x-0 bottom-0 flex flex-col-reverse overflow-hidden rounded-t-[1px] group-hover:brightness-125",
								!sample.ok && "bg-destructive",
							),
						),
						h.Style({ height: `${yShare(sample.durationMs, yMax) * 100}%` }),
					],
					sample.ok
						? barSegments(sample).map((segment) =>
								h.span(
									[
										h.Key(segment.key),
										h.Class("block w-full"),
										h.Style({ flexGrow: String(segment.ms), background: segment.color }),
									],
									[],
								),
							)
						: [],
				),
				...(clipped
					? [
							h.span(
								[
									h.Class(
										cn(
											"absolute -top-1.5 left-1/2 size-0 -translate-x-1/2 border-x-[3px] border-t-[5px] border-x-transparent",
											sample.ok ? "border-t-foreground/60" : "border-t-destructive",
										),
									),
								],
								[],
							),
						]
					: []),
			],
		)
	}
	return h.div(
		[
			h.AriaHidden(true),
			h.Class("absolute inset-0"),
			h.OnMouseLeave(Message.HoveredCheck({ index: null })),
		],
		samples.map(bar),
	)
}

const barsSlot = createLazy()

const cardRow = (h: H, key: string, color: string, label: string, value: string): Html =>
	h.span(
		[h.Key(key), h.Class("flex items-center justify-between gap-4")],
		[
			h.span(
				[h.Class("flex items-center gap-1.5 text-muted-foreground")],
				[
					h.span(
						[h.Class("inline-block size-2 rounded-[2px]"), h.Style({ background: color })],
						[],
					),
					label,
				],
			),
			h.span([h.Class("font-mono tabular-nums")], [value]),
		],
	)

/** The hovered check's card: when, what it returned, and where its time went. */
const hoverCard = (h: H, sample: CheckSample, domain: Domain, timeZone: string): Html => {
	const left = xShare(isoMs(sample.at), domain) * 100
	const result = sample.statusCode === null ? (sample.ok ? "Passed" : "Failed") : String(sample.statusCode)
	return h.div(
		[
			h.Class(
				cn(
					"pointer-events-none absolute top-1 z-30 flex w-48 flex-col gap-1 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md",
					left > 60 ? "-translate-x-full -ml-2" : "ml-2",
				),
			),
			h.Style({ left: `${left}%` }),
		],
		[
			h.span([h.Class("text-muted-foreground")], [formatAlertDateTime(sample.at, timeZone)]),
			h.span(
				[h.Class("flex items-center justify-between gap-4 font-medium")],
				[
					h.span([h.Class(sample.ok ? "text-success" : "text-destructive")], [result]),
					h.span([h.Class("font-mono tabular-nums")], [formatMs(sample.durationMs)]),
				],
			),
			...(sample.phases === null
				? []
				: PHASES.map((phase) =>
						cardRow(
							h,
							phase.key,
							`var(${phase.token})`,
							phase.label,
							formatPhaseMs(sample.phases?.[phase.key] ?? 0),
						),
					)),
			h.span([h.Class("pt-0.5 text-primary")], ["Click to open the trace"]),
		],
	)
}

/** Phases are often under a millisecond, which whole-ms rounding would show as 0. */
const formatPhaseMs = (ms: number): string => (ms < 10 ? `${ms.toFixed(1)} ms` : formatMs(ms))

const legendItem = (h: H, key: string, swatch: Html, label: string): Html =>
	h.span([h.Key(key), h.Class("flex items-center gap-1.5")], [swatch, label])

const swatch = (h: H, color: string): Html =>
	h.span([h.Class("inline-block size-2 rounded-[2px]"), h.Style({ background: color })], [])

const barsLegend = (h: H, samples: ReadonlyArray<CheckSample>, yMax: number): Html => {
	const timed = samples.some((sample) => sample.ok && sample.phases !== null)
	const untimed = samples.some((sample) => sample.ok && sample.phases === null)
	const failed = samples.some((sample) => !sample.ok)
	const clipped = samples.some((sample) => sample.durationMs > yMax)
	return h.div(
		[h.Class("flex flex-wrap items-center gap-x-4 gap-y-1 pr-3 pl-16 text-xs text-muted-foreground")],
		[
			...(timed
				? PHASES.map((phase) =>
						legendItem(h, phase.key, swatch(h, `var(${phase.token})`), phase.label),
					)
				: []),
			...(untimed
				? [
						legendItem(
							h,
							"untimed",
							swatch(h, "var(--muted-foreground)"),
							timed ? "No phases recorded" : "Passed",
						),
					]
				: []),
			...(failed ? [legendItem(h, "failed", swatch(h, "var(--destructive)"), "Failed")] : []),
			...(clipped
				? [
						legendItem(
							h,
							"clipped",
							h.span(
								[
									h.Class(
										"inline-block size-0 border-x-[4px] border-t-[6px] border-x-transparent border-t-foreground/60",
									),
								],
								[],
							),
							`Slower than ${formatMs(yMax)}`,
						),
					]
				: []),
			h.span([h.Key("hint"), h.Class("ml-auto")], ["Click a bar to open its trace"]),
		],
	)
}

/** Every check in the window as a bar, its height its duration and its stack its phases. */
export const checksScatterPanel = (h: H, model: Model, timeZone: string): Html | null =>
	Option.match(statsOf(model), {
		onNone: () => null,
		onSome: (stats) => {
			if (stats.samplesFailed)
				return panel(h, {}, [
					panelHeader(h, { title: "Every check" }),
					uptimePanelBody(h, [
						h.p(
							[h.Class("py-10 text-center text-sm text-muted-foreground")],
							["Couldn't load the checks. The other figures are unaffected."],
						),
					]),
				])
			if (stats.samples.length === 0) return null
			const yMax = scatterMax(stats.samples)
			const failed = stats.samples.filter((sample) => !sample.ok).length
			// Past the list's limit the axis starts at the oldest check shown, not the window's start.
			const oldest = stats.samples[0]
			const startMs =
				stats.samplesTruncated && oldest !== undefined ? isoMs(oldest.at) : stats.windowStartMs
			const domain: Domain = { startMs, endMs: stats.windowEndMs }
			const hovered = model.hoveredCheck === null ? undefined : stats.samples[model.hoveredCheck]
			const yTicks = [0, 0.5, 1]
			return panel(h, {}, [
				panelHeader(h, {
					title: "Every check",
					action: h.span(
						[h.Class("text-xs text-muted-foreground tabular-nums")],
						[
							stats.samplesTruncated
								? `Newest ${stats.samples.length.toLocaleString()} checks`
								: `${stats.samples.length.toLocaleString()} checks`,
							failed === 0 ? "" : `, ${failed} failed`,
						],
					),
				}),
				uptimePanelBody(h, [
					h.div(
						[
							...(isStatsRefreshing(model) ? [h.AriaBusy(true)] : []),
							h.Class(cn("flex flex-col gap-2", refreshingClass(isStatsRefreshing(model)))),
						],
						[
							h.div(
								[h.Class("flex h-56 pt-2 pr-3")],
								[
									h.div(
										[
											h.AriaHidden(true),
											h.Class(
												"relative w-16 shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums",
											),
										],
										yTicks.map((share) =>
											h.span(
												[
													h.Key(String(share)),
													h.Class("absolute right-2 translate-y-1/2"),
													h.Style({ bottom: `${share * 100}%` }),
												],
												[share === 0 ? "0" : formatMs(yMax * share)],
											),
										),
									),
									h.div(
										[
											h.Role("img"),
											h.AriaLabel(
												`${stats.samples.length} checks over the ${WINDOW_LABEL[stats.window]}, ${failed} failed`,
											),
											h.Class("relative min-w-0 flex-1"),
										],
										[
											...yTicks.map((share) =>
												h.div(
													[
														h.Key(`grid-${share}`),
														h.AriaHidden(true),
														h.Class(
															cn(
																"pointer-events-none absolute inset-x-0 border-t",
																share === 0
																	? "border-border"
																	: "border-dashed border-border/60",
															),
														),
														h.Style({ bottom: `${share * 100}%` }),
													],
													[],
												),
											),
											// Memoized: hover and other page messages do not rebuild thousands of bars.
											barsSlot(checkBars, [
												h,
												stats.samples,
												startMs,
												stats.windowEndMs,
												yMax,
											]),
											...(hovered === undefined
												? []
												: [hoverCard(h, hovered, domain, timeZone)]),
										],
									),
								],
							),
							h.div(
								[
									h.AriaHidden(true),
									h.Class(
										"relative mr-3 ml-16 h-4 font-mono text-[11px] text-muted-foreground",
									),
								],
								scatterTimeTicks(domain, stats.window, timeZone).map((tick) =>
									h.span(
										[
											h.Key(tick.label),
											h.Class(
												cn(
													"absolute top-0 whitespace-nowrap",
													tickAnchor(tick.share),
												),
											),
											h.Style({ left: `${tick.share * 100}%` }),
										],
										[tick.label],
									),
								),
							),
							barsLegend(h, stats.samples, yMax),
						],
					),
				]),
			])
		},
	})

/** Long rows, one per (bucket, phase), labelled so the tooltip and legend read the phase names. */
const phaseRows = (points: ReadonlyArray<PhasePoint>) =>
	points.flatMap((point) =>
		PHASES.map((phase) => ({
			bucket: point.bucket,
			attributeValue: phase.label,
			value: point[phase.key],
		})),
	)

const phaseChart = (h: H, model: Model, stats: CheckStats, context: ChartContext): Html => {
	const built = stackedBreakdown({
		rows: phaseRows(stats.phases),
		colors: Object.fromEntries(PHASES.map((phase) => [phase.label, `var(${phase.token})`])),
		order: PHASES.map((phase) => phase.label),
		theme: context.theme,
		timeZone: context.timeZone,
		gradientPrefix: "uptime-phases",
		unit: "duration_ms",
		showTotal: true,
		xDomainMs: windowDomain(stats),
		marginLeft: PLOT_LEFT,
	})
	return h.div(
		[h.Class("h-56")],
		[
			h.submodel({
				slotId: "uptime-phase-chart",
				model: model.phaseChart,
				view: PhaseChartView,
				viewInputs: {
					spec: built.spec,
					legend: fixedMetricLegend(
						h,
						PHASES.map((phase) => ({
							key: phase.key,
							label: phase.label,
							color: resolveColor(context.theme, phase.token),
						})),
					),
				},
				toParentMessage: (message: Chart.Message) => Message.GotPhaseChartMessage({ message }),
			}),
		],
	)
}

const PhaseChartView = Submodel.defineView<
	Chart.Model,
	Chart.Message,
	Readonly<{ spec: ChartSpec; legend: Html }>
>((model, inputs, h) =>
	plotFrame(h, {
		chartId: "uptime-phases",
		spec: inputs.spec,
		ariaLabel: "Response time breakdown by phase",
		className: "h-full w-full aspect-auto",
		legend: inputs.legend,
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				tooltip._tag === "Bucket"
					? Option.some(bucketTooltipBody(h, tooltip, portal))
					: Option.none(),
			),
	}),
)

/** HTTP monitors: where each check's time went, averaged per bucket over the picked window. */
export const phaseBreakdownPanel = (h: H, model: Model, context: ChartContext | null): Html => {
	const data = model.stats.data
	const body = AsyncData.isFailure(data)
		? errorState(h, { failure: data.error, title: "Couldn't load the breakdown", className: "py-8" })
		: Option.match(statsOf(model), {
				onNone: () => h.div([h.Class("h-56")], [chartSkeleton(h, "area")]),
				onSome: (stats) =>
					stats.phasesFailed
						? h.p(
								[h.Class("py-16 text-center text-sm text-muted-foreground")],
								["Couldn't load the breakdown. The other figures are unaffected."],
							)
						: stats.phases.length === 0
							? h.p(
									[h.Class("py-16 text-center text-sm text-muted-foreground")],
									[
										`No timed checks in the ${WINDOW_LABEL[stats.window]}. Newer checks record each phase.`,
									],
								)
							: model.chartRuntime._tag === "Failed"
								? h.p(
										[h.Class("py-16 text-center text-sm text-muted-foreground")],
										["The chart couldn't load. Reload the page to try again."],
									)
								: context === null
									? h.div([h.Class("h-56")], [chartSkeleton(h, "area")])
									: phaseChart(h, model, stats, context),
			})
	return panel(h, { attributes: [h.AriaLabel("Response time breakdown")] }, [
		panelHeader(h, { title: "Response time breakdown" }),
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
					result: last.ok ? "" : (last.error ?? ""),
					traceId: last.trace_id,
				}
			: {
					at: check.at,
					ok: check.ok,
					statusCode: null,
					durationMs: check.duration_ms,
					result: "",
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
				[
					h.Href(uptimeTracesHref()),
					h.Title(
						`Each check is a span in the ${UPTIME_SERVICE} service, namespace ${MAPLE_SERVICES_NAMESPACE}.`,
					),
					h.Class("text-xs text-primary hover:underline"),
				],
				["View all checks in Traces"],
			),
		}),
		h.div(
			[h.Class(cn(CHECK_GRID, "border-y px-4 py-2"))],
			[
				eyebrow(h, {}, ["Time"]),
				eyebrow(h, {}, ["Status"]),
				eyebrow(h, {}, ["Duration"]),
				eyebrow(h, {}, ["Error"]),
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
								h.span(
									[h.Class("truncate text-xs text-destructive"), h.Title(row.result)],
									[row.result],
								),
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
					monitor.failures_to_down === 1
						? "1 failure"
						: `${monitor.failures_to_down} failures in a row`,
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
			? "Nobody yet"
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
		fact(h, "Notifies", notifies, count === 0 ? "text-muted-foreground" : undefined),
		serviceHref === null || monitor.service_name === null
			? fact(h, "Service", "None", "text-muted-foreground")
			: fact(
					h,
					"Service",
					h.a(
						[h.Href(serviceHref), h.Class("text-primary hover:underline")],
						[monitor.service_name],
					),
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
