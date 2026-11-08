import { formatNumber } from "@maple/ui/lib/format"
import { Option, Array as Arr } from "effect"
import { Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { bucketTooltipBody } from "@maple/views/charts/bucket-tooltip"
import type { Message, Model } from "@maple/views/charts/chart"
import type { ChartSpec } from "@maple/views/charts/chart-spec"
import { plotFrame } from "@maple/views/charts/plot-frame"
import { resolveColor, type ThemeColors } from "@maple/views/charts/theme-colors"
import { CHART_HEIGHT, chartCard, chartCardMessage } from "../infra-integrations/kit/chart-card"
import { seriesLegend } from "../kit/series-legend"

// The Search tab's trend: clicks per Google day, on the traffic chart. Impressions run orders of
// magnitude higher and would flatten clicks on one linear axis; the KPI row carries them.

export type SearchTrendInputs = Readonly<{
	points: ReadonlyArray<Readonly<{ date: string; clicks: number }>>
	theme: ThemeColors
	isNarrow: boolean
}>

export const searchTrendChart = Submodel.defineView<Model, Message, SearchTrendInputs>(
	(model, inputs, h): Html => {
		// Google's days are calendar days; the bucket axis reads them as UTC midnights.
		const points = Arr.map(inputs.points, (point) => ({
			bucket: `${point.date}T00:00:00Z`,
			primary: point.clicks,
		}))
		const clicks = Arr.reduce(inputs.points, 0, (sum, point) => sum + point.clicks)
		const spec: ChartSpec = {
			_tag: "AnalyticsTraffic",
			points,
			series: [{ key: "primary", metric: "searchClicks", label: "Clicks" }],
			tickMetric: "sessions",
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
		const legend = seriesLegend(h, {
			items: [
				{ key: "primary", label: "Clicks", color: "var(--primary)", value: formatNumber(clicks) },
			],
		})
		return chartCard(h, { title: "Clicks", legend }, [
			points.length === 0
				? chartCardMessage(h, "No search data in this window")
				: h.div(
						[h.Class("w-full"), h.Style({ height: `${CHART_HEIGHT}px` })],
						[
							plotFrame(h, {
								chartId: "search-trend",
								spec,
								ariaLabel: "Search clicks per day",
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
