import type { SearchConsoleOverview, SearchConsoleSortKey } from "@maple/domain/http"
import { EMPTY_VALUE, formatNumber, formatPercent } from "@maple/ui/lib/format"
import type { ChartSpec } from "@maple/views/charts/chart-spec"
import { Array as Arr, Option } from "effect"

// Google's four search metrics as the Search tab reads them: a tile, the chart, a table column.

/** The four numbers every Search Console row carries. */
export type SearchMetrics = SearchConsoleOverview["previous"]

type TrafficSpec = Extract<ChartSpec, { readonly _tag: "AnalyticsTraffic" }>

export type SearchMetricDescriptor = Readonly<{
	key: SearchConsoleSortKey
	label: string
	/** What the number means, under the chart's title while the metric is picked. */
	hint: string
	/** CTR and position read empty with no impressions: there is nothing to divide by. */
	format: (metrics: SearchMetrics) => string
	/** Lower is better, so a drop is the good direction. */
	isInverted: boolean
	/** How the chart writes the value. */
	valueFormat: NonNullable<TrafficSpec["valueFormat"]>
}>

const whenSeen = (metrics: SearchMetrics, text: string): string =>
	metrics.impressions > 0 ? text : EMPTY_VALUE

export const SEARCH_METRICS: Arr.NonEmptyReadonlyArray<SearchMetricDescriptor> = [
	{
		key: "clicks",
		label: "Clicks",
		hint: "How often someone clicked through to this site from Google",
		format: (metrics) => formatNumber(metrics.clicks),
		isInverted: false,
		valueFormat: "count",
	},
	{
		key: "impressions",
		label: "Impressions",
		hint: "How often a result from this site was shown on Google",
		format: (metrics) => formatNumber(metrics.impressions),
		isInverted: false,
		valueFormat: "count",
	},
	{
		key: "ctr",
		label: "CTR",
		hint: "The share of impressions that became a click",
		format: (metrics) => whenSeen(metrics, formatPercent(metrics.ctr)),
		isInverted: false,
		valueFormat: "percent",
	},
	{
		key: "position",
		label: "Avg position",
		hint: "Where this site ranked on average, weighted by impressions. Lower is better.",
		format: (metrics) => whenSeen(metrics, metrics.position.toFixed(1)),
		isInverted: true,
		valueFormat: "decimal",
	},
]

export const searchMetricOf = (key: SearchConsoleSortKey | null): SearchMetricDescriptor =>
	Option.getOrElse(
		Arr.findFirst(SEARCH_METRICS, (metric) => metric.key === key),
		() => SEARCH_METRICS[0],
	)
