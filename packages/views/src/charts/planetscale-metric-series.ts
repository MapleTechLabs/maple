import { formatDuration, formatNumber, formatPercent } from "@maple/ui/lib/format"
import type { ChartSpec } from "./chart-spec"

// The labels and value formats of the PlanetScale chart, shared by its definition and its card.

export type PlanetScaleMetric = Extract<ChartSpec, { readonly _tag: "PlanetScaleMetric" }>["metric"]

export const METRIC_LABELS = {
	connectionsAvg: "Active connections",
	cpuMaxPercent: "CPU utilization (max)",
	memMaxPercent: "Memory utilization (max)",
	storageUsedPercent: "Storage used (max)",
	replicaLagMaxSeconds: "Replica lag (max)",
} as const satisfies Record<PlanetScaleMetric, string>

/** Replica lag reads in seconds once it is a real problem, milliseconds while it isn't. */
export const formatLag = (seconds: number): string => formatDuration(seconds * 1000)

/** Storage used as a whole percentage: the number people quote about a full disk. */
export const formatStoragePercent = (percent: number) =>
	`${percent >= 99.5 || percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`

export const formatMetricValue = (value: number, metric: PlanetScaleMetric): string => {
	if (metric === "cpuMaxPercent" || metric === "memMaxPercent") return formatPercent(value / 100)
	if (metric === "storageUsedPercent") return formatStoragePercent(value)
	if (metric === "replicaLagMaxSeconds") return formatLag(value)
	return formatNumber(value)
}
