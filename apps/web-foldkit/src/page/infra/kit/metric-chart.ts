import type { ChartUnit } from "@maple/web/components/infra/chart-units"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { validateCssColor } from "@maple/ui/lib/sanitizers"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { TONE_BORDER, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { bucketTooltipBody } from "../../../charts/bucket-tooltip"
import type { Message, Model } from "../../../charts/chart"
import type { ChartSpec } from "../../../charts/chart-spec"
import { asChartUnit, infraPoints, labelFor } from "../../../charts/definitions/infra-metric"
import { plotFrame } from "../../../charts/plot-frame"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { chartSkeleton, type ChartSkeletonVariant } from "../../../ui/chart-skeleton"
import { linkedCursorOverlay } from "./linked-cursor"

// `InfraMetricChart` (apps/web/src/components/infra/primitives/infra-metric-chart.tsx), view half,
// and the `ChartPlotArea` / `ChartLoading` / `ChartEmpty` / `ChartError` states it alternates with
// (packages/ui/src/components/charts/_shared/chart-state.tsx).

export const INFRA_METRIC_CHART_HEIGHT = 220

/** Every token an infra chart can resolve: the identity palette is literal, these are not. */
export const INFRA_CHART_TOKENS = [
	"--border",
	"--background",
	"--chart-1",
	"--chart-p50",
	"--chart-p95",
	"--chart-p99",
	"--severity-info",
	"--severity-warn",
	"--destructive",
	"--severity-error",
	"--muted-foreground",
]

/**
 * `canvasSafeThresholdColor` (plot/threshold-rules.ts): a bare `--token` is not a CSS colour, so the
 * 80% rule legacy asks to paint `--severity-warn` falls back to `--destructive`.
 */
const canvasSafeThresholdColor = (theme: ThemeColors, color: string): string => {
	const fallback = resolveColor(theme, "--destructive")
	const validated = validateCssColor(color)
	if (validated === null) return fallback
	const resolved = resolveColor(theme, validated, fallback)
	return /var\(|currentcolor/i.test(resolved) ? fallback : resolved
}

export type InfraSeriesInfo = Readonly<{
	series: ReadonlyArray<string>
	colors: ReadonlyMap<string, string>
	lastValues: Readonly<Record<string, number>>
	labelFor: (name: string) => string
	unit: ChartUnit
}>

export type InfraRow = Readonly<{ bucket: string; attributeValue: string; value: number }>

export type MetricChartInputs = Readonly<{
	chartId: string
	rows: ReadonlyArray<InfraRow>
	unit: string
	seriesLabel?: string
	stacked?: boolean
	showThreshold?: boolean
	linkedChartId?: string
	xDomain?: ReadonlyArray<string>
	gaps?: boolean
	seriesColors?: Readonly<Record<string, string>>
	header?: (h: HtmlBuilder<Message>, info: InfraSeriesInfo) => Html
	isWaiting?: boolean
	/** The `height` prop: the plot's height, and the empty state's (else it fills its plot area). */
	height?: number
	/** The surrounding `ChartPlotArea`'s height (`useChartPlotHeight`). */
	plotAreaHeight?: number
	className?: string
	theme: ThemeColors
	timeZone: string
}>

/** The chart's spec and the header's series info, from the rows as legacy derives them. */
export const infraChartModel = (inputs: MetricChartInputs) => {
	const points = infraPoints({
		rows: inputs.rows,
		gaps: inputs.gaps ?? false,
		xDomain: inputs.xDomain ?? null,
	})
	const tokens = resolveSeriesColors(points.series)
	const colors = new Map(
		points.series.map((name) => [
			name,
			resolveColor(inputs.theme, inputs.seriesColors?.[name] ?? tokens.get(name) ?? "--border"),
		]),
	)
	const latest = points.data[points.data.length - 1]
	const lastValues = Object.fromEntries(
		points.series.flatMap((name) => {
			const value = latest?.[name]
			return typeof value === "number" ? [[name, value]] : []
		}),
	)
	const hasValue = points.data.some((point) =>
		points.series.some((name) => {
			const value = point[name]
			return typeof value === "number" && Number.isFinite(value)
		}),
	)
	const spec: Extract<ChartSpec, { readonly _tag: "InfraMetric" }> = {
		_tag: "InfraMetric",
		rows: inputs.rows,
		unit: inputs.unit,
		seriesLabel: inputs.seriesLabel ?? null,
		stacked: inputs.stacked ?? false,
		showThreshold: inputs.showThreshold ?? false,
		xDomain: inputs.xDomain ?? null,
		gaps: inputs.gaps ?? false,
		colors: Object.fromEntries(colors),
		chrome: {
			border: resolveColor(inputs.theme, "--border"),
			background: resolveColor(inputs.theme, "--background"),
		},
		thresholdColor: canvasSafeThresholdColor(inputs.theme, "--severity-warn"),
		gradientPrefix: `infra-${inputs.chartId}`,
		timeZone: inputs.timeZone,
	}
	const info: InfraSeriesInfo = {
		series: points.series,
		colors,
		lastValues,
		labelFor: labelFor(inputs.seriesLabel ?? null),
		unit: asChartUnit(inputs.unit),
	}
	return { spec, info, hasValue }
}

/** `ChartPlotArea`: reserves the plot box; the states inside fill it. */
export const chartPlotArea = <M>(
	h: HtmlBuilder<M>,
	height: number,
	children: ReadonlyArray<Html>,
	className?: string,
): Html =>
	h.div(
		[
			h.Class(cn("w-full", className)),
			h.Style({ height: `${height}px` }),
			h.DataAttribute("slot", "chart-plot-area"),
		],
		children,
	)

/** `ChartStateBox`: an explicit height, else it fills the plot area it sits in. */
const stateBox = <M>(
	h: HtmlBuilder<M>,
	className: string,
	children: ReadonlyArray<Html | string>,
	height?: number,
): Html =>
	h.div(
		[h.Class(cn("w-full", className)), h.Style({ height: height === undefined ? "100%" : `${height}px` })],
		children,
	)

const MESSAGE_BASE = "flex items-center justify-center px-3 text-center font-mono text-2xs"

/** `EmptyAxes`: three gridlines and a dashed baseline, masked behind the message. */
const emptyAxes = <M>(h: HtmlBuilder<M>): Html => {
	const line = (y: number, opacity: string, dash?: string) =>
		h.line([
			h.Attribute("x1", "0"),
			h.Attribute("y1", String(y)),
			h.Attribute("x2", "100"),
			h.Attribute("y2", String(y)),
			h.Attribute("stroke", "currentColor"),
			h.Attribute("stroke-opacity", opacity),
			h.Attribute("stroke-width", "1"),
			...(dash === undefined ? [] : [h.Attribute("stroke-dasharray", dash)]),
			h.Attribute("vector-effect", "non-scaling-stroke"),
		])
	return h.svg(
		[
			h.Attribute("aria-hidden", "true"),
			h.Attribute("viewBox", "0 0 100 100"),
			h.Attribute("preserveAspectRatio", "none"),
			h.Attribute(
				"class",
				"pointer-events-none absolute inset-0 h-full w-full [mask-image:radial-gradient(ellipse_at_center,transparent_25%,black_75%)]",
			),
		],
		[line(20, "0.14"), line(44, "0.14"), line(68, "0.14"), line(92, "0.4", "3 4")],
	)
}

/** `ChartEmpty`. */
export const chartEmpty = <M>(h: HtmlBuilder<M>, message: string, height?: number): Html =>
	stateBox(
		h,
		cn(MESSAGE_BASE, "relative text-muted-foreground"),
		[
			emptyAxes(h),
			h.div(
				[h.Class("relative flex flex-col items-center gap-1")],
				[h.span([h.Class("text-foreground/70")], [message])],
			),
		],
		height,
	)

/** `ChartLoading`. */
export const chartLoadingIn = <M>(h: HtmlBuilder<M>, variant: ChartSkeletonVariant, height?: number): Html =>
	stateBox(h, "", [chartSkeleton(h, variant)], height)

/** `ChartError`. */
export const chartError = <M>(h: HtmlBuilder<M>, message: string, height?: number): Html =>
	stateBox(h, cn(MESSAGE_BASE, "border bg-severity-error/5", TONE_BORDER.crit, TONE_TEXT.crit), [message], height)

/** `CHART_EMPTY_MESSAGE` (components/common/chart-card.tsx). */
export const CHART_EMPTY_MESSAGE = "No data for this metric in the selected window."

/** `InfraMetricChart`: the header, then the linked-cursor wrapper around `CursorPlot`. */
export const view = Submodel.defineView<Model, Message, MetricChartInputs>((model, inputs, h) => {
	const { spec, info, hasValue } = infraChartModel(inputs)
	if (!hasValue) return chartEmpty(h, CHART_EMPTY_MESSAGE, inputs.height)
	const isWaiting = inputs.isWaiting === true
	const linked = inputs.linkedChartId
	return h.div(
		[h.Class(cn(refreshingClass(isWaiting), inputs.className)), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			...(inputs.header === undefined ? [] : [inputs.header(h, info)]),
			h.div(
				[
					h.Class("relative"),
					...(linked === undefined ? [] : [h.DataAttribute("linked-cursor-chart", linked)]),
				],
				[
					...(linked === undefined ? [] : [linkedCursorOverlay(h, linked)]),
					h.div(
						[
							h.Class("w-full"),
							h.Style({
								height: `${inputs.height ?? inputs.plotAreaHeight ?? INFRA_METRIC_CHART_HEIGHT}px`,
							}),
						],
						[
							plotFrame(h, {
								chartId: inputs.chartId,
								spec,
								ariaLabel: inputs.seriesLabel ?? "Utilization",
								className: "h-full w-full",
								tooltipBody: (portal) =>
									Option.flatMap(model.tooltip, (tooltip) =>
										tooltip._tag === "Bucket"
											? Option.some(bucketTooltipBody(h, tooltip, portal))
											: Option.none(),
									),
							}),
						],
					),
				],
			),
		],
	)
})
