import { Schema } from "effect"

// Pieces both metrics pages read: the catalog row and the sparkline types.

/** `Metric` (`@maple/web-data/warehouse/metrics`): one catalog row per (metric, service). */
export const MetricRow = Schema.Struct({
	metricName: Schema.String,
	metricType: Schema.String,
	serviceName: Schema.String,
	metricDescription: Schema.String,
	metricUnit: Schema.String,
	dataPointCount: Schema.Number,
	firstSeen: Schema.String,
	lastSeen: Schema.String,
	isMonotonic: Schema.Boolean,
})
export type MetricRow = typeof MetricRow.Type

/** The sparkline query's metric types, in read order. */
export const SPARKLINE_METRIC_TYPES = ["sum", "gauge", "histogram", "exponential_histogram"] as const
export type SparklineMetricType = (typeof SPARKLINE_METRIC_TYPES)[number]
