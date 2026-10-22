import { CH } from "@maple/query-engine"
import type { TimeBounds } from "../../lib/time"
import { isCounter, isMetricType } from "../../lib/units"
import { DateTime, Effect, Schema } from "effect"
import { localParams, queryRows } from "../../data/local-query"
import { foldCatalogRows, type MetricEntry } from "../metrics/catalog"

// The metric detail page's queries.

/** `HARD_SERIES_LIMIT` (packages/ui/src/components/plot/timeseries.tsx). */
const HARD_SERIES_LIMIT = 60

/** The chart draws at most `HARD_SERIES_LIMIT` lines, so the query caps the series too. */
const SERIES_CAP = { groupBy: ["service"], seriesLimit: HARD_SERIES_LIMIT }

export const SeriesPoint = Schema.Struct({
	bucket: Schema.String,
	series: Schema.String,
	value: Schema.Number,
})
export type SeriesPoint = typeof SeriesPoint.Type

export const BreakdownRow = Schema.Struct({
	name: Schema.String,
	avgValue: Schema.Number,
	sumValue: Schema.Number,
	count: Schema.Number,
})
export type BreakdownRow = typeof BreakdownRow.Type

/** The catalog rows for one metric, folded across services. */
export const fetchMetricEntry = (metricName: string, bounds: TimeBounds, apiBase: string) =>
	Effect.map(
		queryRows(
			CH.compile(CH.listMetricsQuery({ search: metricName, limit: 50 }), localParams(bounds)),
			apiBase,
		),
		(rows): MetricEntry | null =>
			foldCatalogRows(rows.filter((r) => r.metricName === metricName)).entries[0] ?? null,
	)

/** The timeseries: counters plot their per-second rate, the rest their average. */
export const fetchMetricTimeseries = (
	entry: MetricEntry,
	bounds: TimeBounds,
	bucketSeconds: number,
	apiBase: string,
) =>
	Effect.gen(function* () {
		const params = { ...localParams(bounds), bucketSeconds, metricName: entry.metricName }
		if (isCounter(entry)) {
			const rows = yield* queryRows(
				CH.compile(
					CH.metricsTimeseriesRateQuery({
						metricName: entry.metricName,
						bucketSeconds,
						...SERIES_CAP,
					}),
					params,
				),
				apiBase,
			)
			return rows.map((r): SeriesPoint => ({
				bucket: DateTime.formatIso(r.bucket),
				series: r.groupName || "value",
				value: r.rateValue,
			}))
		}
		const metricType = entry.metricType
		if (!isMetricType(metricType)) return []
		const rows = yield* queryRows(
			CH.compile(CH.metricsTimeseriesQuery({ metricType, ...SERIES_CAP }), params),
			apiBase,
		)
		return rows.map((r): SeriesPoint => ({
			bucket: DateTime.formatIso(r.bucket),
			series: r.groupName || "value",
			value: r.avgValue,
		}))
	})

/** The per-service table. */
export const fetchMetricBreakdown = (entry: MetricEntry, bounds: TimeBounds, apiBase: string) => {
	const metricType = entry.metricType
	if (!isMetricType(metricType)) return Effect.succeed<ReadonlyArray<BreakdownRow>>([])
	return Effect.map(
		queryRows(
			CH.compile(CH.metricsBreakdownQuery({ metricType, limit: 20 }), {
				...localParams(bounds),
				metricName: entry.metricName,
			}),
			apiBase,
		),
		(rows): ReadonlyArray<BreakdownRow> =>
			rows.map((r) => ({ name: r.name, avgValue: r.avgValue, sumValue: r.sumValue, count: r.count })),
	)
}
