import {
	type AnalyticsMetricDescriptor,
	type AnalyticsMetricKey,
	type AnalyticsMetricSource,
	findMetric,
} from "../../components/analytics/metrics"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { bucketTooltipBody } from "../../charts/bucket-tooltip"
import type { Message, Model } from "../../charts/chart"
import type { ChartSpec } from "../../charts/chart-spec"
import { plotFrame } from "../../charts/plot-frame"
import { resolveColor, type ThemeColors } from "../../charts/theme-colors"
import { CHART_HEIGHT, chartCard, chartCardMessage } from "../infra-integrations/kit/chart-card"
import { seriesLegend } from "../kit/series-legend"

// `AnalyticsTrafficChart`: the card, its legend
// when paired, and the plot. The definition is `charts/definitions/analytics-traffic.ts`.

export const TRAFFIC_TOKENS = ["--border", "--background", "--primary", "--chart-2"]

const CHART_EMPTY_MESSAGE = "No data for this metric in the selected window."

type Series = Readonly<{
	key: "primary" | "companion"
	descriptor: AnalyticsMetricDescriptor
	token: string
	total: number
}>

/** Plain data only (a submodel's inputs): the descriptors resolve from their keys inside. */
export type TrafficInputs = Readonly<{
	metricKey: AnalyticsMetricKey
	companionKey: AnalyticsMetricKey | undefined
	source: AnalyticsMetricSource
	theme: ThemeColors
	timeZone: string
	/** `useMediaQuery("max-sm")`: the y axis takes a narrower margin. */
	isNarrow: boolean
}>

/** The chart's rows (zero-filled where a metric reports absence as zero) and per-series totals. */
type Resolved = Readonly<{
	metric: AnalyticsMetricDescriptor
	companion: AnalyticsMetricDescriptor | undefined
	source: AnalyticsMetricSource
}>

const trafficData = (inputs: Resolved) => {
	const primaryPoints = inputs.metric.series(inputs.source)
	const companionPoints = inputs.companion?.series(inputs.source) ?? []
	const byBucket = new Map<string, { primary?: number; companion?: number }>()
	primaryPoints.forEach((point) =>
		byBucket.set(point.bucket, { ...byBucket.get(point.bucket), primary: point.value }),
	)
	companionPoints.forEach((point) =>
		byBucket.set(point.bucket, { ...byBucket.get(point.bucket), companion: point.value }),
	)
	const buckets = [...byBucket.keys()].sort()
	const fills = (descriptor: AnalyticsMetricDescriptor | undefined, count: number) =>
		descriptor?.zeroWhenAbsent === true && count > 0
	const fillPrimary = fills(inputs.metric, primaryPoints.length)
	const fillCompanion = fills(inputs.companion, companionPoints.length)
	const points = buckets.map((bucket) => {
		const entry = byBucket.get(bucket) ?? {}
		return {
			bucket,
			primary: entry.primary ?? (fillPrimary ? 0 : null),
			companion: entry.companion ?? (fillCompanion ? 0 : null),
		}
	})
	const series: ReadonlyArray<Series> = [
		{ key: "primary", descriptor: inputs.metric, token: "--primary", total: sum(primaryPoints) },
		...(inputs.companion === undefined
			? []
			: [
					{
						key: "companion" as const,
						descriptor: inputs.companion,
						token: "--chart-2",
						total: sum(companionPoints),
					},
				]),
	]
	return { points, series }
}

const sum = (points: ReadonlyArray<{ readonly value: number }>) =>
	points.reduce((total, point) => total + point.value, 0)

export const trafficChart = Submodel.defineView<Model, Message, TrafficInputs>((model, raw, h): Html => {
	const inputs = {
		...raw,
		metric: findMetric(raw.metricKey),
		companion: raw.companionKey === undefined ? undefined : findMetric(raw.companionKey),
	}
	const { points, series } = trafficData(inputs)
	const painted = [...series].sort((a, b) => b.total - a.total)
	const spec: ChartSpec = {
		_tag: "AnalyticsTraffic",
		points,
		series: painted.map((entry) => ({ key: entry.key, metric: entry.descriptor.key })),
		tickMetric: inputs.metric.key,
		colors: {
			primary: resolveColor(inputs.theme, "--primary"),
			companion: resolveColor(inputs.theme, "--chart-2"),
			border: resolveColor(inputs.theme, "--border"),
			background: resolveColor(inputs.theme, "--background"),
		},
		timeZone: inputs.timeZone,
		gradientPrefix: "analytics-traffic",
		isNarrow: raw.isNarrow,
	}
	const companion = inputs.companion
	const legend =
		companion === undefined
			? undefined
			: seriesLegend(h, {
					items: series.map((entry) => ({
						key: entry.key,
						label: entry.descriptor.label,
						color: `var(${entry.token})`,
						value: entry.descriptor.format(entry.total),
					})),
				})
	return chartCard(
		h,
		{
			title:
				companion === undefined
					? inputs.metric.label
					: `${inputs.metric.label} & ${companion.label.toLowerCase()}`,
			legend,
		},
		[
			points.length === 0
				? chartCardMessage(h, CHART_EMPTY_MESSAGE)
				: h.div(
						[
							h.Class("w-full"),
							h.Style({ height: `${CHART_HEIGHT}px` }),
							h.DataAttribute("linked-cursor-chart", `analytics-${inputs.metric.label}`),
						],
						[
							plotFrame(h, {
								chartId: "analytics-traffic",
								spec,
								ariaLabel: inputs.metric.label,
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
	)
})
