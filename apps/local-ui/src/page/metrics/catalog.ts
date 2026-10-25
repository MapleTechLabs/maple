import type { CH } from "@maple/query-engine"
import { DateTime, Schema } from "effect"

// `MetricEntry` and `foldCatalogRows`: the metric catalog folded from its rows.

/** One metric across all reporting services, aggregated from the catalog rows. */
export const MetricEntry = Schema.Struct({
	metricName: Schema.String,
	metricType: Schema.String,
	metricUnit: Schema.String,
	metricDescription: Schema.String,
	serviceNames: Schema.Array(Schema.String),
	dataPointCount: Schema.Number,
	firstSeen: Schema.String,
	lastSeen: Schema.String,
	isMonotonic: Schema.Boolean,
})
export type MetricEntry = typeof MetricEntry.Type

export const FacetOption = Schema.Struct({ name: Schema.String, count: Schema.Number })
export type FacetOption = typeof FacetOption.Type

export const MetricsListData = Schema.Struct({
	entries: Schema.Array(MetricEntry),
	serviceFacets: Schema.Array(FacetOption),
})
export type MetricsListData = typeof MetricsListData.Type

type Mutable = { -readonly [K in keyof MetricEntry]: MetricEntry[K] } & { serviceNames: Array<string> }

/** Fold per-service catalog rows into one entry per (metric, type). */
export const foldCatalogRows = (rows: ReadonlyArray<CH.ListMetricsOutput>): MetricsListData => {
	const byMetric = new Map<string, Mutable>()
	const byService = new Map<string, Set<string>>()
	rows.forEach((row) => {
		const key = `${row.metricName}\x00${row.metricType}`
		const existing = byMetric.get(key)
		if (existing) {
			if (!existing.serviceNames.includes(row.serviceName)) existing.serviceNames.push(row.serviceName)
			existing.dataPointCount += row.dataPointCount
			// ISO strings of one format compare chronologically.
			const lastSeen = DateTime.formatIso(row.lastSeen)
			const firstSeen = DateTime.formatIso(row.firstSeen)
			if (lastSeen > existing.lastSeen) existing.lastSeen = lastSeen
			if (firstSeen < existing.firstSeen) existing.firstSeen = firstSeen
		} else {
			byMetric.set(key, {
				metricName: row.metricName,
				metricType: row.metricType,
				metricUnit: row.metricUnit,
				metricDescription: row.metricDescription,
				serviceNames: [row.serviceName],
				dataPointCount: row.dataPointCount,
				firstSeen: DateTime.formatIso(row.firstSeen),
				lastSeen: DateTime.formatIso(row.lastSeen),
				isMonotonic: Number(row.isMonotonic) === 1,
			})
		}
		const metricsOfService = byService.get(row.serviceName) ?? new Set<string>()
		metricsOfService.add(key)
		byService.set(row.serviceName, metricsOfService)
	})
	const serviceFacets = [...byService.entries()]
		.map(([name, metrics]) => ({ name, count: metrics.size }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
	return { entries: [...byMetric.values()], serviceFacets }
}
