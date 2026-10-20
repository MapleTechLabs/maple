import { type ChartWindow, chartWindow, parseClickHouseDateTime, type TimeBounds } from "../../lib/time"
import { isCounter } from "../../lib/units"
import type { MetricEntry } from "./catalog"
import type { SparklineGroup, SparklinePoint } from "./fetch"

// Pure parts of the Metrics page.

/** `sparklineWindow`: the range clipped to when the oldest listed metric started. */
export const sparklineWindow = (entries: ReadonlyArray<MetricEntry>, bounds: TimeBounds, nowMs: number): ChartWindow => {
	const firstSeen = entries.reduce<number | null>((earliest, entry) => {
		const ms = parseClickHouseDateTime(entry.firstSeen)
		return ms !== null && (earliest === null || ms < earliest) ? ms : earliest
	}, null)
	return chartWindow(bounds, firstSeen, nowMs)
}

/** The sparkline groups: metric names by type, types sorted. */
export const sparklineGroups = (entries: ReadonlyArray<MetricEntry>): ReadonlyArray<SparklineGroup> => {
	const byType = new Map<string, Array<string>>()
	entries.forEach((entry) => {
		const names = byType.get(entry.metricType)
		if (names) names.push(entry.metricName)
		else byType.set(entry.metricType, [entry.metricName])
	})
	return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/**
 * `previewValues`: counters preview their rise per bucket (clamped at resets), the rate's shape;
 * everything else its average.
 */
export const previewValues = (
	entry: Pick<MetricEntry, "metricType" | "isMonotonic">,
	points: ReadonlyArray<SparklinePoint>,
): ReadonlyArray<number> => {
	if (!isCounter(entry)) return points.map((point) => point.avgValue)
	return points.slice(1).map((point, index) => Math.max(0, point.avgValue - (points[index]?.avgValue ?? 0)))
}

/** `StatSparkline`'s values: non-finite readings draw as 0. */
export const sparklineValues = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
	values.map((value) => (Number.isFinite(value) ? value : 0))

/** `columnsFor`: the grid's columns for the scroll container's measured width. */
export const columnsFor = (width: number): number => {
	if (width >= 1000) return 3
	if (width >= 560) return 2
	return 1
}

/** Card height plus the grid gap, the virtualizer's row estimate. */
export const CARD_ROW_HEIGHT = 124 + 12
