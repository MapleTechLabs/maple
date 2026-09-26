import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query"
import { HARD_SERIES_LIMIT } from "@maple/ui/components/plot"
import { CH } from "@maple/query-engine"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { SeriesPoint } from "../lib/chart-series"
import type { ChartWindow, TimeBounds } from "../lib/time"
import { isCounter, isMetricType, type MetricType } from "../lib/units"
import { foldCatalogRows, type MetricEntry } from "./use-local-metrics"

/** Catalog row(s) for one metric, aggregated across services. */
export function useLocalMetricEntry(metricName: string, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "metrics", "entry", metricName, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<MetricEntry | null> => {
			const compiled = CH.compile(
				CH.listMetricsQuery({ search: metricName, limit: 50 }),
				localParams(bounds),
			)
			const rows = (await executeLocalCompiledQuery(compiled, signal)).filter(
				(r) => r.metricName === metricName,
			)
			return foldCatalogRows(rows).entries[0] ?? null
		},
	})
}

/**
 * The detail chart draws at most `HARD_SERIES_LIMIT` lines, so cap the series
 * in the query: a high-cardinality install would otherwise fetch and pivot
 * every service's series only for the chart to drop all but 60 of them.
 */
const SERIES_CAP = { groupBy: ["service"], seriesLimit: HARD_SERIES_LIMIT }

export const compileMetricRateTimeseriesQuery = (
	opts: { metricName: string; bucketSeconds: number },
	params: Parameters<typeof CH.compile>[1],
) => CH.compile(CH.metricsTimeseriesRateQuery({ ...opts, ...SERIES_CAP }), params)

export const compileMetricValueTimeseriesQuery = (
	opts: { metricType: MetricType },
	params: Parameters<typeof CH.compile>[1],
) => CH.compile(CH.metricsTimeseriesQuery({ ...opts, ...SERIES_CAP }), params)

/**
 * Detail timeseries, one series per service. Counters plot the true
 * per-second rate (window-CTE query); everything else plots the average value.
 */
export function useLocalMetricTimeseries(
	entry: MetricEntry | null | undefined,
	bounds: TimeBounds,
	window: ChartWindow,
) {
	return useQuery({
		queryKey: [
			"local",
			"metrics",
			"timeseries",
			entry?.metricName,
			entry?.metricType,
			entry?.isMonotonic,
			window.bucketSeconds,
			boundsKey(bounds),
		],
		placeholderData: keepPreviousData,
		queryFn: entry
			? async ({ signal }): Promise<ReadonlyArray<SeriesPoint>> => {
					const { bucketSeconds } = window
					const params = { ...localParams(bounds), bucketSeconds, metricName: entry.metricName }
					if (isCounter(entry)) {
						const rows = await executeLocalCompiledQuery(
							compileMetricRateTimeseriesQuery(
								{ metricName: entry.metricName, bucketSeconds },
								params,
							),
							signal,
						)
						return rows.map((r) => ({
							bucket: r.bucket,
							series: r.groupName || "value",
							value: Number(r.rateValue),
						}))
					}
					const metricType = entry.metricType
					if (!isMetricType(metricType)) return []
					const rows = await executeLocalCompiledQuery(
						compileMetricValueTimeseriesQuery({ metricType }, params),
						signal,
					)
					return rows.map((r) => ({
						bucket: r.bucket,
						series: r.groupName || "value",
						value: Number(r.avgValue),
					}))
				}
			: skipToken,
	})
}

export interface MetricBreakdownRow {
	name: string
	avgValue: number
	sumValue: number
	count: number
}

/** Per-service breakdown for the detail page's table. */
export function useLocalMetricBreakdown(entry: MetricEntry | null | undefined, bounds: TimeBounds) {
	const metricType = entry?.metricType
	return useQuery({
		queryKey: ["local", "metrics", "breakdown", entry?.metricName, metricType, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn:
			entry && metricType && isMetricType(metricType)
				? async ({ signal }): Promise<ReadonlyArray<MetricBreakdownRow>> => {
						const rows = await executeLocalCompiledQuery(
							CH.compile(CH.metricsBreakdownQuery({ metricType, limit: 20 }), {
								...localParams(bounds),
								metricName: entry.metricName,
							}),
							signal,
						)
						return rows.map((r) => ({
							name: r.name,
							avgValue: Number(r.avgValue),
							sumValue: Number(r.sumValue),
							count: Number(r.count),
						}))
					}
				: skipToken,
	})
}
