import { validateCssColor } from "@maple/ui/lib/sanitizers"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { chartEmpty } from "../ui/chart-state"
import { eyebrow } from "../ui/eyebrow"
import { bucketTooltipBody } from "./bucket-tooltip"
import type { Message, Model } from "./chart"
import type { ChartSpec } from "./chart-spec"
import { asChartUnit, infraPoints, labelFor } from "./definitions/infra-metric"
import type { ChartEventMarker } from "./event-marker-spec"
import { type ChartUnit, hasPlottableValue, type LongRow, seriesColorTokens } from "./infra-metric-series"
import { linkedCursorOverlay } from "./linked-cursor"
import { plotFrame } from "./plot-frame"
import { resolveColor, type ThemeColors } from "./theme-colors"

// The infra metric chart: the spec
// with every colour resolved, the header's series info, the linked-cursor marker and overlay, and the
// `CursorPlot` box. Embed `view` (a built spec) or `metricView` (rows) with `h.submodel`.

export const INFRA_METRIC_CHART_HEIGHT = 220
/** The empty-chart message. */
export const CHART_EMPTY_MESSAGE = "No data for this metric in this window"

export type InfraMetricSpec = Extract<ChartSpec, { readonly _tag: "InfraMetric" }>

/**
 * `canvasSafeThresholdColor` (plot/threshold-rules.ts): a bare `--token` is not a CSS colour, so the
 * 80% rule's `--severity-warn` falls back to `--destructive`.
 */
const canvasSafeThresholdColor = (theme: ThemeColors, color: string): string => {
	const fallback = resolveColor(theme, "--destructive")
	const validated = validateCssColor(color)
	if (validated === null) return fallback
	const resolved = resolveColor(theme, validated, fallback)
	return /var\(|currentcolor/i.test(resolved) ? fallback : resolved
}

export type InfraMetricOptions = Readonly<{
	rows: ReadonlyArray<LongRow>
	unit: ChartUnit
	seriesLabel?: string
	stacked?: boolean
	showThreshold?: boolean
	xDomain?: ReadonlyArray<string>
	gaps?: boolean
	/** Fixed colours (tokens or literals) for series the name hash cannot see. */
	seriesColors?: Readonly<Record<string, string>>
	theme: ThemeColors
	timeZone: string
	gradientPrefix: string
	/** Deploys, drawn on every strip at the same instant. */
	markers?: ReadonlyArray<ChartEventMarker>
}>

export type InfraSeriesInfo = Readonly<{
	series: ReadonlyArray<string>
	colors: ReadonlyMap<string, string>
	lastValues: Readonly<Record<string, number>>
	labelFor: (name: string) => string
	unit: ChartUnit
}>

/** The spec the Mount builds the definition from, and the header's series info. */
export const infraMetricModel = (options: InfraMetricOptions) => {
	const points = infraPoints({
		rows: options.rows,
		gaps: options.gaps ?? false,
		xDomain: options.xDomain ?? null,
	})
	const tokens = seriesColorTokens(points.series)
	const colors = new Map(
		points.series.map((name) => [
			name,
			resolveColor(options.theme, options.seriesColors?.[name] ?? tokens.get(name) ?? "--border"),
		]),
	)
	const latest = points.data[points.data.length - 1]
	const lastValues = Object.fromEntries(
		points.series.flatMap((name) => {
			const value = latest?.[name]
			return typeof value === "number" ? [[name, value]] : []
		}),
	)
	const spec: InfraMetricSpec = {
		_tag: "InfraMetric",
		rows: options.rows,
		unit: options.unit,
		seriesLabel: options.seriesLabel ?? null,
		stacked: options.stacked ?? false,
		showThreshold: options.showThreshold ?? false,
		xDomain: options.xDomain ?? null,
		gaps: options.gaps ?? false,
		colors: Object.fromEntries(colors),
		chrome: {
			border: resolveColor(options.theme, "--border"),
			background: resolveColor(options.theme, "--background"),
		},
		thresholdColor: canvasSafeThresholdColor(options.theme, "--severity-warn"),
		gradientPrefix: options.gradientPrefix,
		timeZone: options.timeZone,
		markers: options.markers ?? [],
		markerColors: {
			neutral: resolveColor(options.theme, "--muted-foreground"),
			warn: resolveColor(options.theme, "--severity-warn"),
			crit: resolveColor(options.theme, "--severity-error"),
			label: resolveColor(options.theme, "--muted-foreground"),
		},
	}
	const info: InfraSeriesInfo = {
		series: points.series,
		colors,
		lastValues,
		labelFor: labelFor(options.seriesLabel ?? null),
		unit: options.unit,
	}
	return { spec, info }
}

export const infraMetricSpec = (options: InfraMetricOptions): InfraMetricSpec =>
	infraMetricModel(options).spec

export interface InfraMetricChartInputs {
	readonly chartId: string
	readonly spec: InfraMetricSpec
	readonly linkedChartId?: string
	readonly isWaiting?: boolean
	/** The plot's height, and the empty state's (else it fills its plot area). */
	readonly height?: number
	/** The surrounding `ChartPlotArea`'s height (`useChartPlotHeight`). */
	readonly plotAreaHeight?: number
	readonly className?: string
	/** The last-value strip above the plot (`header`). */
	readonly header?: Html
}

const chartBody = (h: HtmlBuilder<Message>, model: Model, inputs: InfraMetricChartInputs): Html => {
	if (!hasPlottableValue(inputs.spec.rows)) {
		return chartEmpty(h, { height: inputs.height }, [CHART_EMPTY_MESSAGE])
	}
	const isWaiting = inputs.isWaiting === true
	const linked = inputs.linkedChartId
	return h.div(
		[h.Class(cn(refreshingClass(isWaiting), inputs.className)), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			...(inputs.header === undefined ? [] : [inputs.header]),
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
								spec: inputs.spec,
								ariaLabel: inputs.spec.seriesLabel ?? "Utilization",
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
}

/** `InfraMetricChart` over a built spec. */
export const view = Submodel.defineView<Model, Message, InfraMetricChartInputs>((model, inputs, h) =>
	chartBody(h, model, inputs),
)

export type MetricChartInputs = Readonly<
	Omit<InfraMetricOptions, "unit" | "gradientPrefix"> &
		Omit<InfraMetricChartInputs, "spec" | "header"> & {
			unit: string
			header?: (h: HtmlBuilder<Message>, info: InfraSeriesInfo) => Html
		}
>

/** `InfraMetricChart` over raw rows: the spec and the header's series info derived here. */
export const metricView = Submodel.defineView<Model, Message, MetricChartInputs>((model, inputs, h) => {
	const { spec, info } = infraMetricModel({
		...inputs,
		unit: asChartUnit(inputs.unit),
		gradientPrefix: `infra-${inputs.chartId}`,
	})
	return chartBody(h, model, { ...inputs, spec, header: inputs.header?.(h, info) })
})

type SeriesHeader = (h: HtmlBuilder<Message>, info: InfraSeriesInfo) => Html

/** A chart-card header: the eyebrow title on the left, the series legend on the right. */
export const titledHeader =
	(title: string, legend: SeriesHeader): SeriesHeader =>
	(h, info) =>
		h.div(
			[h.Class("mb-3 flex min-w-0 items-center justify-between gap-3")],
			[
				eyebrow(h, { variant: "label", as: "h3", className: "shrink-0" }, [title]),
				h.div([h.Class("flex min-w-0 justify-end")], [legend(h, info)]),
			],
		)
