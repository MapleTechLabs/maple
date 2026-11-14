import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "./display"

// A metric type's label, badge and colour, wherever a metric is listed.

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

/** The type as a tinted badge. */
export const metricTypeBadge = <M>(h: HtmlBuilder<M>, type: string): Html => {
	const config = METRIC_TYPE_CONFIG.get(type) ?? {
		label: type,
		className: "bg-muted text-muted-foreground",
	}
	return badge(h, { variant: "secondary", className: config.className }, [config.label])
}
