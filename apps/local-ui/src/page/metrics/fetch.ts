import { CH } from "@maple/query-engine"
import type { TimeBounds } from "../../lib/time"
import { isMetricType } from "../../lib/units"
import { DateTime, Effect, Schema } from "effect"
import { localParams, queryRows } from "../../data/local-query"
import { foldCatalogRows } from "./catalog"

// The Metrics page's queries.

export const SummaryRow = Schema.Struct({
	metricType: Schema.String,
	metricCount: Schema.Number,
	dataPointCount: Schema.Number,
})
export type SummaryRow = typeof SummaryRow.Type

export const SparklinePoint = Schema.Struct({
	bucket: Schema.String,
	avgValue: Schema.Number,
	sumValue: Schema.Number,
	dataPointCount: Schema.Number,
})
export type SparklinePoint = typeof SparklinePoint.Type

/** The batched previews, by metric name in arrival order (`ReadonlyMap` as data). */
export const MetricSparkline = Schema.Struct({
	metricName: Schema.String,
	points: Schema.Array(SparklinePoint),
})
export type MetricSparkline = typeof MetricSparkline.Type

/** One sparkline query per metric type: `[metricType, metricNames]`, sorted by type. */
export const SparklineGroup = Schema.Tuple([Schema.String, Schema.Array(Schema.String)])
export type SparklineGroup = typeof SparklineGroup.Type

/** The catalog over the hourly rollup (the service filter is client-side). */
export const fetchMetricsList = (
	filters: Readonly<{ type?: string; search?: string }>,
	bounds: TimeBounds,
	apiBase: string,
) =>
	Effect.map(
		queryRows(
			CH.compile(
				CH.listMetricsQuery({ metricType: filters.type, search: filters.search, limit: 500 }),
				localParams(bounds),
			),
			apiBase,
		),
		foldCatalogRows,
	)

/** Per-type metric and datapoint counts. */
export const fetchMetricsSummary = (service: string | undefined, bounds: TimeBounds, apiBase: string) =>
	Effect.map(
		queryRows(CH.compile(CH.metricsSummaryQuery({ serviceName: service }), localParams(bounds)), apiBase),
		(rows): ReadonlyArray<SummaryRow> =>
			rows.map((r) => ({
				metricType: r.metricType,
				metricCount: r.metricCount,
				dataPointCount: r.dataPointCount,
			})),
	)

/** Sparklines: one query per metric type, folded into points by metric. */
export const fetchSparklines = (
	groups: ReadonlyArray<SparklineGroup>,
	bounds: TimeBounds,
	bucketSeconds: number,
	apiBase: string,
) =>
	Effect.gen(function* () {
		const params = { ...localParams(bounds), bucketSeconds }
		const results = yield* Effect.forEach(
			groups.flatMap(([metricType, metricNames]) =>
				isMetricType(metricType) ? [{ metricType, metricNames }] : [],
			),
			({ metricType, metricNames }) =>
				queryRows(
					CH.compile(
						CH.metricsSparklinesQuery({ metricType, metricNames: [...metricNames] }),
						params,
					),
					apiBase,
				),
			{ concurrency: "unbounded" },
		)
		const points = new Map<string, Array<SparklinePoint>>()
		results.flat().forEach((row) => {
			const point = {
				bucket: DateTime.formatIso(row.bucket),
				avgValue: row.avgValue,
				sumValue: row.sumValue,
				dataPointCount: row.dataPointCount,
			}
			const list = points.get(row.metricName)
			if (list) list.push(point)
			else points.set(row.metricName, [point])
		})
		return [...points.entries()].map(([metricName, list]): MetricSparkline => ({
			metricName,
			points: list,
		}))
	})
