import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../ui/display"

// Pieces both metrics pages read: the catalog row, the type badge and the type colours.

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

// copied: `metricTypeConfig` and `METRIC_TYPE_COLORS` (packages/ui/src/components/metrics/metric-type-badge.tsx, a React module).
const METRIC_TYPE_CONFIG = new Map<string, Readonly<{ label: string; className: string }>>([
	["sum", { label: "Sum", className: "bg-chart-p50/15 text-chart-p50" }],
	["gauge", { label: "Gauge", className: "bg-severity-info-a2 text-severity-info" }],
	["histogram", { label: "Histogram", className: "bg-chart-4/15 text-chart-4" }],
	["exponential_histogram", { label: "Exp Hist", className: "bg-primary-a2 text-primary" }],
])

export const METRIC_TYPE_COLORS = new Map<string, string>([
	["sum", "var(--chart-p50)"],
	["gauge", "var(--severity-info)"],
	["histogram", "var(--chart-4)"],
	["exponential_histogram", "var(--primary)"],
])

/** The type's short label ("Exp Hist"), or the raw type when it is unknown. */
export const metricTypeLabel = (type: string): string => METRIC_TYPE_CONFIG.get(type)?.label ?? type

/** `MetricTypeBadge`. */
export const metricTypeBadge = <M>(h: HtmlBuilder<M>, type: string): Html => {
	const config = METRIC_TYPE_CONFIG.get(type) ?? {
		label: type,
		className: "bg-muted text-muted-foreground",
	}
	return badge(h, { variant: "secondary", className: config.className }, [config.label])
}

/** The sparkline query's metric types, in read order. */
export const SPARKLINE_METRIC_TYPES = ["sum", "gauge", "histogram", "exponential_histogram"] as const
export type SparklineMetricType = (typeof SPARKLINE_METRIC_TYPES)[number]
