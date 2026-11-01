import { refreshingClass } from "@maple/ui/lib/refreshing"
import { SEVERITY_COLORS, SEVERITY_ORDER } from "@maple/ui/lib/severity"
import { formatBucketLabel, formatNumber } from "@maple/ui/lib/format"
import { eyebrow } from "../../../ui/eyebrow"
import { formatWarehouseDateTime, warehouseDateTimeToIso } from "@maple/query-engine"
import { computeBucketSeconds } from "@maple/web-data/warehouse/timeseries-utils"
import { cn } from "@maple/ui/lib/utils"
import { DateTime, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import type { ChartSpec } from "../../../charts/chart-spec"
import { plotFrame } from "../../../charts/plot-frame"
import { chartError, chartLoading } from "../../../ui/chart-state"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { HISTOGRAM_TARGET_POINTS, volumeSeriesKeys, volumeTotal } from "./derive"
import { Message } from "./message"
import type { Model, VolumeBrush, VolumeBucket } from "./model"
import { bucketTooltipBody } from "../../../charts/bucket-tooltip"

/** The strip is a scrubber above the list, not a chart in its own right. */
export const LOGS_VOLUME_CHART_HEIGHT = 120

const FALLBACK_SEVERITY_TOKEN = "var(--color-muted-foreground)"

/** The custom properties the plot reads: every severity colour plus the chrome border. */
export const VOLUME_THEME_TOKENS = [
	...new Set([...Object.values(SEVERITY_COLORS), FALLBACK_SEVERITY_TOKEN, "--border"]),
]

const severityToken = (key: string) => SEVERITY_COLORS[key.toUpperCase()] ?? FALLBACK_SEVERITY_TOKEN

const volumeSpec = (
	buckets: ReadonlyArray<VolumeBucket>,
	theme: ThemeColors,
	timeZone: string,
	brush: VolumeBrush,
): ChartSpec => {
	const seriesKeys = volumeSeriesKeys(buckets)
	return {
		_tag: "LogsVolume",
		buckets,
		seriesKeys,
		colors: Object.fromEntries(seriesKeys.map((key) => [key, resolveColor(theme, severityToken(key))])),
		border: resolveColor(theme, "--border"),
		selection:
			brush.left !== null && brush.right !== null ? { left: brush.left, right: brush.right } : null,
		isSelecting: brush.isSelecting,
		timeZone,
	}
}

type PlotInputs = Readonly<{ spec: ChartSpec }>

/** `CursorPlot` with `ariaLabel="Log volume by severity"` in its 120px strip. */
const volumePlot = Submodel.defineView<Chart.Model, Chart.Message, PlotInputs>((model, inputs, h) =>
	plotFrame(h, {
		chartId: "logs-volume",
		spec: inputs.spec,
		ariaLabel: "Log volume by severity",
		className: "h-full w-full",
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				tooltip._tag === "Bucket" ? Option.some(bucketTooltipBody(h, tooltip, portal)) : Option.none(),
			),
	}),
)

// EMPTY STRIP

const EMPTY_STRIP_TICKS = 5
const EMPTY_STRIP_BARS = 64

/** Ghost bars: a deterministic silhouette of the histogram, split into severity slices bottom-up. */
const EMPTY_STRIP_BARS_STACKED = Array.from({ length: EMPTY_STRIP_BARS }, (_, i) => {
	const t = i / (EMPTY_STRIP_BARS - 1)
	const wave = 0.5 + 0.3 * Math.sin(t * Math.PI * 3.1 + 0.8) + 0.2 * Math.sin(t * Math.PI * 7.3 + 2.1)
	const total = 0.18 + wave * 0.45
	const warn = total * (0.08 + 0.1 * (0.5 + 0.5 * Math.sin(t * Math.PI * 5.7 + 1.3)))
	const errorPulse = Math.max(0, Math.sin(t * Math.PI * 9.4 + 0.4) - 0.55)
	const error = total * errorPulse * 0.5
	return [
		{ severity: "INFO", height: total - warn - error },
		{ severity: "WARN", height: warn },
		{ severity: "ERROR", height: error },
	]
})

const epochOf = (warehouseTime: string): number =>
	Option.match(DateTime.make(warehouseDateTimeToIso(warehouseTime)), {
		onNone: () => Number.NaN,
		onSome: DateTime.toEpochMillis,
	})

/** `EmptyVolumeStrip`: the strip's height and gutter kept, the window and severities named. */
const emptyStrip = (
	h: HtmlBuilder<Message>,
	window: Readonly<{ startTime: string; endTime: string }>,
	bucketSeconds: number,
	timeZone: string,
	locale: string,
): Html => {
	const startMs = epochOf(window.startTime)
	const rangeMs = Math.max(0, epochOf(window.endTime) - startMs)
	const axisContext = { rangeMs, bucketSeconds, timeZone, locale }
	const ticks = Array.from({ length: EMPTY_STRIP_TICKS }, (_, i) => ({
		label: formatBucketLabel(
			formatWarehouseDateTime(startMs + (rangeMs * i) / (EMPTY_STRIP_TICKS - 1)),
			axisContext,
			"tick",
		),
		left: (i / (EMPTY_STRIP_TICKS - 1)) * 100,
	}))
	const dashed = (className: string) =>
		h.div([h.Class(`absolute inset-x-0 ${className} border-t border-dashed border-border-subtle`)])
	return h.div(
		[
			h.Style({ height: `${LOGS_VOLUME_CHART_HEIGHT}px` }),
			h.Class("flex w-full select-none pt-1 text-muted-foreground"),
			h.AriaLabel("Log volume by severity, no logs in the selected range"),
		],
		[
			h.div(
				[
					h.Class(
						"flex w-10 shrink-0 flex-col justify-end pb-[18px] pr-1 text-right text-3xs leading-none",
					),
				],
				["0"],
			),
			h.div(
				[h.Class("relative flex min-w-0 flex-1 flex-col")],
				[
					h.div(
						[h.Class("relative flex-1")],
						[
							dashed("top-0"),
							dashed("top-1/2"),
							h.div(
								[
									h.AriaHidden(true),
									h.Class("absolute inset-0 flex items-end gap-px opacity-[0.18]"),
								],
								EMPTY_STRIP_BARS_STACKED.map((slices) =>
									h.div(
										[h.Class("flex h-full min-w-0 flex-1 flex-col-reverse")],
										slices.map((slice) =>
											h.div([
												h.Style({
													height: `${slice.height * 100}%`,
													"background-color": SEVERITY_COLORS[slice.severity] ?? "",
												}),
											]),
										),
									),
								),
							),
							h.div(
								[h.Class("absolute inset-0 flex flex-col items-center justify-center gap-2")],
								[
									h.span([h.Class("text-xs")], ["No log volume in this window"]),
									eyebrow(
										h,
										{ as: "ul", className: "flex items-center gap-3 opacity-60" },
										SEVERITY_ORDER.filter((s) => s !== "WARNING").map((severity) =>
											h.li(
												[h.Class("flex items-center gap-1.5")],
												[
													h.span([
														h.Class("size-1.5 rounded-xs"),
														h.Style({
															"background-color":
																SEVERITY_COLORS[severity] ?? "",
														}),
													]),
													severity,
												],
											),
										),
									),
								],
							),
						],
					),
					h.div(
						[h.Class("relative h-4.5 border-t border-border")],
						ticks.map((tick, i) =>
							h.span(
								[
									h.Class("absolute top-1 whitespace-nowrap text-3xs leading-none"),
									h.Style({
										left: `${tick.left}%`,
										transform:
											i === 0
												? "none"
												: i === ticks.length - 1
													? "translateX(-100%)"
													: "translateX(-50%)",
									}),
								],
								[tick.label],
							),
						),
					),
				],
			),
		],
	)
}

const header = (h: HtmlBuilder<Message>, total: number): Html =>
	h.div(
		[h.Class("mb-1 flex items-baseline gap-2")],
		[
			h.span([h.Class("text-sm font-medium")], [formatNumber(total), " logs"]),
			h.span([h.Class("text-xs text-muted-foreground")], ["in selected range"]),
		],
	)

export const volumeChart = (h: HtmlBuilder<Message>, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.volume.data, {
		onEmpty: () => chartLoading(h, { variant: "bar", height: LOGS_VOLUME_CHART_HEIGHT }),
		onFailure: (failure) => chartError(h, { height: LOGS_VOLUME_CHART_HEIGHT }, [failure.message]),
		onData: (buckets) => {
			const isWaiting = AsyncData.isRefreshing(model.volume.data)
			const total = volumeTotal(buckets)
			return h.div(
				[h.Class(refreshingClass(isWaiting)), ...(isWaiting ? [h.AriaBusy(true)] : [])],
				[
					header(h, total),
					total === 0 && model.window !== null
						? emptyStrip(
								h,
								model.window,
								computeBucketSeconds(
									model.window.startTime,
									model.window.endTime,
									HISTOGRAM_TARGET_POINTS,
								),
								timeZone,
								model.locale,
							)
						: model.themeColors === null
							? h.div([h.Style({ height: `${LOGS_VOLUME_CHART_HEIGHT}px` })], [])
							: h.div(
									[
										h.Style({ height: `${LOGS_VOLUME_CHART_HEIGHT}px` }),
										h.Class(cn("w-full select-none", "cursor-crosshair")),
										h.OnPointerDown(() => Option.some(Message.PressedVolumeChart())),
										h.OnPointerUp(() => Option.some(Message.ReleasedVolumeChart())),
										h.OnPointerLeave(() => Option.some(Message.LeftVolumeChart())),
									],
									[
										h.submodel({
											slotId: "logs-volume-plot",
											model: model.volumeChart,
											view: volumePlot,
											viewInputs: {
												spec: volumeSpec(buckets, model.themeColors, timeZone, model.volumeBrush),
											},
											toParentMessage: (message) =>
												Message.GotVolumeChartMessage({ message }),
										}),
									],
								),
				],
			)
		},
	})
