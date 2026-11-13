import { Option, Array as Arr } from "effect"
import { Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { bucketTooltipBody } from "@maple/views/charts/bucket-tooltip"
import type { Message, Model } from "@maple/views/charts/chart"
import type { ChartSpec } from "@maple/views/charts/chart-spec"
import { plotFrame } from "@maple/views/charts/plot-frame"
import { resolveColor, type ThemeColors } from "@maple/views/charts/theme-colors"
import { CHART_HEIGHT, chartCard, chartCardMessage } from "../kit/chart-card"
import type { SearchConsoleSortKey } from "@maple/domain/http"
import { searchMetricOf, type SearchMetrics } from "./search-metrics"

// The Search tab's trend: the picked tile's metric per Google day, on the traffic chart. One
// metric at a time: impressions run orders of magnitude above clicks and would flatten them.

export type SearchTrendInputs = Readonly<{
	metric: SearchConsoleSortKey
	points: ReadonlyArray<SearchMetrics & Readonly<{ date: string }>>
	theme: ThemeColors
	isNarrow: boolean
}>

/** The chart card's title and the line under it, the same while the trend loads or fails. */
export const searchTrendHeading = (key: SearchConsoleSortKey | null) => {
	const metric = searchMetricOf(key)
	return { title: `${metric.label} per day`, description: metric.hint }
}

export const searchTrendChart = Submodel.defineView<Model, Message, SearchTrendInputs>(
	(model, inputs, h): Html => {
		const metric = searchMetricOf(inputs.metric)
		// CTR and position are derived from impressions; clicks and impressions are plain counts.
		const needsImpressions = metric.valueFormat !== "count"
		// Google's days are calendar days; the bucket axis reads them as UTC midnights. A day
		// nobody saw the site has no CTR or position, so the line breaks there.
		const points = Arr.map(inputs.points, (point) => ({
			bucket: `${point.date}T00:00:00Z`,
			primary: needsImpressions && point.impressions === 0 ? null : point[metric.key],
		}))
		const spec: ChartSpec = {
			_tag: "AnalyticsTraffic",
			points,
			series: [{ key: "primary", metric: `search-${metric.key}`, label: metric.label }],
			tickMetric: "sessions",
			valueFormat: metric.valueFormat,
			colors: {
				primary: resolveColor(inputs.theme, "--primary"),
				companion: resolveColor(inputs.theme, "--chart-2"),
				border: resolveColor(inputs.theme, "--border"),
				background: resolveColor(inputs.theme, "--background"),
			},
			timeZone: "UTC",
			gradientPrefix: "search-trend",
			isNarrow: inputs.isNarrow,
		}
		return chartCard(h, searchTrendHeading(inputs.metric), [
			points.length === 0
				? chartCardMessage(h, "No search data in this window")
				: h.div(
						[h.Class("w-full"), h.Style({ height: `${CHART_HEIGHT}px` })],
						[
							plotFrame(h, {
								chartId: "search-trend",
								spec,
								ariaLabel: searchTrendHeading(inputs.metric).title,
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
		])
	},
)
