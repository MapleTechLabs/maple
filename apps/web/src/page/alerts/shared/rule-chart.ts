import type {
	AlertCheckDocument,
	AlertComparator,
	AlertIncidentDocument,
	AlertRulePreviewResponse,
	AlertSignalType,
} from "@maple/domain/http"
import { formatBucketLabel } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { TONE_COLOR, TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import {
	type Band,
	clipToDomain,
	GHOST_KEY,
	mergeGhost,
	projectChecks,
	projectPreview,
	resolveChartDomain,
	resolveSource,
	SIGNAL_SOURCE_LABEL,
	SINGLE_KEY,
	type SignalSource,
} from "@maple/web-data/alerts/chart-series"
import { formatSignalValue } from "@maple/web-data/alerts/form-utils"
import { normalizeTimestampInput } from "@maple/web-data/lib/timezone-format"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { bucketTooltipBody } from "../../../charts/bucket-tooltip"
import type * as Chart from "../../../charts/chart"
import { ChartSpec } from "../../../charts/chart-spec"
import { plotFrame } from "../../../charts/plot-frame"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { pressable } from "../../../ui/pressable"
import { chartEmpty, chartError, chartLoading } from "../../../ui/chart-state"
import { seriesLegend } from "../../kit/series-legend"
import { isoMs } from "./time"

// The view half of the alert rule chart; the
// definition is `charts/definitions/alert-rule.ts`, built by the chart Mount from the spec here.

/** The tokens the chart and its chrome read off the theme (`PAINT_COLORS` plus the frame). */
export const RULE_CHART_TOKENS: ReadonlyArray<string> = [
	"--chart-1",
	"--severity-warn",
	"--severity-info",
	"--severity-error",
	"--muted-foreground",
	"--chart-p50",
	"--chart-p95",
	"--chart-p99",
	"--border",
	"--background",
]

const SIGNAL_TOKEN = "--chart-1"
const CHART_HEIGHT = 300
const Y_AXIS_WIDTH = 72
const PLOT_RIGHT = 12
const RAIL_CELLS = 60

type RailStatus = "breached" | "error" | "skipped" | "healthy" | "empty"
const RAIL_COLOR = new Map<RailStatus, string>([
	["breached", TONE_FILL.crit],
	["error", TONE_FILL.warn],
	["skipped", "bg-foreground-faint"],
	["healthy", "bg-chart-apdex/70"],
	["empty", "bg-surface-sunken"],
])

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)
const num = (value: unknown): number => {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

export type RuleChartInputs<M> = Readonly<{
	chartId: string
	chart: Chart.Model
	toChartMessage: (message: Chart.Message) => M
	colors: ThemeColors
	timeZone: string
	preview: AlertRulePreviewResponse | null
	checks?: ReadonlyArray<AlertCheckDocument>
	incidents?: ReadonlyArray<AlertIncidentDocument>
	showWouldFire?: boolean
	threshold: number
	thresholdUpper?: number | null
	criticalThreshold?: number | null
	comparator: AlertComparator
	signalType: AlertSignalType
	window: Readonly<{ min: number; max: number }>
	source?: SignalSource
	railCoverage?: string
	selectedBucket?: number | null
	/** `onSelectBucket`: the rail cells are buttons when set. */
	onSelectBucket?: (index: number | null) => M
	isLoading?: boolean
	error?: string | null
	className?: string
}>

export const ruleChart = <M>(h: HtmlBuilder<M>, inputs: RuleChartInputs<M>): Html => {
	const checks = inputs.checks ?? []
	const incidents = inputs.incidents ?? []
	const { threshold, signalType } = inputs
	const thresholdUpper = inputs.thresholdUpper ?? null
	const criticalThreshold = inputs.criticalThreshold ?? null
	const { domain, clampedToPreview } = resolveChartDomain(inputs.window, inputs.preview?.truncatedToStart, {
		hasOverlays: checks.length > 0 || incidents.length > 0,
	})
	const previewChart = projectPreview(inputs.preview, domain.max)
	const checksChart = projectChecks(checks)
	const { source, fellBack, bothAvailable } = resolveSource(inputs.source, {
		preview: previewChart.hasPoints,
		checks: checksChart.hasPoints,
	})
	const seriesKeys = source === "preview" ? previewChart.seriesKeys : [SINGLE_KEY]
	const isMultiSeries = source === "preview" && previewChart.isMultiSeries
	const noDataBands: ReadonlyArray<Band> =
		source === "preview" ? clipToDomain(previewChart.noDataBands, domain) : []
	const primary = source === "preview" ? previewChart.rows : checksChart.rows
	const merged =
		source === "none" || isMultiSeries || !bothAvailable
			? { rows: primary, divergence: null }
			: mergeGhost(
					primary,
					source === "preview" ? checksChart.rows : previewChart.rows,
					(domain.max - domain.min) / RAIL_CELLS,
				)
	const chartData = merged.rows
	const hasSignal = chartData.length > 0
	const bucketSeconds =
		inputs.preview != null
			? inputs.preview.bucketSeconds
			: chartData.length >= 2
				? (num(chartData[1]?.t) - num(chartData[0]?.t)) / 1000
				: undefined
	const axisContext = { rangeMs: domain.max - domain.min, bucketSeconds, timeZone: inputs.timeZone }
	const formatTime = (value: number, mode: "tick" | "tooltip") =>
		formatBucketLabel(new Date(value).toISOString(), axisContext, mode)
	const seriesColors = resolveSeriesColors(seriesKeys)
	const otherSource: SignalSource = source === "preview" ? "checks" : "preview"
	const hasGhost = source !== "none" && !isMultiSeries && bothAvailable
	const labelOf = (key: string) =>
		isMultiSeries ? key : source === "none" ? "Observed" : SIGNAL_SOURCE_LABEL[source]

	const maxVal = chartData.reduce(
		(max, point) =>
			Math.max(
				max,
				...seriesKeys.map((key) => num(point[key])),
				point[GHOST_KEY] != null ? num(point[GHOST_KEY]) : 0,
			),
		Math.max(threshold, thresholdUpper ?? threshold, criticalThreshold ?? threshold),
	)
	const upper = Math.max(maxVal * 1.15, threshold * 1.3)
	const breachBelow = inputs.comparator === "lt" || inputs.comparator === "lte"

	const incidentBands = clipToDomain(
		incidents.map((incident) => ({
			x1: new Date(incident.firstTriggeredAt).getTime(),
			x2: incident.resolvedAt
				? new Date(incident.resolvedAt).getTime()
				: incident.heldSince
					? isoMs(incident.heldSince)
					: domain.max,
			open: incident.status === "open",
		})),
		domain,
	)
	const heldBands = clipToDomain(
		incidents.flatMap((incident) =>
			incident.status === "open" && incident.heldSince
				? [{ x1: isoMs(incident.heldSince), x2: domain.max }]
				: [],
		),
		domain,
	)
	const wouldFireBands =
		inputs.showWouldFire !== true || inputs.preview == null
			? []
			: clipToDomain(
					inputs.preview.wouldFire.map((span) => ({ x1: isoMs(span.start), x2: isoMs(span.end) })),
					domain,
				)
	const plain = (bands: ReadonlyArray<Band>) => bands.map((band) => ({ x1: band.x1, x2: band.x2 }))
	const resolved = (token: string) => resolveColor(inputs.colors, token)

	const spec = ChartSpec.AlertRule({
		rows: chartData.map((row) => ({ ...row })),
		seriesKeys,
		labels: Object.fromEntries([
			...seriesKeys.map((key) => [key, labelOf(key)] as const),
			...(hasGhost ? [[GHOST_KEY, SIGNAL_SOURCE_LABEL[otherSource]] as const] : []),
		]),
		isMultiSeries,
		hasGhost,
		colors: {
			signal: resolved(SIGNAL_TOKEN),
			destructive: resolved("--severity-error"),
			warn: resolved("--severity-warn"),
			muted: resolved("--muted-foreground"),
			border: resolved("--border"),
			background: resolved("--background"),
			...Object.fromEntries(
				seriesKeys.map((key) => [key, resolved(seriesColors.get(key) ?? SIGNAL_TOKEN)]),
			),
		},
		domainMin: domain.min,
		domainMax: domain.max,
		yMax: upper > 0 ? upper : 1,
		threshold,
		thresholdUpper,
		criticalThreshold,
		comparator: inputs.comparator,
		signalType,
		bands: {
			noData: plain(noDataBands),
			incidentOpen: plain(incidentBands.filter((band) => band.open)),
			incidentClosed: plain(incidentBands.filter((band) => !band.open)),
			held: plain(heldBands),
			wouldFire: plain(wouldFireBands),
		},
		meta: [...previewChart.meta.entries()].map(([t, meta]) => ({
			t,
			sampleCount: meta.sampleCount,
			status: meta.status,
			provisional: meta.provisional,
		})),
		timeZone: inputs.timeZone,
		bucketSeconds: bucketSeconds ?? null,
		gradientId: `${inputs.chartId}-signal`,
	})

	const chartArea = hasSignal
		? h.div(
				[h.Class("w-full")],
				[
					...(isMultiSeries
						? [
								seriesLegend(h, {
									className:
										"h-8 flex-nowrap justify-start overflow-x-auto whitespace-nowrap",
									items: seriesKeys.map((key) => ({
										key,
										label: key,
										color: resolved(seriesColors.get(key) ?? SIGNAL_TOKEN),
									})),
								}),
							]
						: []),
					h.div(
						[h.Class("w-full"), h.Style({ height: `${CHART_HEIGHT}px` })],
						[
							h.submodel({
								slotId: inputs.chartId,
								model: inputs.chart,
								view: chartView,
								viewInputs: { chartId: inputs.chartId, spec },
								toParentMessage: inputs.toChartMessage,
							}),
						],
					),
				],
			)
		: inputs.isLoading === true
			? chartLoading(h, { variant: "area", height: CHART_HEIGHT })
			: inputs.error != null
				? chartError(h, { height: CHART_HEIGHT }, [
						h.div(
							[h.Class("max-w-sm space-y-2")],
							[
								h.p([h.Class("font-medium text-sm")], ["Preview query failed"]),
								h.p([h.Class("line-clamp-3 text-muted-foreground")], [inputs.error]),
							],
						),
					])
				: chartEmpty(h, { height: CHART_HEIGHT, hint: "Try widening the range" }, [
						"No data in this window",
					])

	const thresholdCaption = h.div(
		[h.Class("flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground")],
		[
			h.span(
				[h.Class("flex items-center gap-2")],
				[
					h.span([
						h.AriaHidden(true),
						h.Class(
							cn(
								"inline-block h-0 w-4 shrink-0 border-t-[1.5px] border-dashed",
								criticalThreshold != null ? "border-severity-warn" : "border-severity-error",
							),
						),
					]),
					h.span(
						[],
						[
							...(criticalThreshold != null ? ["Warning "] : []),
							thresholdUpper != null
								? "Threshold range "
								: breachBelow
									? criticalThreshold != null
										? "below "
										: "Breach below "
									: criticalThreshold != null
										? "above "
										: "Breach above ",
							h.span(
								[h.Class("font-mono font-medium text-foreground")],
								[
									formatSignalValue(signalType, threshold),
									...(thresholdUpper != null
										? [` – ${formatSignalValue(signalType, thresholdUpper)}`]
										: []),
								],
							),
						],
					),
				],
			),
			...(criticalThreshold != null
				? [
						h.span(
							[h.Class("flex items-center gap-2")],
							[
								h.span([
									h.AriaHidden(true),
									h.Class(
										"inline-block h-0 w-4 shrink-0 border-t-[1.5px] border-dashed border-severity-error",
									),
								]),
								h.span(
									[],
									[
										"Critical ",
										breachBelow ? "below " : "above ",
										h.span(
											[h.Class("font-mono font-medium text-foreground")],
											[formatSignalValue(signalType, criticalThreshold)],
										),
									],
								),
							],
						),
					]
				: []),
		],
	)

	const fellBackNote = h.div(
		[h.Class("flex items-start gap-2.5 border-l-2 border-severity-warn py-0.5 pl-2.5")],
		[
			h.div(
				[h.Class("space-y-0.5")],
				[
					h.p(
						[h.Class("text-foreground text-xs")],
						[
							"Showing",
							" ",
							h.span(
								[h.Class("font-medium")],
								[source === "none" ? "" : SIGNAL_SOURCE_LABEL[source]],
							),
							" ",
							"— ",
							SIGNAL_SOURCE_LABEL[otherSource].toLowerCase(),
							" has no points in this window.",
						],
					),
					...(inputs.error != null
						? [h.p([h.Class("line-clamp-2 text-2xs text-muted-foreground")], [inputs.error])]
						: []),
				],
			),
		],
	)

	const ghostNote = h.div(
		[h.Class("flex items-center gap-3 text-2xs text-muted-foreground")],
		[
			h.span(
				[h.Class("flex items-center gap-1.5")],
				[
					h.span([
						h.AriaHidden(true),
						h.Class(
							"inline-block h-0 w-4 shrink-0 border-t-[1.5px] border-dashed border-muted-foreground",
						),
					]),
					SIGNAL_SOURCE_LABEL[otherSource],
				],
			),
			...(merged.divergence != null && merged.divergence > Math.abs(threshold) * 0.05
				? [
						badge(h, { variant: "warn", size: "xs" }, [
							"Sources differ by up to ",
							formatSignalValue(signalType, merged.divergence),
						]),
					]
				: []),
		],
	)

	const truncatedTo = inputs.preview?.truncatedToStart ?? null

	return h.div(
		[h.Class(cn("space-y-2", inputs.className))],
		[
			chartArea,
			...(hasSignal ? [thresholdCaption] : []),
			...(hasSignal && fellBack ? [fellBackNote] : []),
			...(hasSignal && hasGhost ? [ghostNote] : []),
			...(inputs.showWouldFire === true && wouldFireBands.length > 0
				? [
						h.p(
							[h.Class("text-2xs text-muted-foreground")],
							[
								"Shaded: rule would have fired (approximate: the live scheduler checks a sliding window).",
							],
						),
					]
				: []),
			...(hasSignal && heldBands.length > 0
				? [
						h.p(
							[h.Class("text-2xs text-muted-foreground")],
							["Grey tail: incident held, waiting on data."],
						),
					]
				: []),
			...(hasSignal && source === "preview" && noDataBands.length > 0
				? [
						h.p(
							[h.Class("text-2xs text-muted-foreground")],
							["Hatched: no data received in these windows."],
						),
					]
				: []),
			...(truncatedTo !== null
				? [
						h.p(
							[h.Class("text-2xs text-muted-foreground")],
							[
								clampedToPreview ? "Axis starts at " : "Query series starts at ",
								formatTime(isoMs(truncatedTo), "tooltip"),
								". The range needs more windows than one preview replays: widen the rule's window or shorten the range.",
							],
						),
					]
				: []),
			...(checks.length > 0 ? [rail(h, inputs, checks, domain, incidentBands, formatTime)] : []),
		],
	)
}

const chartView = Submodel.defineView<
	Chart.Model,
	Chart.Message,
	Readonly<{ chartId: string; spec: ChartSpec }>
>((model, inputs, h) =>
	plotFrame(h, {
		chartId: inputs.chartId,
		spec: inputs.spec,
		ariaLabel: "Alert signal",
		className: "h-full w-full",
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				tooltip._tag === "Bucket"
					? Option.some(bucketTooltipBody(h, tooltip, portal))
					: Option.none(),
			),
	}),
)

// THE RAIL: evaluations as discrete cells, incidents as a continuous bar.

/** One rail cell's tally while the checks are folded in. */
type RailBucket = {
	breached: number
	healthy: number
	skipped: number
	noData: number
	errored: number
	opened: boolean
	errorMessage: string | null
}

const rail = <M>(
	h: HtmlBuilder<M>,
	inputs: RuleChartInputs<M>,
	checks: ReadonlyArray<AlertCheckDocument>,
	domain: Readonly<{ min: number; max: number }>,
	incidentBands: ReadonlyArray<Band & { readonly open: boolean }>,
	formatTime: (value: number, mode: "tick" | "tooltip") => string,
): Html => {
	const range = Math.max(1, domain.max - domain.min)
	const empty = (): RailBucket => ({
		breached: 0,
		healthy: 0,
		skipped: 0,
		noData: 0,
		errored: 0,
		opened: false,
		errorMessage: null,
	})
	const buckets = checks.reduce(
		(acc, check) => {
			const t = new Date(normalizeTimestampInput(check.timestamp)).getTime()
			if (!Number.isFinite(t)) return acc
			const index = Math.floor(((t - domain.min) / range) * RAIL_CELLS)
			const bucket = acc[index]
			if (index < 0 || index >= RAIL_CELLS || bucket === undefined) return acc
			if (check.status === "breached") bucket.breached += 1
			else if (check.status === "healthy") bucket.healthy += 1
			else if (check.status === "error") {
				bucket.errored += 1
				if (bucket.errorMessage == null && check.errorMessage != null)
					bucket.errorMessage = check.errorMessage
			} else {
				bucket.skipped += 1
				if (check.skipReason === "no_data") bucket.noData += 1
			}
			if (check.incidentTransition === "opened") bucket.opened = true
			return acc
		},
		Array.from({ length: RAIL_CELLS }, empty),
	)
	const cells = buckets.map((bucket, i) => {
		const total = bucket.breached + bucket.healthy + bucket.skipped + bucket.errored
		const status: RailStatus =
			total === 0
				? "empty"
				: bucket.errored > 0
					? "error"
					: bucket.breached > 0
						? "breached"
						: bucket.healthy > 0
							? "healthy"
							: "skipped"
		const start = domain.min + (i / RAIL_CELLS) * range
		const end = domain.min + ((i + 1) / RAIL_CELLS) * range
		const counts = [
			bucket.errored > 0 ? `${bucket.errored} failed` : null,
			bucket.breached > 0 ? `${bucket.breached} breached` : null,
			bucket.healthy > 0 ? `${bucket.healthy} healthy` : null,
			bucket.skipped > 0
				? bucket.noData > 0
					? `${bucket.skipped} skipped (${bucket.noData} no data)`
					: `${bucket.skipped} skipped`
				: null,
		]
			.filter((part) => part !== null)
			.join(", ")
		const window = `${formatTime(start, "tick")} – ${formatTime(end, "tick")}`
		const title =
			total === 0
				? `${window} · no checks`
				: `${window} · ${counts}${bucket.opened ? " · incident opened" : ""}${bucket.errorMessage != null ? ` · ${bucket.errorMessage}` : ""}`
		return { status, opened: bucket.opened, title }
	})
	const totals = checks.reduce(
		(acc, check) =>
			check.status === "breached"
				? { ...acc, breached: acc.breached + 1 }
				: check.status === "healthy"
					? { ...acc, healthy: acc.healthy + 1 }
					: check.status === "error"
						? { ...acc, errored: acc.errored + 1 }
						: { ...acc, skipped: acc.skipped + 1 },
		{ breached: 0, healthy: 0, skipped: 0, errored: 0 },
	)
	const spans = incidentBands.map((band) => ({
		left: (clamp01((band.x1 - domain.min) / range) * 100).toFixed(4),
		width: (clamp01((Math.max(band.x2, band.x1) - band.x1) / range) * 100).toFixed(4),
		open: band.open,
	}))
	const selected = inputs.selectedBucket ?? null
	const onSelect = inputs.onSelectBucket
	const gutter = (label: string) =>
		eyebrow(
			h,
			{ className: "shrink-0 pr-3 text-right", attributes: [h.Style({ width: `${Y_AXIS_WIDTH}px` })] },
			[label],
		)
	return h.div(
		[h.Class("space-y-1.5 pt-1"), h.Style({ "padding-right": `${PLOT_RIGHT}px` })],
		[
			h.div(
				[h.Class("flex items-center")],
				[
					gutter("Eval"),
					h.div(
						[h.Class("flex h-3.5 flex-1 gap-px")],
						cells.map((cell, i) => {
							const isSelected = selected === i
							return pressable(
								h,
								{
									label: cell.title,
									isSelected,
									isDisabled: onSelect === undefined,
									onClick:
										onSelect === undefined ? undefined : onSelect(isSelected ? null : i),
									// A read-only rail keeps its colours: no dimming, no pointer.
									className: cn(
										"h-full flex-1 rounded-2xs p-0 disabled:cursor-default disabled:opacity-100",
										RAIL_COLOR.get(cell.status),
										cell.opened && "ring-1 ring-inset ring-severity-error",
										isSelected && "ring-2 ring-foreground ring-offset-0",
									),
									attributes: [h.Title(cell.title)],
								},
								[],
							)
						}),
					),
				],
			),
			h.div(
				[h.Class("flex items-center")],
				[
					gutter("Incident"),
					h.div(
						[h.Class("relative h-1 flex-1 rounded-2xs bg-surface-strong")],
						spans.map((span) =>
							h.div([
								h.Class(
									cn(
										"absolute inset-y-0 rounded-2xs bg-severity-error",
										!span.open && "opacity-60",
									),
								),
								h.Style({ left: `${span.left}%`, width: `${span.width}%` }),
							]),
						),
					),
				],
			),
			h.div(
				[
					h.Class(
						"flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pt-0.5 text-2xs text-muted-foreground",
					),
					h.Style({ "padding-left": `${Y_AXIS_WIDTH}px` }),
				],
				[
					seriesLegend(h, {
						className: "justify-start",
						items: [
							{
								key: "healthy",
								label: "Healthy",
								value: totals.healthy,
								color: "color-mix(in oklab, var(--color-chart-apdex) 70%, transparent)",
							},
							{
								key: "breached",
								label: "Breached",
								value: totals.breached,
								color: TONE_COLOR.crit,
							},
							...(totals.errored > 0
								? [
										{
											key: "errored",
											label: "Failed",
											value: totals.errored,
											color: TONE_COLOR.warn,
										},
									]
								: []),
							...(totals.skipped > 0
								? [
										{
											key: "skipped",
											label: "Skipped",
											value: totals.skipped,
											color: "color-mix(in oklab, var(--color-muted-foreground) 30%, transparent)",
										},
									]
								: []),
						],
					}),
					...(inputs.railCoverage === undefined ? [] : [h.span([], [inputs.railCoverage])]),
				],
			),
		],
	)
}
